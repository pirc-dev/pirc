// Checking a version of an account's device list (docs/e2e.md, sections 3
// and 6): the signature first, on the bytes as received, then the body.
// The steps, their order and the names of results and reasons are those of
// e2e/list.ts and app/lib/e2e/list.dart, and on a body as the phone's maker
// writes it (fields in order, each with its declared wire type, varints and
// lengths in their shortest form) they agree on every input. A body only
// the phone could sign in another encoding (a known field with another wire
// type, a length or varint wider than a maker writes, a field running past
// the end of its message, deeply nested unknown groups) can read
// differently in different languages, each protobuf library reading such
// bytes its own way. That is by design: the checks defend against everyone
// but the phone, which is trusted. No input bytes make the check throw;
// only a caller's mistake does.

import Foundation

public let listContext = "pirc-e2e-v2 list"
public let listMaxBytes = 16_384
public let maxClients = 10
public let maxComputers = 50
public let roleComputer: UInt32 = 1
public let roleClient: UInt32 = 2

let keyBytes = 32
let accountIdBytes = 32

/// A device's role and its five keys, as the list holds them (empty where
/// it has none).
public struct DeviceKeys: Equatable, Hashable, Sendable {
    public var role: UInt32
    public var signingKey: Data
    public var channelKey: Data
    public var boxKey: Data
    public var readOnlyKey: Data
    public var notificationKey: Data

    public init(role: UInt32, signingKey: Data, channelKey: Data, boxKey: Data, readOnlyKey: Data = Data(), notificationKey: Data = Data()) {
        self.role = role
        self.signingKey = signingKey
        self.channelKey = channelKey
        self.boxKey = boxKey
        self.readOnlyKey = readOnlyKey
        self.notificationKey = notificationKey
    }

    init(_ d: Pirc_V1alpha2_Device) {
        self.init(role: d.role, signingKey: d.signingKey, channelKey: d.channelKey, boxKey: d.boxKey, readOnlyKey: d.readOnlyKey, notificationKey: d.notificationKey)
    }

    var keys: [Data] { [signingKey, channelKey, boxKey, readOnlyKey, notificationKey] }

    /// The same role and the same five keys, byte for byte.
    func same(_ other: DeviceKeys) -> Bool {
        role == other.role && zip(keys, other.keys).allSatisfy { bytesEqual([UInt8]($0), [UInt8]($1)) }
    }
}

/// A version's body as read: what an accepted check returns, and what
/// opening a notice reads of the caller's newest list.
public struct DeviceList: Equatable, Sendable {
    public var accountId: Data
    public var counter: UInt64
    public var previousHash: Data
    public var devices: [DeviceKeys]

    public init(accountId: Data = Data(), counter: UInt64, previousHash: Data = Data(), devices: [DeviceKeys]) {
        self.accountId = accountId
        self.counter = counter
        self.previousHash = previousHash
        self.devices = devices
    }
}

public enum ListMode: Sendable {
    /// Version 1.
    case first
    /// Any version after it.
    case later
}

public enum ListRefusal: String, Sendable {
    case size, signature, parse, range, mode
    /// At a join, the list does not hold the joining device.
    case `self`
}

public enum ListUnsupported: String, Sendable {
    case unknownField = "unknown-field"
    case role, key
    case phoneKeys = "phone-keys"
    case duplicateKey = "duplicate-key"
    case count, phone
}

/// What a check gives. counter and hash (SHA-256 of the body) come with
/// every result but refused.
public enum ListResult: Equatable, Sendable {
    case accepted(DeviceList, counter: UInt64, hash: Data)
    case old(counter: UInt64, hash: Data)
    case unsupported(ListUnsupported, counter: UInt64, hash: Data)
    case refused(ListRefusal)
}

