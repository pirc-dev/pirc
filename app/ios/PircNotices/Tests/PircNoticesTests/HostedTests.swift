// The hosted wake (HostedFetch): the read seed's keys as the app makes
// them (app/test/hosted_engine_test.dart pins the same), the account as the
// app keeps it, and, when app/test/hosted_notices_test.dart gives one, a
// wake against a live Go relay with a TypeScript computer.

import Foundation
import Testing
@testable import PircNotices

private func hex(_ b: [UInt8]) -> String { b.map { String(format: "%02x", $0) }.joined() }

@Test func readKeysOfAKnownSeed() throws {
    let keys = try #require(ReadKeys(seed: Data((0..<32).map { UInt8($0) })))
    #expect(hex(keys.readOnlyPublic) == "e986a0fefa70e95c2042e492c8799259d049a07248a5acd0a47c3c43592c006c")
    // The notification key's public half, from its secret.
    let sub = try #require(Sodium.deriveKey(master: Data((0..<32).map { UInt8($0) }), context: "pircread", id: 2))
    let pub = try #require(Sodium.boxKeyPair(seed: sub))
    #expect(hex(pub.publicKey) == "a6269f02a7c7369d188fb42c89664070d78a99a1173166c0093c82762ee52222")
    #expect(Data(pub.secretKey) == keys.notificationSecret)
    #expect(ReadKeys(seed: Data(count: 31)) == nil)
}

@Test func anAccountThatDoesNotReadIsSaidSo() {
    #expect(throws: HostedError.self) { try HostedAccount(json: "{") }
    #expect(throws: HostedError.self) { try HostedAccount(json: #"{"origin":"wss://x"}"#) }
}

/// Set by app/test/hosted_notices_test.dart: a file holding the account's
/// JSON, the read seed and the notice the computer gave.
@Test(.enabled(if: ProcessInfo.processInfo.environment["PIRC_HOSTED_WAKE"] != nil))
func aWakeAgainstTheRelay() async throws {
    let path = try #require(ProcessInfo.processInfo.environment["PIRC_HOSTED_WAKE"])
    let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path)))
    let f = try #require(raw as? [String: Any])
    let json = try #require(f["account"] as? String)
    let account = try HostedAccount(json: json)
    let seedText = try #require(f["seed"] as? String)
    let seed = try #require(Data(base64URL: seedText))
    let since = try #require(f["since"] as? NSNumber).uint64Value
    let expected = try #require(f["expect"] as? String)
    let now = UInt64(Date().timeIntervalSince1970 * 1000)
    let wake = try await HostedFetch.run(account: account, readSeed: seed, highest: [:], since: since, now: now, deadline: 20)
    #expect(wake.notes.map { "\($0.title): \($0.body)" } == [expected])
    #expect(!wake.removed)
    // Shown: not again.
    let again = try await HostedFetch.run(account: account, readSeed: seed, highest: wake.highest, since: since, now: now, deadline: 20)
    #expect(again.notes.isEmpty)
    // A wrong seed is not this phone's.
    await #expect(throws: HostedError.notThisPhone) {
        try await HostedFetch.run(account: account, readSeed: Data(count: 32), highest: [:], since: since, now: now, deadline: 20)
    }
}

