// Reading the session list as a woken phone does: logged in with its
// read-only key, which the relay lets do nothing else (docs/design.md,
// section 7).

import CryptoKit
import Foundation
import SwiftProtobuf

public enum FetchError: Error, Equatable {
    /// The relay refused the login, or sent an error: its code and message.
    case refused(String)
    /// Logged in with a key that is not a read-only key.
    case notReadOnly
    /// The relay sent something other than what the login expects.
    case unexpected(String)
    /// The deadline passed.
    case timedOut
    /// The connection ended.
    case closed
    /// Not a ws:// or wss:// URL.
    case badURL
}

/// The path a bare relay URL gets, as relay-client's relayURL.
func relayURL(_ url: URL) throws -> URL {
    guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.scheme == "ws" || c.scheme == "wss", c.host != nil else {
        throw FetchError.badURL
    }
    if c.path.isEmpty || c.path == "/" { c.path = "/v1alpha1" }
    guard let out = c.url else { throw FetchError.badURL }
    return out
}

/// The signed bytes are this, then the challenge's nonce (the relay's
/// AuthContext).
let authContext = Data("pirc-auth-v1alpha1\u{0}".utf8)

/// What the package calls itself to the relay.
public let software = "pirc-notices/0.1"

public enum Fetch {
    /// Logs in to the relay at `relay` with the read-only key whose
    /// Ed25519 seed is `seed`, reads the session list once and closes; the
    /// notes for the sessions with news since `shown`, and what is shown
    /// once they are, read at `now` (milliseconds, the host's clock).
    public static func run(relay: URL, seed: Data, shown: Shown, now: UInt64, deadline: TimeInterval) async throws -> (notes: [Note], shown: Shown) {
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
        let relay = try relayURL(relay)
        let sessions = try await within(deadline) { try await sessionList(relay: relay, key: key, deadline: deadline) }
        let (notify, numbers) = news(shown.numbers, sessions, since: shown.since)
        let notes = notify.compactMap { s in notification(s).map { Note(session: s.id, title: $0.title, body: $0.body) } }
        return (notes, Shown(numbers: numbers, since: now))
    }

    /// The live sessions, read with the key.
    static func sessionList(relay: URL, key: Curve25519.Signing.PrivateKey, deadline: TimeInterval) async throws -> [Session] {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = deadline
        config.timeoutIntervalForResource = deadline
        let urlSession = URLSession(configuration: config)
        defer { urlSession.invalidateAndCancel() }
        let ws = urlSession.webSocketTask(with: relay)
        ws.resume()
        defer { ws.cancel(with: .normalClosure, reason: nil) }
        let link = Link(ws: ws)

        try await link.send(.hello(Pirc_V1alpha1_Hello.with {
            $0.protocolVersion = .v1Alpha1
            $0.role = .client
            $0.publicKey = key.publicKey.rawRepresentation
            $0.software = software
        }))
        let challenge = try await link.expect("Challenge") { if case .challenge(let c) = $0 { return c } else { return nil } }
        let signature = try key.signature(for: authContext + challenge.nonce)
        try await link.send(.auth(Pirc_V1alpha1_Auth.with { $0.signature = signature }))
        let welcome = try await link.expect("Welcome") { if case .welcome(let w) = $0 { return w } else { return nil } }
        guard welcome.readOnly else { throw FetchError.notReadOnly }

        try await link.send(.subscribeSessions(Pirc_V1alpha1_SubscribeSessions()))
        var sessions: [Session] = []
        while true {
            let list = try await link.expect("SessionList") { if case .sessionList(let l) = $0 { return l } else { return nil } }
            sessions += list.sessions.compactMap(Session.init(entry:))
            if !list.more { return sessions }
        }
    }

    /// Runs body, or throws timedOut once seconds have passed.
    static func within<T: Sendable>(_ seconds: TimeInterval, _ body: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask(operation: body)
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw FetchError.timedOut
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw FetchError.timedOut }
            return first
        }
    }
}

/// Frames over the WebSocket.
struct Link {
    let ws: URLSessionWebSocketTask

    func send(_ body: Pirc_V1alpha1_Frame.OneOf_Body) async throws {
        var f = Pirc_V1alpha1_Frame()
        f.body = body
        try await ws.send(.data(f.serializedData()))
    }

    func receive() async throws -> Pirc_V1alpha1_Frame {
        let m: URLSessionWebSocketTask.Message
        do {
            m = try await ws.receive()
        } catch {
            if Task.isCancelled { throw FetchError.timedOut }
            throw FetchError.closed
        }
        guard case .data(let d) = m else { throw FetchError.unexpected("a text message") }
        return try Pirc_V1alpha1_Frame(serializedBytes: d)
    }

    /// The next frame, which must be what pick takes, or an Error.
    func expect<T>(_ what: String, _ pick: (Pirc_V1alpha1_Frame.OneOf_Body) -> T?) async throws -> T {
        let f = try await receive()
        if case .error(let e) = f.body { throw FetchError.refused("\(e.code): \(e.message)") }
        guard let body = f.body, let v = pick(body) else { throw FetchError.unexpected("expected \(what)") }
        return v
    }
}

extension Session {
    /// The session as web/core's view has it, from a session list's entry;
    /// none for one whose announcement cannot be read.
    init?(entry e: Pirc_V1alpha1_SessionEntry) {
        guard let a = try? Pirc_V1alpha1_SessionAnnouncement(serializedBytes: e.payload) else { return nil }
        self.init(
            id: Session.id(hostKey: e.session.hostKey, instanceID: e.session.instanceID),
            name: a.name,
            first: a.firstPrompt.isEmpty ? nil : a.firstPrompt,
            cwd: a.cwd,
            hostLabel: e.hostLabel,
            hostname: a.hostname,
            notice: Notice(a.notice, present: a.hasNotice)
        )
    }

    /// web/core's viewId: the host key's first 8 bytes in hex, and the
    /// instance ID.
    static func id(hostKey: Data, instanceID: String) -> String {
        hostKey.prefix(8).map { String(format: "%02x", $0) }.joined() + "-" + instanceID
    }
}

extension Notice {
    /// None before the first, and for a kind this package does not know.
    init?(_ n: Pirc_V1alpha1_Notice, present: Bool) {
        let kinds: [Pirc_V1alpha1_NoticeKind: String] = [.finished: "finished", .failed: "failed", .question: "question"]
        guard present, let kind = kinds[n.kind] else { return nil }
        self.init(number: n.number, kind: kind, text: n.text)
    }
}
