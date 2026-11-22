// The list check and the notice opener beyond the shared cases: what exact
// bytes do not show. Strict UTF-8 as TypeScript's TextDecoder reads it, the
// caller's mistakes, the 2^63 boundaries with large times, keys of the wrong
// length reaching no C call, Data slices, and no throw on any input,
// through real signatures and boxes over random bytes.

import Foundation
import Testing
import _Clibsodium

@testable import PircNotices

/// A generator with a fixed seed, so a failure can be run again.
struct Seeded: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

func randomBytes(_ n: Int, _ g: inout Seeded) -> [UInt8] {
    (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) }
}

/// Bytes near UTF-8's boundaries, so random strings of them reach every rule.
let edgeBytes: [UInt8] = [0x00, 0x41, 0x7F, 0x80, 0x8F, 0x90, 0x9F, 0xA0, 0xBF, 0xC0, 0xC1, 0xC2, 0xDF, 0xE0, 0xE1, 0xEC, 0xED, 0xEE, 0xEF, 0xF0, 0xF1, 0xF3, 0xF4, 0xF5, 0xF8, 0xFE, 0xFF, 0xBB]

func edgyBytes(_ n: Int, _ g: inout Seeded) -> [UInt8] {
    (0..<n).map { _ in Bool.random(using: &g) ? edgeBytes.randomElement(using: &g)! : UInt8.random(in: 0...255, using: &g) }
}

func key(_ seed: UInt8) -> Data { Data((0..<32).map { UInt8(truncatingIfNeeded: Int(seed) &* 31 &+ $0) }) }

/// An Ed25519 key pair from a seed.
func signingPair(_ seed: UInt8) -> (public: [UInt8], secret: [UInt8]) {
    var pk = [UInt8](repeating: 0, count: 32), sk = [UInt8](repeating: 0, count: 64)
    let s = [UInt8](repeating: seed, count: 32)
    precondition(crypto_sign_seed_keypair(&pk, &sk, s) == 0)
    return (pk, sk)
}

/// An X25519 key pair from a seed.
func boxPair(_ seed: UInt8) -> (public: [UInt8], secret: [UInt8]) {
    var pk = [UInt8](repeating: 0, count: 32), sk = [UInt8](repeating: 0, count: 32)
    let s = [UInt8](repeating: seed, count: 32)
    precondition(crypto_box_seed_keypair(&pk, &sk, s) == 0)
    return (pk, sk)
}

/// A list's signed bytes: the signature over framed(list context, the ID, body), then the body.
func signed(_ body: [UInt8], id: [UInt8], secret: [UInt8]) -> Data {
    let message = try! framed(listContext, [id, body])
    var sig = [UInt8](repeating: 0, count: 64)
    precondition(crypto_sign_detached(&sig, nil, message, UInt64(message.count), secret) == 0)
    return Data(sig + body)
}

func sealBox(_ plaintext: [UInt8], nonce: [UInt8], to recipient: [UInt8], from sender: [UInt8]) -> Data {
    var out = [UInt8](repeating: 0, count: plaintext.count + Sodium.macBytes)
    precondition(crypto_box_easy(&out, plaintext, UInt64(plaintext.count), nonce, recipient, sender) == 0)
    return Data(nonce + out)
}

/// A slice of a larger Data, so that its indices do not start at 0.
func sliced(_ d: Data) -> Data {
    let padded = Data([0xAA, 0xBB, 0xCC]) + d + Data([0xDD])
    let s = padded[3..<(3 + d.count)]
    precondition(s.startIndex == 3 && s == d)
    return s
}

/// What it gives, or that it threw.
func outcome<T>(_ f: () throws -> T) -> String {
    do {
        return "\(try f())"
    } catch {
        return "threw \(error)"
    }
}

// MARK: - Text and bytes

