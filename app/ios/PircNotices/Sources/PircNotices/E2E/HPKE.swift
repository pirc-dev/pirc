// AES-256-GCM, and HPKE's base mode with DHKEM(X25519, HKDF-SHA256),
// HKDF-SHA256 and AES-256-GCM (RFC 9180), single-shot and opening only,
// from CryptoKit's primitives: CryptoKit's own HPKE needs iOS 17, and the
// extension's target is 16. A port of crypto/hpke.ts, held to the CFRG's
// vector in cases/e2e/hpke.json.

import CryptoKit
import Foundation

/// Nil when it does not open. The ciphertext ends with its 16-byte tag.
func aesOpen(key: Data, nonce: Data, aad: Data, ciphertext: Data) -> Data? {
    guard key.count == 32, ciphertext.count >= 16,
          let n = try? AES.GCM.Nonce(data: nonce),
          let box = try? AES.GCM.SealedBox(nonce: n, ciphertext: ciphertext.dropLast(16), tag: ciphertext.suffix(16))
    else { return nil }
    return try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
}

enum HPKE {
    private static let kemSuite = Data("KEM".utf8) + [0x00, 0x20]
    private static let hpkeSuite = Data("HPKE".utf8) + [0x00, 0x20, 0x00, 0x01, 0x00, 0x02]
    private static let v1 = Data("HPKE-v1".utf8)

    // HKDF-Extract with an empty salt is HMAC under 32 zero bytes, as RFC
    // 5869 has it; HMAC pads the empty key to the same.
    private static func labeledExtract(_ suite: Data, salt: Data, _ label: String, _ ikm: Data) -> Data {
        let prk = HKDF<SHA256>.extract(inputKeyMaterial: SymmetricKey(data: v1 + suite + Data(label.utf8) + ikm), salt: salt)
        return Data(prk)
    }

    private static func labeledExpand(_ suite: Data, _ prk: Data, _ label: String, _ info: Data, _ length: Int) -> Data {
        let labeled = Data([UInt8(length >> 8), UInt8(length & 0xff)]) + v1 + suite + Data(label.utf8) + info
        let okm = HKDF<SHA256>.expand(pseudoRandomKey: prk, info: labeled, outputByteCount: length)
        return okm.withUnsafeBytes { Data($0) }
    }

    /// The key schedule's outputs, from the X25519 value: the shared
    /// secret, the AEAD key and the base nonce.
    static func schedule(dh: Data, enc: Data, recipient: Data, info: Data) -> (sharedSecret: Data, key: Data, baseNonce: Data) {
        let prk = labeledExtract(kemSuite, salt: Data(), "eae_prk", dh)
        let shared = labeledExpand(kemSuite, prk, "shared_secret", enc + recipient, 32)
        let context = Data([0x00]) + labeledExtract(hpkeSuite, salt: Data(), "psk_id_hash", Data())
            + labeledExtract(hpkeSuite, salt: Data(), "info_hash", info)
        let secret = labeledExtract(hpkeSuite, salt: shared, "secret", Data())
        return (shared, labeledExpand(hpkeSuite, secret, "key", context, 32), labeledExpand(hpkeSuite, secret, "base_nonce", context, 12))
    }

    /// Opens enc (32 bytes) followed by the ciphertext; nil when it does
    /// not open, or when X25519 gives the all-zero value.
    static func open(_ recipient: Curve25519.KeyAgreement.PrivateKey, info: Data, aad: Data, sealed: Data) -> Data? {
        guard sealed.count >= 32 + 16 else { return nil }
        let enc = Data(sealed.prefix(32))
        guard let pk = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: enc),
              let ss = try? recipient.sharedSecretFromKeyAgreement(with: pk)
        else { return nil }
        let dh = ss.withUnsafeBytes { Data($0) }
        guard dh.contains(where: { $0 != 0 }) else { return nil }
        let s = schedule(dh: dh, enc: enc, recipient: recipient.publicKey.rawRepresentation, info: info)
        return aesOpen(key: s.key, nonce: s.baseNonce, aad: aad, ciphertext: Data(sealed.dropFirst(32)))
    }
}
