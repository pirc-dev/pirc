// What a notification opens (docs/e2e.md, sections 3, 4 and 9): the
// announcement key from a bundle, the announcement frame under it, and
// the label record under the label key. A port of the parts of
// crypto/keys.ts the read-only key uses. The bundle and the announcement
// are checked against the list the app has checked; the chain itself is
// not checked again here, to stay small.

import CryptoKit
import Foundation

/// The devices of the list version the app checked: each key's role.
struct Devices: Sendable {
    let roles: [Data: Pirc_V1alpha2_DeviceRole]

    init(_ roles: [Data: Pirc_V1alpha2_DeviceRole]) { self.roles = roles }

    init(_ version: Pirc_V1alpha2_ListVersionBody) {
        roles = Dictionary(version.devices.map { ($0.publicKey, $0.role) }, uniquingKeysWith: { a, _ in a })
    }

    func role(_ key: Data) -> Pirc_V1alpha2_DeviceRole? { roles[key] }
}

/// This device: its Ed25519 key and the private half of its pre-key.
struct Me {
    let publicKey: Data
    let preKey: Curve25519.KeyAgreement.PrivateKey
}

// --- frames ---

/// Where a frame was sealed: what its additional data binds.
struct FrameAt {
    var accountID: Data
    var keyID: Data
    var session: Pirc_V1alpha1_SessionRef
    var kind: Pirc_V1alpha2_FrameKind
    /// The client's key for an answer to one client; empty otherwise.
    var recipient = Data()
    var listVersion: UInt64
    var counter: UInt64
}

func frameAad(_ f: FrameAt) -> Data {
    framed(
        "pirc-e2e-v1 frame", f.accountID, f.keyID, f.session.hostKey, Data(f.session.sessionID.utf8), Data(f.session.instanceID.utf8),
        Data([UInt8(Pirc_V1alpha2_Direction.hostToClient.rawValue)]), Data([UInt8(truncatingIfNeeded: f.kind.rawValue)]), f.recipient,
        u64(f.listVersion), u64(f.counter))
}

/// Nil when it does not open. The nonce is four zero bytes and the counter.
func openFrame(key: Data, _ f: FrameAt, ciphertext: Data) -> Data? {
    aesOpen(key: key, nonce: Data(count: 4) + u64(f.counter), aad: frameAad(f), ciphertext: ciphertext)
}

/// The announcement in a frame under the announcement key: only if it is
/// signed by a host on the list, for the session and key ID it came under.
func openAnnouncement(key: Data, _ f: FrameAt, ciphertext: Data, devices: Devices) -> Pirc_V1alpha2_AnnouncementBody? {
    guard let plain = openFrame(key: key, f, ciphertext: ciphertext),
          let obj = try? Pirc_V1alpha2_SignedObject(serializedBytes: plain),
          let body = Objects.open(Pirc_V1alpha2_AnnouncementBody.self, accountID: f.accountID, obj),
          devices.role(obj.signer) == .host, body.session == f.session, body.keyID == f.keyID
    else { return nil }
    return body
}

// --- bundles ---

private func wrapInfo(_ accountID: Data, _ hostKey: Data, _ keyID: Data, _ recipient: Data) -> Data {
    framed("pirc-e2e-v1 wrap", accountID, hostKey, keyID, recipient)
}

/// A bundle, if it is signed by a host on the list.
func openBundle(accountID: Data, _ obj: Pirc_V1alpha2_SignedObject, devices: Devices) -> Pirc_V1alpha2_BundleBody? {
    guard let body = Objects.open(Pirc_V1alpha2_BundleBody.self, accountID: accountID, obj), devices.role(obj.signer) == .host else { return nil }
    return body
}

/// This device's keys from a bundle whose signature has been checked:
/// only if every recipient is a client or read-only key on the list, and
/// recipients are in order. A read-only key gets the announcement key
/// alone, and a nil conversation key.
func unwrap(accountID: Data, _ bundle: Pirc_V1alpha2_BundleBody, devices: Devices, me: Me) -> (announcement: Data, conversation: Data?)? {
    for (i, r) in bundle.recipients.enumerated() {
        let role = devices.role(r.publicKey)
        guard role == .client || role == .readOnly else { return nil }
        if i > 0 && !before(bundle.recipients[i - 1].publicKey, r.publicKey) { return nil }
    }
    let preKey = me.preKey.publicKey.rawRepresentation
    guard let mine = bundle.recipients.first(where: { $0.publicKey == me.publicKey && $0.preKey == preKey }) else { return nil }
    let info = wrapInfo(accountID, bundle.hostKey, bundle.keyID, me.publicKey)
    guard let announcement = HPKE.open(me.preKey, info: info, aad: Data("announcement key".utf8), sealed: mine.announcementKey),
          announcement.count == 32
    else { return nil }
    if mine.conversationKey.isEmpty { return (announcement, nil) }
    guard let conversation = HPKE.open(me.preKey, info: info, aad: Data("conversation key".utf8), sealed: mine.conversationKey),
          conversation.count == 32
    else { return nil }
    return (announcement, conversation)
}

// --- labels ---

private func labelKeyParts(_ ref: Pirc_V1alpha2_LabelKeyRef) -> (Data, Data) {
    (u64(ref.version.number), ref.version.hash)
}

/// A label record's sealed field: a 12-byte nonce, then the ciphertext.
func openLabels(labelKey: Data, accountID: Data, _ ref: Pirc_V1alpha2_LabelKeyRef, counter: UInt64, sealed: Data) -> Pirc_V1alpha2_Labels? {
    guard sealed.count >= 12 + 16 else { return nil }
    let (n, h) = labelKeyParts(ref)
    let aad = framed("pirc-e2e-v1 labels", accountID, n, h, u64(counter))
    guard let plain = aesOpen(key: labelKey, nonce: Data(sealed.prefix(12)), aad: aad, ciphertext: Data(sealed.dropFirst(12))) else { return nil }
    return try? Pirc_V1alpha2_Labels(serializedBytes: plain)
}

func unwrapLabelKey(preKey: Curve25519.KeyAgreement.PrivateKey, accountID: Data, _ ref: Pirc_V1alpha2_LabelKeyRef, me: Data, wrap: Data) -> Data? {
    let (n, h) = labelKeyParts(ref)
    let k = HPKE.open(preKey, info: framed("pirc-e2e-v1 label-key", accountID, n, h, me), aad: Data(), sealed: wrap)
    return k?.count == 32 ? k : nil
}

extension Pirc_V1alpha2_Labels {
    /// A device's label, to title what its sessions send.
    func label(_ key: Data) -> String? {
        labels.first { $0.publicKey == key }?.label
    }
}
