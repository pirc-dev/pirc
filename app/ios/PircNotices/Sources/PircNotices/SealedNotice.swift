// Opening a session's notice as a computer sealed it for the relay to keep
// (docs/e2e.md, section 5): crypto_box from the computer's box key to the
// phone's notification key, checked against the slot the relay names it by
// and the caller's newest list. The steps, their order and the names of
// results and reasons are those of openSealed in e2e/sealed.ts and of
// openNotice in app/lib/e2e/sealed.dart, for the notice kind only: the
// extension opens no announcements. On a body as a computer's maker writes
// it they agree on every input; a body only a listed computer could seal in
// another encoding (a known field with another wire type, a length or
// varint wider than a maker writes, a field running past the end of its
// message, deeply nested unknown groups) can read differently in different
// languages, each protobuf library reading such bytes its own way. That is
// by design: the checks defend against everyone but a listed computer,
// which seals each recipient's copy itself. No input bytes make opening
// throw; only a caller's mistake does.

import Foundation

public let noticeContext = "pirc-e2e-v2 notice"
public let sealedMaxBytes = 65_536
public let sessionIdMaxBytes = 128
/// How far ahead of now an ordering value may be, in milliseconds.
public let futureMs: UInt64 = 86_400_000

/// Each field's cap in bytes of UTF-8.
public enum NoticeCaps {
    public static let sessionName = 200
    public static let computerName = 200
    public static let notice = 4096
}

/// The slot a sealed copy is kept in, but for its kind: whose, from which
/// computer, for which session.
public struct Slot: Equatable, Sendable {
    public var accountId: Data
    /// The computer's signing key.
    public var computerKey: Data
    /// The session ID's UTF-8 bytes exactly as the protocol carries them.
    public var sessionId: Data

    public init(accountId: Data, computerKey: Data, sessionId: Data) {
        self.accountId = accountId
        self.computerKey = computerKey
        self.sessionId = sessionId
    }
}

/// What an opened notice holds.
public struct NoticeText: Equatable, Sendable {
    public var sessionName: String
    public var computerName: String
    public var notice: String
}

public enum SealedRefusal: String, Sendable {
    case slot, size
    /// A copy from a computer not on the caller's newest list; the caller
    /// may keep the bytes and try again once it accepts a newer list.
    case computerNotListed = "computer-not-listed"
    case box, prefix, range, ordering, future, parse, text
}

public enum NoticeResult: Equatable, Sendable {
    case accepted(ordering: UInt64, body: NoticeText)
    case refused(SealedRefusal)
}

/// Whether a session ID is 1 to 128 bytes of valid UTF-8.
func goodSessionId(_ id: [UInt8]) -> Bool {
    !id.isEmpty && id.count <= sessionIdMaxBytes && isUTF8(id)
}

/// Opens a copy of a session's notice sealed to this phone's notification
/// key: `sealed`, the nonce then the box, kept in `slot`;
/// `recipientSecretKey`, the notification secret key, 32 bytes; `list`, the
/// caller's newest list; `highest`, the highest ordering value seen for the
/// slot, nil if none; `now`, the time in milliseconds. highest and now are
/// below 2^63. Throws an E2eCallError for a caller's mistake in those;
/// never for the bytes. Storing the new highest is the caller's.
public func openNotice(sealed: Data, slot: Slot, recipientSecretKey: Data, list: DeviceList, highest: UInt64?, now: UInt64) throws -> NoticeResult {
    if recipientSecretKey.count != Sodium.boxSecretKeyBytes { throw E2eCallError("openNotice: the recipient secret key is 32 bytes") }
    if let highest, highest >= numberLimit { throw E2eCallError("openNotice: highest is 0 to 2^63-1, or nil") }
    if now >= numberLimit { throw E2eCallError("openNotice: now is 0 to 2^63-1") }
    let sessionId = [UInt8](slot.sessionId)

    // 1. The slot as the relay names it.
    if !goodSessionId(sessionId) { return .refused(.slot) }
    // 2. Size.
    if sealed.count > sealedMaxBytes || sealed.count < Sodium.nonceBytes + Sodium.macBytes { return .refused(.size) }
    // 3. The sender, a computer on the caller's newest list.
    let computerKey = [UInt8](slot.computerKey)
    guard let computer = list.devices.first(where: { $0.role == roleComputer && bytesEqual([UInt8]($0.signingKey), computerKey) }) else {
        return .refused(.computerNotListed)
    }
    // 4. The box, from that computer's box key. Anything libsodium refuses,
    // such as a key it will not use, is a refused box.
    let bytes = [UInt8](sealed)
    guard let plaintext = Sodium.boxOpen(bytes[Sodium.nonceBytes...], nonce: bytes[..<Sodium.nonceBytes], publicKey: [UInt8](computer.boxKey), secretKey: recipientSecretKey) else {
        return .refused(.box)
    }
    // 5. The slot and kind it was sealed for, then 8 bytes of ordering. The
    // context is a constant that framed accepts.
    let start = try! framed(noticeContext, [[UInt8](slot.accountId), computerKey, sessionId]) + [8]
    if plaintext.count < start.count + 8 || !bytesEqual([UInt8](plaintext[..<start.count]), start) { return .refused(.prefix) }
    // 6. The ordering value.
    let ordering = plaintext[start.count..<start.count + 8].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
    if ordering >= numberLimit { return .refused(.range) }
    if let highest, ordering <= highest { return .refused(.ordering) }
    if ordering > now && ordering - now > futureMs { return .refused(.future) }
    // 7. The body, and its text.
    let notice: Pirc_V1alpha2_Notice
    do {
        notice = try Pirc_V1alpha2_Notice(serializedBytes: [UInt8](plaintext[(start.count + 8)...]))
    } catch {
        return .refused(.parse)
    }
    func text(_ b: Data, _ cap: Int) -> String? {
        b.count <= cap ? utf8Text([UInt8](b)) : nil
    }
    guard let sessionName = text(notice.sessionName, NoticeCaps.sessionName),
          let computerName = text(notice.computerName, NoticeCaps.computerName),
          let body = text(notice.notice, NoticeCaps.notice)
    else {
        return .refused(.text)
    }
    return .accepted(ordering: ordering, body: NoticeText(sessionName: sessionName, computerName: computerName, notice: body))
}
