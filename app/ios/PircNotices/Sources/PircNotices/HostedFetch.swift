// A woken phone's notices on a hosted account (docs/e2e.md, section 5), as
// the app's lib/hosted/notices.dart reads them on Android: logged in with
// the read-only key, the newest list taken if it is newer and checks out,
// the notices sealed to this phone fetched and opened with its
// notification key, each checked: from a computer on the newest list, for
// its slot, its ordering above the highest seen for its session and no more
// than a day ahead. Both keys come from the read seed the app keeps, by
// libsodium's crypto_kdf, as the app's lib/hosted/keys.dart makes them.
//
// Pure, as the rest of the package: the extension reads the account, the
// seed and the highest values, and writes back what this returns, only
// ever a newer list or higher values.

import Foundation
import SwiftProtobuf

public enum HostedError: Error, Equatable {
    /// What the app keeps does not read as an account.
    case unreadable(String)
    /// The read seed does not give this phone's read-only key.
    case notThisPhone
}

/// The account as the app keeps it ("hosted.v1"), as signed bytes.
public struct HostedAccount: Equatable, Sendable {
    public var origin: String
    public var accountId: Data
    public var phoneKey: Data
    public var me: DeviceKeys
    public var first: Data
    public var newest: Data

    /// Read from the app's JSON; the lists are checked by run.
    public init(json: String) throws {
        guard let f = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { throw HostedError.unreadable("not JSON") }
        func bytes(_ k: String) throws -> Data {
            guard let s = f[k] as? String, let d = Data(base64URL: s) else { throw HostedError.unreadable("\(k) is missing") }
            return d
        }
        guard let origin = f["origin"] as? String, !origin.isEmpty else { throw HostedError.unreadable("origin is missing") }
        self.origin = origin
        accountId = try bytes("accountId")
        phoneKey = try bytes("phoneKey")
        guard let d = try? Pirc_V1alpha2_Device(serializedBytes: try bytes("self")) else { throw HostedError.unreadable("self does not parse") }
        me = DeviceKeys(role: d.role, signingKey: d.signingKey, channelKey: d.channelKey, boxKey: d.boxKey, readOnlyKey: d.readOnlyKey, notificationKey: d.notificationKey)
        first = try bytes("first")
        newest = try bytes("newest")
    }
}

/// What a hosted wake comes to.
public struct HostedWake: Equatable, Sendable {
    public var notes: [Note]
    /// The highest ordering seen, by "<computer key hex>/<session ID>".
    public var highest: [String: UInt64]
    /// A newer version of the list, as signed, for the extension to keep.
    public var newer: Data?
    /// The newest list no longer has this phone.
    public var removed: Bool
}

extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }
}

private let readContext = "pircread"
private let authContext2 = "pirc-auth-v1alpha2"

/// The read seed's two keys: the read-only signing key, and the
/// notification key's secret half.
struct ReadKeys {
    let readOnlyPublic: [UInt8]
    let readOnlySecret: [UInt8]
    let notificationSecret: Data

    init?(seed: Data) {
        guard let s1 = Sodium.deriveKey(master: seed, context: readContext, id: 1),
              let s2 = Sodium.deriveKey(master: seed, context: readContext, id: 2),
              let ro = Sodium.signKeyPair(seed: s1),
              let n = Sodium.boxKeyPair(seed: s2)
        else { return nil }
        readOnlyPublic = ro.publicKey
        readOnlySecret = ro.secretKey
        notificationSecret = Data(n.secretKey)
    }
}

private func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

