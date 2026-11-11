// Against the Go relay, built from the tree and started by the test: a
// host announces a session with a notice, a client registers a read-only
// key, and the extension reads the list with it.

import CryptoKit
import Foundation
import Network
import Testing

@testable import PircNotices

/// A relay of its own, on a free port, with an empty registry.
final class Relay {
    let dir: URL
    let bin: URL
    let url: URL
    let proc = Process()

    init() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("pirc-notices-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        bin = dir.appendingPathComponent("pirc-relay")
        try run("/usr/bin/env", ["go", "build", "-o", bin.path, "./cmd/pirc-relay"], in: repo.appendingPathComponent("relay"))
        let port = try freePort()
        url = URL(string: "ws://127.0.0.1:\(port)")!
        proc.executableURL = bin
        proc.arguments = ["serve", "--plaintext", "--listen", "127.0.0.1:\(port)", "--data-dir", dir.appendingPathComponent("data").path]
        proc.standardError = FileHandle.nullDevice
        try proc.run()
        // Up once it answers its health check.
        for _ in 0..<100 {
            if (try? Data(contentsOf: URL(string: "http://127.0.0.1:\(port)/healthz")!)) != nil { return }
            Thread.sleep(forTimeInterval: 0.05)
        }
        throw FetchError.unexpected("the relay did not start")
    }

    deinit {
        proc.terminate()
        proc.waitUntilExit()
        try? FileManager.default.removeItem(at: dir)
    }

    func token(_ role: String, _ label: String) throws -> String {
        try run(bin.path, ["add-\(role)", "--data-dir", dir.appendingPathComponent("data").path, "--label", label]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

@discardableResult
func run(_ exe: String, _ args: [String], in cwd: URL? = nil) throws -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    if let cwd { p.currentDirectoryURL = cwd }
    let out = Pipe()
    p.standardOutput = out
    try p.run()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw FetchError.unexpected("\(exe) \(args) failed") }
    return String(decoding: data, as: UTF8.self)
}

func freePort() throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
    _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
    return Int(UInt16(bigEndian: addr.sin_port))
}

/// A peer logged in with its own key, as a host or a client's main key.
struct Peer {
    let link: Link
    let key: Curve25519.Signing.PrivateKey

    static func login(_ relay: Relay, role: Pirc_V1alpha1_Role, token: String, key: Curve25519.Signing.PrivateKey = .init()) async throws -> Peer {
        let ws = URLSession.shared.webSocketTask(with: try relayURL(relay.url))
        ws.resume()
        let link = Link(ws: ws)
        try await link.send(.hello(Pirc_V1alpha1_Hello.with {
            $0.protocolVersion = .v1Alpha1
            $0.role = role
            $0.publicKey = key.publicKey.rawRepresentation
            $0.registrationToken = token
        }))
        let c = try await link.expect("Challenge") { if case .challenge(let c) = $0 { return c } else { return nil } }
        try await link.send(.auth(Pirc_V1alpha1_Auth.with { $0.signature = try! key.signature(for: authContext + c.nonce) }))
        _ = try await link.expect("Welcome") { if case .welcome(let w) = $0 { return w } else { return nil } }
        return Peer(link: link, key: key)
    }
}

struct RelayTests {
    @Test func readsTheListWithTheReadOnlyKey() async throws {
        let relay = try Relay()
        let host = try await Peer.login(relay, role: .host, token: relay.token("host", "desk"))
        var ref = Pirc_V1alpha1_SessionRef()
        ref.hostKey = host.key.publicKey.rawRepresentation
        ref.sessionID = "s1"
        ref.instanceID = "i1"
        let announcement = Pirc_V1alpha1_SessionAnnouncement.with {
            $0.name = "release"
            $0.cwd = "/src/app"
            $0.hostname = "desk.local"
            $0.notice = .with { $0.number = 2_000; $0.kind = .question; $0.text = "Deploy? to prod" }
        }
        try await host.link.send(.sessionAnnounce(.with { $0.session = ref; $0.payload = try! announcement.serializedData(); $0.push = true }))

        let phone = try await Peer.login(relay, role: .client, token: relay.token("client", "phone"))
        let read = Curve25519.Signing.PrivateKey()
        try await phone.link.send(.registerReadKey(.with { $0.requestID = "k1"; $0.publicKey = read.publicKey.rawRepresentation }))
        var answer = try await phone.link.receive()
        while case .keys = answer.body { answer = try await phone.link.receive() }
        guard case .keyChanged = answer.body else { Issue.record("answer \(answer)"); return }

        let id = Session.id(hostKey: ref.hostKey, instanceID: "i1")
        let rssBefore = peakRSS()
        let (notes, shown) = try await Fetch.run(relay: relay.url, seed: read.rawRepresentation, shown: Shown(since: 1_000), now: 5_000, deadline: 10)
        print("peak RSS: \(peakRSS() / 1024) KiB after Fetch.run, \(rssBefore / 1024) KiB before (the whole test process)")
        #expect(notes == [Note(session: id, title: "release · desk", body: "Asks: Deploy? to prod")])
        #expect(shown == Shown(numbers: [id: 2_000], since: 5_000))

        // Shown once, not again.
        let (again, _) = try await Fetch.run(relay: relay.url, seed: read.rawRepresentation, shown: shown, now: 6_000, deadline: 10)
        #expect(again.isEmpty)

        // The client's own key logs in, but is not read-only; a key the
        // relay does not know is refused.
        await #expect(throws: FetchError.notReadOnly) {
            try await Fetch.run(relay: relay.url, seed: phone.key.rawRepresentation, shown: Shown(), now: 0, deadline: 10)
        }
        await #expect(throws: FetchError.self) {
            try await Fetch.run(relay: relay.url, seed: Curve25519.Signing.PrivateKey().rawRepresentation, shown: Shown(), now: 0, deadline: 10)
        }
    }

    /// A relay that accepts the connection and never answers: given up on
    /// at the deadline.
    @Test func timesOut() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        var held: [NWConnection] = []
        listener.newConnectionHandler = { c in
            held.append(c)
            c.start(queue: .global())
        }
        let ready = AsyncStream<UInt16> { cont in
            listener.stateUpdateHandler = { if case .ready = $0 { cont.yield(listener.port!.rawValue) } }
        }
        listener.start(queue: .global())
        var it = ready.makeAsyncIterator()
        let port = await it.next()!
        defer { listener.cancel() }

        let start = Date()
        await #expect(throws: FetchError.timedOut) {
            try await Fetch.run(relay: URL(string: "ws://127.0.0.1:\(port)")!, seed: Curve25519.Signing.PrivateKey().rawRepresentation, shown: Shown(), now: 0, deadline: 1)
        }
        #expect(Date().timeIntervalSince(start) < 3)
        _ = held
    }
}

/// The process's peak resident memory, in bytes.
func peakRSS() -> Int {
    var u = rusage()
    getrusage(RUSAGE_SELF, &u)
    return Int(u.ru_maxrss)
}