struct E2eBytesTests {
    /// Every row as TypeScript's TextDecoder (fatal, BOM kept) reads it: the
    /// code points in hex, or nil for malformed.
    static let table: [(String, String?)] = [
        ("", ""), ("00", "0"), ("7f", "7f"), ("c280", "80"), ("dfbf", "7ff"), ("e0a080", "800"), ("efbfbf", "ffff"), ("f0908080", "10000"),
        ("f48fbfbf", "10ffff"), ("efbbbf41", "feff 41"), ("41efbbbf", "41 feff"), ("efbbbfefbbbf", "feff feff"), ("ed9fbf", "d7ff"), ("ee8080", "e000"),
        ("efbfbe", "fffe"), ("80", nil), ("bf", nil), ("c0", nil), ("c080", nil), ("c0af", nil), ("c1bf", nil), ("c2", nil), ("c27f", nil), ("c2c0", nil),
        ("e0", nil), ("e080", nil), ("e08080", nil), ("e09fbf", nil), ("e0a0", nil), ("eda080", nil), ("edbfbf", nil), ("edb080", nil), ("e1", nil),
        ("e180", nil), ("e1807f", nil), ("f0", nil), ("f080", nil), ("f08080", nil), ("f0808080", nil), ("f08fbfbf", nil), ("f4908080", nil),
        ("f4bfbfbf", nil), ("f5808080", nil), ("f7bfbfbf", nil), ("f8888080", nil), ("fe", nil), ("ff", nil), ("f1", nil), ("f180", nil), ("f18080", nil),
        ("f1808080", "40000"), ("f3bfbfbf", "fffff"), ("f4", nil), ("f48f", nil), ("f48fbf", nil), ("41c3", nil), ("41e282", nil), ("41f09f98", nil),
        ("eda080edb080", nil), ("c3a9", "e9"), ("e282ac", "20ac"), ("f09f9880", "1f600"),
    ]

    @Test func utf8AsTextDecoderReadsIt() throws {
        for (h, want) in Self.table {
            let got = utf8Text(try unhex(h)).map { $0.unicodeScalars.map { String($0.value, radix: 16) }.joined(separator: " ") }
            #expect(got == want, Comment(rawValue: h))
            #expect(isUTF8(try unhex(h)) == (want != nil), Comment(rawValue: h))
        }
    }

    /// Against the standard library's own validation, over random bytes
    /// near every boundary.
    @Test func utf8AsTheStandardLibraryValidatesIt() throws {
        guard #available(macOS 15, iOS 18, *) else { return }
        var g = Seeded(state: 1)
        var valid = 0
        for _ in 0..<100_000 {
            let b = edgyBytes(Int.random(in: 0...6, using: &g), &g)
            let oracle = String(validating: b, as: UTF8.self)
            #expect(utf8Text(b) == oracle, Comment(rawValue: hex(b)))
            if let oracle {
                valid += 1
                #expect(Array(oracle.utf8) == b, Comment(rawValue: hex(b)))
            }
        }
        #expect(valid > 1000)
    }

    @Test func sha256() {
        #expect(hex(Sodium.sha256([])) == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        #expect(hex(Sodium.sha256(Array("abc".utf8))) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(hex(Sodium.sha256(Array("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8)))
            == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    }

    @Test func bytesEqualCompares() {
        #expect(bytesEqual([], []))
        #expect(bytesEqual([1, 2], [1, 2]))
        #expect(!bytesEqual([1, 2], [1, 3]))
        #expect(!bytesEqual([1, 2], [3, 2]))
        #expect(!bytesEqual([1, 2], [1, 2, 0]))
        #expect(!bytesEqual([1, 2, 0], [1, 2]))
    }