@Test func highestValuesAreOnlyRaised() {
    let kept = HostedFetch.raise(#"{"a/1":"5","b/2":"9"}"#, ["a/1": 7, "b/2": 3, "c/3": 1])
    #expect(HostedFetch.highest(kept) == ["a/1": 7, "b/2": 9, "c/3": 1])
    #expect(HostedFetch.highest("nonsense").isEmpty)
}

@Test func onlyANewerListIsKept() throws {
    func b64(_ d: Data) -> String { d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    let phone = signingPair(80)
    let me = Pirc_V1alpha2_Device.with {
        $0.role = roleClient
        $0.signingKey = Data(phone.public)
        $0.channelKey = key(81)
        $0.boxKey = key(82)
        $0.readOnlyKey = key(83)
        $0.notificationKey = key(84)
    }
    let v1Body = [UInt8](try Pirc_V1alpha2_ListBody.with { $0.counter = 1; $0.devices = [me] }.serializedData())
    let accountId = Sodium.sha256(v1Body)
    func version(_ n: UInt64) throws -> Data {
        let body = try Pirc_V1alpha2_ListBody.with {
            $0.accountID = Data(accountId)
            $0.counter = n
            $0.previousHash = Data(Sodium.sha256(v1Body))
            $0.devices = [me]
        }.serializedData()
        return signed([UInt8](body), id: accountId, secret: phone.secret)
    }
    let first = signed(v1Body, id: [], secret: phone.secret)
    let json = #"{"origin":"wss://relay.test","accountId":""# + b64(Data(accountId)) + #"","phoneKey":""# + b64(Data(phone.public)) + #"","self":""# + b64(try me.serializedData()) + #"","first":""# + b64(first) + #"","newest":""# + b64(try version(3)) + #""}"#
    _ = try HostedAccount(json: json)
    #expect(HostedFetch.keepNewer(json: json, list: try version(2)) == nil)
    #expect(HostedFetch.keepNewer(json: json, list: try version(3)) == nil)
    #expect(HostedFetch.keepNewer(json: json, list: Data([1, 2, 3])) == nil)
    let kept = try #require(HostedFetch.keepNewer(json: json, list: try version(4)))
    #expect(try HostedAccount(json: kept).newest == (try version(4)))
}

/// The two notices app/test/hosted_notices_test.dart captured from the
/// relay, run through the opening in the orders a relay could give them.
@Test(.enabled(if: ProcessInfo.processInfo.environment["PIRC_HOSTED_WAKE"] != nil))
func replayedNoticesShowOnce() throws {
    let path = try #require(ProcessInfo.processInfo.environment["PIRC_HOSTED_WAKE"])
    let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path)))
    let f = try #require(raw as? [String: Any])
    let captured = try #require(f["captured"] as? [String: [String: String]])
    let json = try #require(f["account"] as? String)
    let account = try HostedAccount(json: json)
    let seedText = try #require(f["seed"] as? String)
    let seed = try #require(Data(base64URL: seedText))
    let keys = try #require(ReadKeys(seed: seed))
    guard case .accepted(let list, _, _) = try checkList(bytes: account.newest, phoneKey: account.phoneKey, mode: .later, accountId: account.accountId, highest: 1) else {
        Issue.record("the account's newest does not check out")
        return
    }
    func stored(_ name: String) throws -> Pirc_V1alpha2_StoredNotice {
        let c = try #require(captured[name])
        return try Pirc_V1alpha2_StoredNotice.with {
            $0.session = Pirc_V1alpha1_SessionRef.with {
                $0.hostKey = Data(base64URL: c["hostKey"]!)!
                $0.sessionID = c["sessionId"]!
                $0.instanceID = c["instanceId"]!
            }
            $0.sealed = try #require(Data(base64URL: c["sealed"]!))
        }
    }
    let one = try stored("one"), two = try stored("two")
    let key = one.session.hostKey.map { String(format: "%02x", $0) }.joined() + "/" + one.session.sessionID
    let now = UInt64(Date().timeIntervalSince1970 * 1000)
    func run(_ s: [Pirc_V1alpha2_StoredNotice], _ highest: [String: UInt64]) throws -> ([Note], [String: UInt64]) {
        try HostedFetch.openNotices(account: account, list: list, notificationSecret: keys.notificationSecret, stored: s, highest: highest, since: 0, now: now)
    }
    let low = [key: UInt64(1)]
    #expect(try run([two, one], low).0.map(\.body) == ["Two"])
    #expect(try run([one, one, one], low).0.map(\.body) == ["One"])
    let inOrder = try run([one, two], low)
    #expect(inOrder.0.map(\.body) == ["One", "Two"])
    #expect(try run([two], inOrder.1).0.isEmpty)
    #expect(try run([one], inOrder.1).0.isEmpty)
}
