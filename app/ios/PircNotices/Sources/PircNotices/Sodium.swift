// The libsodium calls the checks make, through swift-sodium's C module:
// its Swift API has no SHA-256, and the checks need to see every length
// before C reads a buffer.

import Foundation
import _Clibsodium

enum Sodium {
    static let signatureBytes = Int(crypto_sign_BYTES)
    static let signKeyBytes = Int(crypto_sign_PUBLICKEYBYTES)
    static let boxKeyBytes = Int(crypto_box_PUBLICKEYBYTES)
    static let boxSecretKeyBytes = Int(crypto_box_SECRETKEYBYTES)
    static let nonceBytes = Int(crypto_box_NONCEBYTES)
    static let macBytes = Int(crypto_box_MACBYTES)

    /// libsodium started, once for the process. sodium_init is safe to call
    /// from any thread and fails only when the system has no random source.
    private static let started: Void = {
        precondition(sodium_init() >= 0, "libsodium did not start")
    }()

    static func start() {
        _ = started
    }

    /// SHA-256 of the bytes.
    static func sha256(_ message: [UInt8]) -> [UInt8] {
        start()
        var out = [UInt8](repeating: 0, count: Int(crypto_hash_sha256_BYTES))
        let rc = crypto_hash_sha256(&out, message, UInt64(message.count))
        precondition(rc == 0, "crypto_hash_sha256 failed")
        return out
    }

    /// Whether the detached Ed25519 signature verifies over the message
    /// under the key; false for a signature or key of the wrong length.
    static func verify(signature: [UInt8], message: [UInt8], key: [UInt8]) -> Bool {
        start()
        guard signature.count == signatureBytes, key.count == signKeyBytes else { return false }
        return crypto_sign_verify_detached(signature, message, UInt64(message.count), key) == 0
    }

    /// The plaintext of a box (the MAC, then the ciphertext) from the
    /// sender's public key to the recipient's secret key, or nil: for a box
    /// that does not open, a key of the wrong length, or a pair of keys
    /// libsodium refuses (an all-zero shared point).
    /// The secret key is read where it lies, never copied.
    static func boxOpen(_ box: ArraySlice<UInt8>, nonce: ArraySlice<UInt8>, publicKey: [UInt8], secretKey: Data) -> [UInt8]? {
        start()
        guard box.count >= macBytes, nonce.count == nonceBytes, publicKey.count == boxKeyBytes, secretKey.count == boxSecretKeyBytes else {
            return nil
        }
        let box = Array(box)
        let nonce = Array(nonce)
        var out = [UInt8](repeating: 0, count: box.count - macBytes)
        let rc = secretKey.withUnsafeBytes { sk in
            crypto_box_open_easy(&out, box, UInt64(box.count), nonce, publicKey, sk.bindMemory(to: UInt8.self).baseAddress!)
        }
        return rc == 0 ? out : nil
    }
}