    @Test func leb128PastEveryByte() {
        let cases: [(UInt64, String)] = [
            (0, "00"), (127, "7f"), (128, "8001"), (16383, "ff7f"), (16384, "808001"), (1 << 31, "8080808008"), (1 << 32 - 1, "ffffffff0f"),
            (1 << 32, "8080808010"), (UInt64.max, "ffffffffffffffffff01"),
        ]
        for (n, want) in cases { #expect(hex(leb128(n)) == want, Comment(rawValue: String(n))) }
    }

    @Test func framedContexts() throws {
        #expect(hex(try framed(" ~", [[1], []])) == "207e00010100")
        for bad in ["", "\u{1F}", "a\u{0}", "\u{7F}", "é", "a\u{80}", "\u{2028}"] {
            #expect(throws: E2eCallError.self, Comment(rawValue: bad)) { try framed(bad, []) }
        }
        #expect(hex(try framedNumber((1 << 63) - 1)) == "7fffffffffffffff")
        #expect(hex(try framedNumber(0x0102_0304_0506_0708)) == "0102030405060708")
        for bad: UInt64 in [1 << 63, UInt64.max] {
            #expect(throws: E2eCallError.self) { try framedNumber(bad) }
        }
    }

    @Test func sodiumRefusesWrongLengthsBeforeC() {
        let (pk, sk) = signingPair(1)
        var sig = [UInt8](repeating: 0, count: 64)
        _ = crypto_sign_detached(&sig, nil, [1, 2, 3], 3, sk)
        #expect(Sodium.verify(signature: sig, message: [1, 2, 3], key: pk))
        #expect(!Sodium.verify(signature: sig, message: [1, 2, 4], key: pk))
        for k in [[], Array(pk.prefix(31)), pk + [0]] { #expect(!Sodium.verify(signature: sig, message: [1, 2, 3], key: k)) }
        for s in [[], Array(sig.prefix(63)), sig + [0]] { #expect(!Sodium.verify(signature: s, message: [1, 2, 3], key: pk)) }

        let a = boxPair(2), b = boxPair(3)
        let nonce = [UInt8](repeating: 7, count: 24)
        let box = [UInt8](sealBox([9, 9], nonce: nonce, to: b.public, from: a.secret))
        #expect(Sodium.boxOpen(box[24...], nonce: box[..<24], publicKey: a.public, secretKey: Data(b.secret)) == [9, 9])
        #expect(Sodium.boxOpen(box[24...], nonce: box[..<24], publicKey: a.public, secretKey: sliced(Data(b.secret))) == [9, 9])
        #expect(Sodium.boxOpen(box[24...], nonce: box[..<23], publicKey: a.public, secretKey: Data(b.secret)) == nil)
        #expect(Sodium.boxOpen(box[24..<39], nonce: box[..<24], publicKey: a.public, secretKey: Data(b.secret)) == nil)
        for k in [[], Array(a.public.prefix(31)), a.public + [0]] {
            #expect(Sodium.boxOpen(box[24...], nonce: box[..<24], publicKey: k, secretKey: Data(b.secret)) == nil)
        }
        for k in [[], Array(b.secret.prefix(31)), b.secret + [0]] {
            #expect(Sodium.boxOpen(box[24...], nonce: box[..<24], publicKey: a.public, secretKey: Data(k)) == nil)
        }
        // An all-zero shared point: libsodium refuses it.
        #expect(Sodium.boxOpen(box[24...], nonce: box[..<24], publicKey: [UInt8](repeating: 0, count: 32), secretKey: Data(b.secret)) == nil)
    }
}

// MARK: - The list

struct E2eListTests {
    static let phone = signingPair(10)

    static func phoneDevice() -> Pirc_V1alpha2_Device {
        var d = Pirc_V1alpha2_Device()
        d.role = roleClient
        d.signingKey = Data(phone.public)
        d.channelKey = key(1)
        d.boxKey = key(2)
        d.readOnlyKey = key(3)
        d.notificationKey = key(4)
        return d
    }

    static func computer(_ s: UInt8) -> Pirc_V1alpha2_Device {
        var d = Pirc_V1alpha2_Device()
        d.role = roleComputer
        d.signingKey = key(s)
        d.channelKey = key(s + 1)
        d.boxKey = key(s + 2)
        return d
    }

    static let v1: [UInt8] = {
        var b = Pirc_V1alpha2_ListBody()
        b.counter = 1
        b.devices = [phoneDevice()]
        return [UInt8](try! b.serializedData())
    }()

    static var id: [UInt8] { Sodium.sha256(v1) }

    static func v2(counter: UInt64 = 2, devices: [Pirc_V1alpha2_Device] = [phoneDevice(), computer(20)]) -> [UInt8] {
        var b = Pirc_V1alpha2_ListBody()
        b.accountID = Data(id)
        b.counter = counter
        b.previousHash = Data(id)
        b.devices = devices
        return [UInt8](try! b.serializedData())
    }

    @Test func callersMistakesThrow() {
        let bytes = Data(count: 100), k = Data(count: 32)
        for id: Data? in [nil, Data(), Data(count: 31), Data(count: 33)] {
            #expect(throws: E2eCallError.self) { try checkList(bytes: bytes, phoneKey: k, mode: .later, accountId: id, highest: 0) }
        }
        for id in [Data(), Data(count: 31), Data(count: 33)] {
            #expect(throws: E2eCallError.self) { try checkList(bytes: bytes, phoneKey: k, mode: .first, accountId: id, highest: 0) }
        }
        let joining = DeviceKeys(role: 1, signingKey: k, channelKey: k, boxKey: k)
        #expect(throws: E2eCallError.self) { try checkList(bytes: bytes, phoneKey: k, mode: .first, highest: 0, joining: joining) }
        #expect(throws: E2eCallError.self) { try checkList(bytes: bytes, phoneKey: k, mode: .first, accountId: Data(count: 32), highest: 0, joining: joining) }
        for highest: UInt64 in [1 << 63, UInt64.max] {
            #expect(throws: E2eCallError.self) { try checkList(bytes: bytes, phoneKey: k, mode: .first, highest: highest) }
        }
        // The largest a caller may pass, and the mistakes checked before the bytes are.
        #expect(outcome { try checkList(bytes: bytes, phoneKey: k, mode: .first, highest: (1 << 63) - 1) } == "\(ListResult.refused(.signature))")
        #expect(throws: E2eCallError.self) { try checkList(bytes: Data(), phoneKey: k, mode: .first, highest: 0, joining: joining) }
        #expect(outcome { try checkList(bytes: bytes, phoneKey: k, mode: .later, accountId: Data(count: 32), highest: 0, joining: joining) } == "\(ListResult.refused(.signature))")
    }

    @Test func noInputBytesMakeItThrow() throws {
        for bytes in [Data(), Data(count: 63), Data(count: 64), Data(repeating: 0xFF, count: 200), Data(count: 16_385)] {
            for phoneKey in [Data(), Data(count: 31), Data(count: 32), Data(count: 33), Data(Self.phone.public)] {
                _ = try checkList(bytes: bytes, phoneKey: phoneKey, mode: .first, highest: 0)
                _ = try checkList(bytes: bytes, phoneKey: phoneKey, mode: .later, accountId: Data(count: 32), highest: 0)
            }
        }
    }

    @Test func version1AndItsBoundaries() throws {
        let v1 = signed(Self.v1, id: [], secret: Self.phone.secret)
        let pk = Data(Self.phone.public)
        guard case let .accepted(list, counter, hash) = try checkList(bytes: v1, phoneKey: pk, mode: .first, highest: 0) else {
            Issue.record("version 1 not accepted")
            return
        }
        #expect(counter == 1 && [UInt8](hash) == Self.id && list.devices == [DeviceKeys(Self.phoneDevice())])
        #expect(try checkList(bytes: v1, phoneKey: pk, mode: .first, accountId: Data(Self.id), highest: 0) == .accepted(list, counter: 1, hash: hash))
        var other = Self.id
        other[31] ^= 1
        #expect(try checkList(bytes: v1, phoneKey: pk, mode: .first, accountId: Data(other), highest: 0) == .refused(.mode))
        #expect(try checkList(bytes: v1, phoneKey: pk, mode: .first, highest: 1) == .old(counter: 1, hash: hash))
        // Slices of larger buffers read the same.
        #expect(try checkList(bytes: sliced(v1), phoneKey: sliced(pk), mode: .first, accountId: sliced(Data(Self.id)), highest: 0) == .accepted(list, counter: 1, hash: hash))
        let v2 = signed(Self.v2(), id: Self.id, secret: Self.phone.secret)
        let later = try checkList(bytes: v2, phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: 1)
        guard case .accepted = later else {
            Issue.record("version 2 gave \(later)")
            return
        }
        #expect(try checkList(bytes: sliced(v2), phoneKey: sliced(pk), mode: .later, accountId: sliced(Data(Self.id)), highest: 1) == later)
        // At a join, with the joining computer exactly as listed, and a
        // slice of it.
        let joining = DeviceKeys(Self.computer(20))
        #expect(try checkList(bytes: v2, phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: 1, joining: joining) == later)
        let slicedJoining = DeviceKeys(role: 1, signingKey: sliced(joining.signingKey), channelKey: sliced(joining.channelKey), boxKey: sliced(joining.boxKey),
                                       readOnlyKey: sliced(Data()), notificationKey: sliced(Data()))
        #expect(try checkList(bytes: v2, phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: 1, joining: slicedJoining) == later)
    }

    @Test func theHighestHeldUpTo2To63() throws {
        let pk = Data(Self.phone.public)
        let limit: UInt64 = (1 << 63) - 1
        let top = signed(Self.v2(counter: limit), id: Self.id, secret: Self.phone.secret)
        guard case let .accepted(_, counter, hash) = try checkList(bytes: top, phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: limit - 1) else {
            Issue.record("2^63-1 over 2^63-2 not accepted")
            return
        }
        #expect(counter == limit)
        #expect(try checkList(bytes: top, phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: limit) == .old(counter: counter, hash: hash))
        for over: UInt64 in [1 << 63, UInt64.max] {
            let bytes = signed(Self.v2(counter: over), id: Self.id, secret: Self.phone.secret)
            #expect(try checkList(bytes: bytes, phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: 0) == .refused(.range))
        }
    }

    @Test func theSizeToTheByte() throws {
        let pk = Data(Self.phone.public)
        // Padded by an unknown field (number 15, bytes) to exactly the limit, and one over.
        func padded(_ total: Int) -> Data {
            var body = Self.v2()
            let room = total - 64 - body.count - 1 - 2
            body += [0x7A] + leb128(UInt64(room)) + [UInt8](repeating: 0, count: room)
            precondition(body.count + 64 == total, "\(body.count)")
            return signed(body, id: Self.id, secret: Self.phone.secret)
        }
        #expect(padded(listMaxBytes).count == listMaxBytes)
        guard case .unsupported(.unknownField, _, _) = try checkList(bytes: padded(listMaxBytes), phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: 1) else {
            Issue.record("16,384 bytes not through the size check")
            return
        }
        #expect(try checkList(bytes: padded(listMaxBytes + 1), phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: 1) == .refused(.size))
    }

    /// Random bodies under good signatures, and random changes to good
    /// ones: every one gives a result, and an accepted one holds what the
    /// steps require.
    @Test func noSignedBodyMakesItThrow() throws {
        var g = Seeded(state: 2)
        let pk = Data(Self.phone.public)
        var seen: Set<String> = []
        for round in 0..<3000 {
            var body: [UInt8]
            if round % 3 == 0 {
                body = randomBytes(Int.random(in: 0...300, using: &g), &g)
            } else {
                body = Self.v2(counter: UInt64.random(in: 0...4, using: &g), devices: [Self.phoneDevice(), Self.computer(20), Self.computer(40)].filter { _ in Int.random(in: 0..<4, using: &g) > 0 })
                for _ in 0..<Int.random(in: 1...4, using: &g) where !body.isEmpty {
                    let at = Int.random(in: 0..<body.count, using: &g)
                    switch Int.random(in: 0..<3, using: &g) {
                    case 0: body[at] = UInt8.random(in: 0...255, using: &g)
                    case 1: body.remove(at: at)
                    default: body.insert(UInt8.random(in: 0...255, using: &g), at: at)
                    }
                }
            }
            let first = round % 5 == 0
            let bytes = signed(body, id: first ? [] : Self.id, secret: Self.phone.secret)
            let r = first ? try checkList(bytes: bytes, phoneKey: pk, mode: .first, highest: 0) : try checkList(bytes: bytes, phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: 1)
            switch r {
            case let .accepted(list, counter, hash):
                seen.insert("accepted")
                #expect(counter == list.counter && hash == Data(Sodium.sha256(body)))
                #expect(list.devices.contains { $0.signingKey == pk && $0.role == roleClient && $0.readOnlyKey.count == 32 })
                #expect(list.devices.allSatisfy { [$0.signingKey, $0.channelKey, $0.boxKey].allSatisfy { $0.count == 32 } })
            case let .old(counter, _): seen.insert("old"); #expect(counter <= 1)
            case let .unsupported(reason, _, _): seen.insert(reason.rawValue)
            case let .refused(reason): seen.insert(reason.rawValue)
            }
        }
        // The rounds reach far into the check.
        #expect(seen.isSuperset(of: ["accepted", "parse", "mode", "unknown-field"]), Comment(rawValue: "\(seen.sorted())"))
    }

    /// A list failing two steps gives the earlier one's reason, as every
    /// language orders them; each shared case fails one step only.
    @Test func theStepsInOrder() throws {
        let pk = Data(Self.phone.public)
        func check(_ body: [UInt8], joining: DeviceKeys? = nil) throws -> String {
            switch try checkList(bytes: signed(body, id: Self.id, secret: Self.phone.secret), phoneKey: pk, mode: .later, accountId: Data(Self.id), highest: 1, joining: joining) {
            case let .unsupported(r, _, _): return r.rawValue
            case let .refused(r): return r.rawValue
            case let other: return "\(other)"
            }
        }
        var role0 = Self.computer(20)
        role0.role = 0
        var role3 = Self.computer(20)
        role3.role = 3
        role3.signingKey = Data(count: 31)
        var short = Self.computer(20)
        short.boxKey = Data(count: 31)
        short.readOnlyKey = key(90)
        var phoneKeyed = Self.computer(20)
        phoneKeyed.readOnlyKey = Self.phoneDevice().signingKey
        let unknown: [UInt8] = [0x7A, 0x01, 0x00]
        #expect(try check(Self.v2(devices: [Self.phoneDevice(), role0]) + unknown) == "unknown-field")
        #expect(try check(Self.v2(devices: [Self.phoneDevice(), role3])) == "role")
        #expect(try check(Self.v2(devices: [Self.phoneDevice(), short])) == "key")
        #expect(try check(Self.v2(devices: [Self.phoneDevice(), phoneKeyed])) == "phone-keys")
        // The phone missing, and the joining device not listed.
        #expect(try check(Self.v2(devices: [Self.computer(20)]), joining: DeviceKeys(Self.computer(40))) == "phone")
    }

    @Test func anAcceptedListIsTheCallersToKeep() throws {
        var bytes = signed(Self.v1, id: [], secret: Self.phone.secret)
        let r = try checkList(bytes: bytes, phoneKey: Data(Self.phone.public), mode: .first, highest: 0)
        let before = r
        bytes.resetBytes(in: 0..<bytes.count)
        #expect(r == before)
        guard case let .accepted(list, _, _) = r else {
            Issue.record("not accepted")
            return
        }
        #expect(list.devices.single?.channelKey == key(1))
    }
}

extension Array {
    var single: Element? { count == 1 ? self[0] : nil }
}

// MARK: - Notices

struct E2eNoticeTests {
    static let computerSign = signingPair(30)
    static let computerBox = boxPair(31)
    static let phoneNotify = boxPair(32)
    static let slot = Slot(accountId: key(50), computerKey: Data(computerSign.public), sessionId: Data("s-1".utf8))
    static let list = DeviceList(counter: 2, devices: [
        DeviceKeys(role: roleClient, signingKey: key(60), channelKey: key(61), boxKey: key(62), readOnlyKey: key(63), notificationKey: Data(phoneNotify.public)),
        DeviceKeys(role: roleComputer, signingKey: Data(computerSign.public), channelKey: key(70), boxKey: Data(computerBox.public)),
    ])

    static func prefix(_ slot: Slot = slot) -> [UInt8] {
        try! framed(noticeContext, [[UInt8](slot.accountId), [UInt8](slot.computerKey), [UInt8](slot.sessionId)]) + [8]
    }

    static func body(_ sessionName: [UInt8], _ computerName: [UInt8], _ notice: [UInt8]) -> [UInt8] {
        var n = Pirc_V1alpha2_Notice()
        n.sessionName = Data(sessionName)
        n.computerName = Data(computerName)
        n.notice = Data(notice)
        return [UInt8](try! n.serializedData())
    }

    static func sealed(_ plaintext: [UInt8], nonce: UInt8 = 1) -> Data {
        sealBox(plaintext, nonce: [UInt8](repeating: nonce, count: 24), to: phoneNotify.public, from: computerBox.secret)
    }

    static func notice(ordering: UInt64, _ body: [UInt8] = body(Array("a".utf8), Array("b".utf8), Array("c".utf8))) -> Data {
        sealed(prefix() + (0..<8).map { UInt8(truncatingIfNeeded: ordering >> (56 - 8 * UInt64($0))) } + body)
    }

    static func open(_ sealed: Data, slot: Slot = slot, list: DeviceList = list, highest: UInt64? = nil, now: UInt64 = 0) throws -> NoticeResult {
        try openNotice(sealed: sealed, slot: slot, recipientSecretKey: Data(phoneNotify.secret), list: list, highest: highest, now: now)
    }

    static let abc = NoticeText(sessionName: "a", computerName: "b", notice: "c")

    @Test func callersMistakesThrow() throws {
        let good = Self.notice(ordering: 5)
        for k in [Data(), Data(count: 31), Data(count: 33)] {
            #expect(throws: E2eCallError.self) { try openNotice(sealed: good, slot: Self.slot, recipientSecretKey: k, list: Self.list, highest: nil, now: 0) }
        }
        for bad: UInt64 in [1 << 63, UInt64.max] {
            #expect(throws: E2eCallError.self) { try Self.open(good, highest: bad) }
            #expect(throws: E2eCallError.self) { try Self.open(good, now: bad) }
        }
        // Checked before the bytes are: on bytes that are refused at once.
        #expect(throws: E2eCallError.self) { try Self.open(Data(), now: 1 << 63) }
        #expect(throws: E2eCallError.self) { try openNotice(sealed: Data(), slot: Slot(accountId: Data(), computerKey: Data(), sessionId: Data()), recipientSecretKey: Data(), list: Self.list, highest: nil, now: 0) }
        #expect(try Self.open(good, highest: (1 << 63) - 1, now: (1 << 63) - 1) == .refused(.ordering))
        #expect(try Self.open(good, highest: 4, now: 0) == .accepted(ordering: 5, body: Self.abc))
    }

    @Test func orderingAt2To63AndLargeTimes() throws {
        let top: UInt64 = (1 << 63) - 1
        #expect(try Self.open(Self.notice(ordering: top), now: top) == .accepted(ordering: top, body: Self.abc))
        #expect(try Self.open(Self.notice(ordering: top), highest: top - 1, now: top - futureMs) == .accepted(ordering: top, body: Self.abc))
        #expect(try Self.open(Self.notice(ordering: top), now: top - futureMs - 1) == .refused(.future))
        #expect(try Self.open(Self.notice(ordering: top), now: 0) == .refused(.future))
        #expect(try Self.open(Self.notice(ordering: 0), now: top) == .accepted(ordering: 0, body: Self.abc))
        #expect(try Self.open(Self.notice(ordering: 0), highest: 0, now: top) == .refused(.ordering))
        for over: UInt64 in [1 << 63, UInt64.max] {
            #expect(try Self.open(Self.notice(ordering: over), now: top) == .refused(.range))
        }
        // Exactly a day ahead, and a millisecond more, from a time near the top.
        #expect(try Self.open(Self.notice(ordering: top - 1), now: top - 1 - futureMs) == .accepted(ordering: top - 1, body: Self.abc))
        #expect(try Self.open(Self.notice(ordering: top - 1), now: top - 2 - futureMs) == .refused(.future))
        // highest 0 is a value seen: ordering 0 is not above it.
        #expect(try Self.open(Self.notice(ordering: 1), highest: 0) == .accepted(ordering: 1, body: Self.abc))
    }

    @Test func aComputerBoxKeyOfTheWrongLengthIsARefusedBox() throws {
        for bad in [Data(), Data(count: 31), Data(Self.computerBox.public) + Data([0])] {
            var list = Self.list
            list.devices[1].boxKey = bad
            #expect(try Self.open(Self.notice(ordering: 5), list: list) == .refused(.box))
        }
        // The sender listed with any role but a computer's is not listed.
        for role: UInt32 in [0, roleClient, 3] {
            var list = Self.list
            list.devices[1].role = role
            #expect(try Self.open(Self.notice(ordering: 5), list: list) == .refused(.computerNotListed), Comment(rawValue: String(role)))
        }
        // The first device with the computer's signing key is the one read.
        var list = Self.list
        list.devices.append(DeviceKeys(role: roleComputer, signingKey: Data(Self.computerSign.public), channelKey: key(80), boxKey: key(81)))
        #expect(try Self.open(Self.notice(ordering: 5), list: list) == .accepted(ordering: 5, body: Self.abc))
        list.devices.swapAt(1, 2)
        #expect(try Self.open(Self.notice(ordering: 5), list: list) == .refused(.box))
        // A client with the computer's signing key ahead of the computer is
        // passed over: the sender is looked for among computers only.
        var shared = Self.list
        shared.devices.insert(DeviceKeys(role: roleClient, signingKey: Data(Self.computerSign.public), channelKey: key(82), boxKey: key(83)), at: 0)
        #expect(try Self.open(Self.notice(ordering: 5), list: shared) == .accepted(ordering: 5, body: Self.abc))
    }

    @Test func slicesReadTheSame() throws {
        let s = Slot(accountId: sliced(Self.slot.accountId), computerKey: sliced(Self.slot.computerKey), sessionId: sliced(Self.slot.sessionId))
        var list = Self.list
        list.devices[1].signingKey = sliced(list.devices[1].signingKey)
        list.devices[1].boxKey = sliced(list.devices[1].boxKey)
        let got = try openNotice(sealed: sliced(Self.notice(ordering: 5)), slot: s, recipientSecretKey: sliced(Data(Self.phoneNotify.secret)), list: list, highest: nil, now: 0)
        #expect(got == .accepted(ordering: 5, body: Self.abc))
    }

    @Test func textToTheByte() throws {
        func open(_ body: [UInt8]) throws -> NoticeResult { try Self.open(Self.notice(ordering: 5, body)) }
        let e = Array("é".utf8)
        // Each field at its cap with a two-byte character last, then one byte over.
        for (i, cap) in [NoticeCaps.sessionName, NoticeCaps.computerName, NoticeCaps.notice].enumerated() {
            let at = [UInt8](repeating: 0x61, count: cap - 2) + e
            var fields: [[UInt8]] = [[], [], []]
            fields[i] = at
            let text = String(repeating: "a", count: cap - 2) + "é"
            let want = NoticeText(sessionName: i == 0 ? text : "", computerName: i == 1 ? text : "", notice: i == 2 ? text : "")
            #expect(try open(Self.body(fields[0], fields[1], fields[2])) == .accepted(ordering: 5, body: want))
            fields[i] = at + [0x61]
            #expect(try open(Self.body(fields[0], fields[1], fields[2])) == .refused(.text))
            // Malformed in each field: a sequence cut short, a surrogate, an overlong form.
            for bad: [UInt8] in [[0x61, 0xC3], [0xE2, 0x82], [0xED, 0xA0, 0x80], [0xE0, 0x80, 0xAF], [0xF4, 0x90, 0x80, 0x80]] {
                fields[i] = bad
                #expect(try open(Self.body(fields[0], fields[1], fields[2])) == .refused(.text), Comment(rawValue: hex(bad)))
            }
        }
        // A leading U+FEFF is kept in every field.
        let bom: [UInt8] = [0xEF, 0xBB, 0xBF, 0x78]
        #expect(try open(Self.body(bom, bom, bom)) == .accepted(ordering: 5, body: NoticeText(sessionName: "\u{FEFF}x", computerName: "\u{FEFF}x", notice: "\u{FEFF}x")))
    }

    @Test func sessionIdsToTheByte() throws {
        for (id, ok) in [([UInt8](repeating: 0x61, count: 128), true), ([UInt8](repeating: 0x61, count: 129), false), ([0xEF, 0xBB, 0xBF], true), ([0x61, 0xE2, 0x82], false)] {
            let s = Slot(accountId: Self.slot.accountId, computerKey: Self.slot.computerKey, sessionId: Data(id))
            let sealed = Self.sealed(Self.prefix(s) + [0, 0, 0, 0, 0, 0, 0, 5] + Self.body([], [], []))
            #expect(try Self.open(sealed, slot: s) == (ok ? .accepted(ordering: 5, body: NoticeText(sessionName: "", computerName: "", notice: "")) : .refused(.slot)))
        }
    }

    /// Random plaintexts in real boxes: wholly random; the right prefix and
    /// random rest; the right prefix and ordering and random fields. Every
    /// one gives a result, and the last kind the result an independent
    /// reading of the fields gives.
    @Test func noBoxedPlaintextMakesItThrow() throws {
        var g = Seeded(state: 3)
        var reasons: Set<String> = []
        for round in 0..<6000 {
            let plaintext: [UInt8]
            var want: NoticeResult?
            switch round % 3 {
            case 0:
                plaintext = randomBytes(Int.random(in: 0...120, using: &g), &g)
            case 1:
                // Half with an ordering value near the highest seen, so the body is read.
                let rest = round % 2 == 0 ? randomBytes(8, &g) : [0, 0, 0, 0, 0, 0, 0, UInt8.random(in: 0...6, using: &g)]
                plaintext = Self.prefix() + rest + randomBytes(Int.random(in: 0...40, using: &g), &g)
            default:
                let fields = (0..<3).map { _ in edgyBytes(Int.random(in: 0...6, using: &g), &g) }
                plaintext = Self.prefix() + [0, 0, 0, 0, 0, 0, 0, 9] + Self.body(fields[0], fields[1], fields[2])
                if #available(macOS 15, iOS 18, *) {
                    let texts = fields.map { String(validating: $0, as: UTF8.self) }
                    if let a = texts[0], let b = texts[1], let c = texts[2] {
                        want = .accepted(ordering: 9, body: NoticeText(sessionName: a, computerName: b, notice: c))
                    } else {
                        want = .refused(.text)
                    }
                }
            }
            let got = try Self.open(Self.sealed(plaintext, nonce: UInt8(round % 256)), highest: round % 2 == 0 ? nil : 3, now: 0)
            if let want { #expect(got == want, Comment(rawValue: hex(plaintext))) }
            switch got {
            case .accepted: reasons.insert("accepted")
            case let .refused(r): reasons.insert(r.rawValue)
            }
        }
        #expect(reasons.isSuperset(of: ["accepted", "prefix", "range", "ordering", "future", "parse", "text"]), Comment(rawValue: "\(reasons.sorted())"))
    }

    /// Random bytes as the sealed copy, and random slots and keys around
    /// good copies: every one gives a result.
    @Test func noSealedBytesMakeItThrow() throws {
        var g = Seeded(state: 4)
        let good = Self.notice(ordering: 5)
        for round in 0..<3000 {
            var sealed = round % 2 == 0 ? Data(randomBytes(Int.random(in: 0...200, using: &g), &g)) : good
            if round % 2 == 1, !sealed.isEmpty {
                sealed[Int.random(in: 0..<sealed.count, using: &g)] ^= UInt8.random(in: 1...255, using: &g)
            }
            let s = Slot(accountId: round % 7 == 0 ? Data(randomBytes(32, &g)) : Self.slot.accountId,
                         computerKey: round % 5 == 0 ? Data(randomBytes(Int.random(in: 0...33, using: &g), &g)) : Self.slot.computerKey,
                         sessionId: round % 3 == 0 ? Data(edgyBytes(Int.random(in: 0...4, using: &g), &g)) : Self.slot.sessionId)
            let r = try openNotice(sealed: sealed, slot: s, recipientSecretKey: Data(randomBytes(32, &g)), list: Self.list, highest: nil, now: 0)
            #expect(r != .accepted(ordering: 5, body: Self.abc))
        }
        #expect(try Self.open(Data(count: sealedMaxBytes + 1)) == .refused(.size))
        #expect(try Self.open(Data(count: 39)) == .refused(.size))
        #expect(try Self.open(Data(count: 40)) == .refused(.box))
    }
}