public enum HostedFetch {
    /// One wake: logs in at the account's origin with the read-only key
    /// from `readSeed`, and gives the notes for the notices newer than
    /// `highest`; a session first seen shows only a notice made after
    /// `since` (the last wake), so that an install does not show old ones.
    public static func run(account: HostedAccount, readSeed: Data, highest: [String: UInt64], since: UInt64?, now: UInt64, deadline: TimeInterval) async throws -> HostedWake {
        // The account's own versions, checked as every device checks them.
        guard case .accepted = try checkList(bytes: account.first, phoneKey: account.phoneKey, mode: .first, accountId: account.accountId, highest: 0) else {
            throw HostedError.unreadable("version 1 does not check out")
        }
        var list: DeviceList
        var counter: UInt64
        if account.newest == account.first {
            guard case .accepted(let l, let c, _) = try checkList(bytes: account.first, phoneKey: account.phoneKey, mode: .first, accountId: account.accountId, highest: 0) else {
                throw HostedError.unreadable("version 1 does not check out")
            }
            (list, counter) = (l, c)
        } else {
            guard case .accepted(let l, let c, _) = try checkList(bytes: account.newest, phoneKey: account.phoneKey, mode: .later, accountId: account.accountId, highest: 1) else {
                throw HostedError.unreadable("the newest version does not check out")
            }
            (list, counter) = (l, c)
        }
        guard let keys = ReadKeys(seed: readSeed), Data(keys.readOnlyPublic) == account.me.readOnlyKey else { throw HostedError.notThisPhone }
        guard let origin = URL(string: account.origin), var c = URLComponents(url: origin, resolvingAgainstBaseURL: false), c.scheme == "ws" || c.scheme == "wss" else {
            throw FetchError.badURL
        }
        c.path = "/v1alpha2"
        guard let url = c.url else { throw FetchError.badURL }

        // A version offered: kept if newer and it checks out.
        var newer: Data?
        func take(_ bytes: Data) throws {
            if case .accepted(let l, let c, _) = try checkList(bytes: bytes, phoneKey: account.phoneKey, mode: .later, accountId: account.accountId, highest: counter) {
                (list, counter, newer) = (l, c, bytes)
            }
        }
        func listed() -> Bool { list.devices.contains { $0.same(account.me) } }

        let stored: [Pirc_V1alpha2_StoredNotice]
        do {
            let held = counter
            let fetched = try await Fetch.within(deadline) {
                try await login(url: url, account: account, keys: keys, counter: held)
            }
            if let w = fetched.list { try take(w) }
            stored = fetched.notices
        } catch let LoginRefusal.refused(message, given) {
            // Taken off the account: the relay gives the newest list first.
            if let given { try take(given) }
            if !listed() { return HostedWake(notes: [], highest: [:], newer: newer, removed: true) }
            throw FetchError.refused(message)
        }
        if !listed() { return HostedWake(notes: [], highest: [:], newer: newer, removed: true) }
        var notes: [Note] = []
        var seen: [String: UInt64] = [:]
        for n in stored where n.hasSession {
            let ref = n.session
            let sessionId = Data(ref.sessionID.utf8)
            let key = hex(ref.hostKey) + "/" + ref.sessionID
            let had = highest[key] ?? seen[key]
            guard case .accepted(let ordering, let body) = try openNotice(
                sealed: n.sealed,
                slot: Slot(accountId: account.accountId, computerKey: ref.hostKey, sessionId: sessionId),
                recipientSecretKey: keys.notificationSecret,
                list: list,
                highest: had,
                now: now
            ) else { continue }
            seen[key] = ordering
            if had == nil, since.map({ ordering <= $0 }) ?? true { continue }
            let title = [body.sessionName, body.computerName].filter { !$0.isEmpty }.joined(separator: " · ")
            notes.append(Note(session: Session.id(hostKey: ref.hostKey, instanceID: ref.instanceID), title: cut(title.isEmpty ? "PiRC" : title, 80), body: body.notice.isEmpty ? "Finished" : body.notice))
        }
        return HostedWake(notes: notes, highest: seen, newer: newer, removed: !listed())
    }