/// Checks a version of the device list: `bytes` as received (the 64-byte
/// signature, then the body), under `phoneKey`, the account's phone's
/// signing key pinned at the join. `accountId` is 32 bytes: optional in
/// first mode (version 1's body must then hash to it), required in later
/// mode. `highest` is the highest counter held, 0 if none, below 2^63.
/// `joining` is the joining device itself, in later mode only. Throws an
/// E2eCallError for a caller's mistake in those; never for the bytes.
public func checkList(bytes: Data, phoneKey: Data, mode: ListMode, accountId: Data? = nil, highest: UInt64, joining: DeviceKeys? = nil) throws -> ListResult {
    if mode == .first && joining != nil { throw E2eCallError("checkList: the joining device is checked in later mode only") }
    if mode == .later ? accountId?.count != accountIdBytes : accountId != nil && accountId!.count != accountIdBytes {
        throw E2eCallError("checkList: the account ID is 32 bytes, and later mode needs it")
    }
    if highest >= numberLimit { throw E2eCallError("checkList: highest is 0 to 2^63-1") }

    // 1. Size, before anything is read.
    if bytes.count < Sodium.signatureBytes || bytes.count > listMaxBytes { return .refused(.size) }
    // A copy, indexed from 0 whatever the caller's Data is a slice of.
    let all = [UInt8](bytes)
    let signature = [UInt8](all[..<Sodium.signatureBytes])
    let body = [UInt8](all[Sodium.signatureBytes...])

    // 2. The signature, over the body as received; only then the parse.
    let signedId = mode == .first ? [] : [UInt8](accountId!)
    // The context is a constant that framed accepts.
    guard Sodium.verify(signature: signature, message: try! framed(listContext, [signedId, body]), key: [UInt8](phoneKey)) else {
        return .refused(.signature)
    }
    let list: Pirc_V1alpha2_ListBody
    do {
        list = try Pirc_V1alpha2_ListBody(serializedBytes: body)
    } catch {
        return .refused(.parse)
    }
    let counter = list.counter
    let hash = Sodium.sha256(body)

    // 3. The counter's range, before it is compared with anything.
    if counter >= numberLimit { return .refused(.range) }

    // 4. The mode and the body agree.
    switch mode {
    case .first:
        if counter != 1 || !list.accountID.isEmpty || !list.previousHash.isEmpty || (accountId.map { !bytesEqual(hash, [UInt8]($0)) } ?? false) {
            return .refused(.mode)
        }
    case .later:
        if counter < 2 || !bytesEqual([UInt8](list.accountID), [UInt8](accountId!)) || list.previousHash.count != keyBytes {
            return .refused(.mode)
        }
    }

    // 5. Newer than what is held.
    if counter <= highest { return .old(counter: counter, hash: Data(hash)) }
    func unsupported(_ reason: ListUnsupported) -> ListResult { .unsupported(reason, counter: counter, hash: Data(hash)) }
    let devices = list.devices

    // 6. No unknown field, in the body or in any device.
    if !list.unknownFields.data.isEmpty || devices.contains(where: { !$0.unknownFields.data.isEmpty }) { return unsupported(.unknownField) }

    // 7. Roles.
    if devices.contains(where: { $0.role != roleComputer && $0.role != roleClient }) { return unsupported(.role) }

    // 8. The three keys every device has.
    if devices.contains(where: { $0.signingKey.count != keyBytes || $0.channelKey.count != keyBytes || $0.boxKey.count != keyBytes }) {
        return unsupported(.key)
    }

    // 9. A phone's two keys: both or neither, and only on a client.
    for d in devices {
        let r = d.readOnlyKey.count
        let n = d.notificationKey.count
        let both = r == keyBytes && n == keyBytes
        let neither = r == 0 && n == 0
        if !(both || neither) || (both && d.role != roleClient) { return unsupported(.phoneKeys) }
    }

    // 10. No public key twice, across devices and kinds.
    var seen = Set<Data>()
    for d in devices {
        for k in DeviceKeys(d).keys where !k.isEmpty {
            if !seen.insert(k).inserted { return unsupported(.duplicateKey) }
        }
    }

    // 11. How many.
    let clients = devices.filter { $0.role == roleClient }.count
    let computers = devices.count - clients
    if devices.isEmpty || clients > maxClients || computers > maxComputers || (mode == .first && devices.count != 1) {
        return unsupported(.count)
    }

    // 12. The pinned phone, as a client with its phone keys.
    let pinned = [UInt8](phoneKey)
    guard let phone = devices.first(where: { bytesEqual([UInt8]($0.signingKey), pinned) }), phone.role == roleClient, phone.readOnlyKey.count == keyBytes else {
        return unsupported(.phone)
    }

    // 13. At a join, the joining device exactly as it is.
    let read = devices.map(DeviceKeys.init)
    if let joining, !read.contains(where: { $0.same(joining) }) { return .refused(ListRefusal.`self`) }

    return .accepted(DeviceList(accountId: list.accountID, counter: counter, previousHash: list.previousHash, devices: read), counter: counter, hash: Data(hash))
}