    /// The highest values as the app and the extension keep them
    /// ("hosted.notices.v1": numbers as text).
    public static func highest(_ json: String?) -> [String: UInt64] {
        guard let json, let f = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: String] else { return [:] }
        return f.compactMapValues { UInt64($0) }
    }

    /// The kept values with these raised into them; none lowered.
    public static func raise(_ json: String?, _ seen: [String: UInt64]) -> String {
        var kept = highest(json)
        for (k, v) in seen where v > (kept[k] ?? 0) { kept[k] = v }
        let out = kept.mapValues { String($0) }
        guard let d = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]) else { return json ?? "{}" }
        return String(decoding: d, as: UTF8.self)
    }

    /// The account's JSON with `list` as its newest, only if it is newer
    /// than the one kept there and checks out; nil otherwise.
    public static func keepNewer(json: String, list: Data) -> String? {
        guard let account = try? HostedAccount(json: json),
              var f = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]
        else { return nil }
        let held: UInt64
        if account.newest == account.first {
            held = 1
        } else if case .accepted(_, let c, _)? = try? checkList(bytes: account.newest, phoneKey: account.phoneKey, mode: .later, accountId: account.accountId, highest: 1) {
            held = c
        } else {
            return nil
        }
        guard case .accepted? = try? checkList(bytes: list, phoneKey: account.phoneKey, mode: .later, accountId: account.accountId, highest: held) else { return nil }
        f["newest"] = list.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        guard let d = try? JSONSerialization.data(withJSONObject: f) else { return nil }
        return String(decoding: d, as: UTF8.self)
    }

    enum LoginRefusal: Error {
        /// The relay's Error, and the list it gave before it, if any.
        case refused(String, Data?)
    }

    /// Logs in and fetches the notices; with Welcome's newer list, if any.
    static func login(url: URL, account: HostedAccount, keys: ReadKeys, counter: UInt64) async throws -> (list: Data?, notices: [Pirc_V1alpha2_StoredNotice]) {
        let config = URLSessionConfiguration.ephemeral
        let urlSession = URLSession(configuration: config)
        defer { urlSession.invalidateAndCancel() }
        let ws = urlSession.webSocketTask(with: url)
        ws.resume()
        defer { ws.cancel(with: .normalClosure, reason: nil) }
        func send(_ body: Pirc_V1alpha2_Frame.OneOf_Body) async throws {
            var f = Pirc_V1alpha2_Frame()
            f.body = body
            try await ws.send(.data(f.serializedData()))
        }
        func receive() async throws -> Pirc_V1alpha2_Frame {
            let m: URLSessionWebSocketTask.Message
            do {
                m = try await ws.receive()
            } catch {
                if Task.isCancelled { throw FetchError.timedOut }
                throw FetchError.closed
            }
            guard case .data(let d) = m else { throw FetchError.unexpected("a text message") }
            return try Pirc_V1alpha2_Frame(serializedBytes: d)
        }
        try await send(.hello(Pirc_V1alpha2_Hello.with {
            $0.protocolVersion = .v1Alpha2
            $0.publicKey = Data(keys.readOnlyPublic)
            $0.accountID = account.accountId
            $0.listCounter = counter
        }))
        var given: Data?
        var welcome: Pirc_V1alpha2_Welcome?
        while welcome == nil {
            let f = try await receive()
            switch f.body {
            case .challenge(let ch):
                let signed = try framed(authContext2, [[UInt8](account.accountId), Array(account.origin.utf8), [UInt8](ch.nonce)])
                try await send(.auth(Pirc_V1alpha2_Auth.with { $0.signature = Data(Sodium.sign(signed, secretKey: keys.readOnlySecret)) }))
            case .list(let l):
                given = l.list
            case .welcome(let w):
                welcome = w
            case .error(let e):
                throw LoginRefusal.refused("\(e.code): \(e.message)", given)
            default:
                throw FetchError.unexpected("during the login")
            }
        }
        let newer = welcome!.list.isEmpty ? nil : welcome!.list
        return (newer, try await fetch(send: send, receive: receive))
    }

    static func fetch(send: (Pirc_V1alpha2_Frame.OneOf_Body) async throws -> Void, receive: () async throws -> Pirc_V1alpha2_Frame) async throws -> [Pirc_V1alpha2_StoredNotice] {
        try await send(.fetchNotices(Pirc_V1alpha2_FetchNotices.with { $0.requestID = "n" }))
        var out: [Pirc_V1alpha2_StoredNotice] = []
        while true {
            let f = try await receive()
            if case .error(let e) = f.body { throw FetchError.refused("\(e.code): \(e.message)") }
            guard case .notices(let n) = f.body, n.requestID == "n" else { continue }
            out += n.notices
            if !n.more { return out }
        }
    }
}
