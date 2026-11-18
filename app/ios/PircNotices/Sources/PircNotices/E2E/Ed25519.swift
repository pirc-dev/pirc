// Ed25519, verified strictly and alike on every platform (docs/e2e.md,
// section 2): byte checks first, then CryptoKit's verify. The checks are
// crypto/ed25519.ts's, and cases/e2e/ed25519.json holds what every
// verifier must decide.

import CryptoKit
import Foundation

enum Ed25519 {
    private static func unhex(_ s: String) -> [UInt8] {
        var out: [UInt8] = []
        var i = s.startIndex
        while i < s.endIndex {
            let j = s.index(i, offsetBy: 2)
            out.append(UInt8(s[i..<j], radix: 16)!)
            i = j
        }
        return out
    }

    // The group order L and the field prime p, little-endian.
    private static let L = unhex("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010")
    private static let P = unhex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")

    // Every encoding of a small-order point once y < p is checked: the
    // eight canonical ones, and the two with x = 0 and the sign bit set.
    private static let smallOrder = [
        "0100000000000000000000000000000000000000000000000000000000000000",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
        "0100000000000000000000000000000000000000000000000000000000000080",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ].map(unhex)

    private static func lessLE(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        for i in stride(from: 31, through: 0, by: -1) where a[i] != b[i] { return a[i] < b[i] }
        return false
    }

    private static func pointOK(_ b: [UInt8]) -> Bool {
        var y = b
        y[31] &= 0x7f
        return lessLE(y, P) && !smallOrder.contains(b)
    }

    /// Nil if the signature may go to CryptoKit's verify, or why not.
    static func precheck(publicKey: Data, signature: Data) -> String? {
        guard publicKey.count == 32, signature.count == 64 else { return "length" }
        let a = [UInt8](publicKey), sig = [UInt8](signature)
        if !lessLE(Array(sig[32...]), L) { return "S is not below L" }
        if !pointOK(a) { return "the key is non-canonical or of small order" }
        if !pointOK(Array(sig[..<32])) { return "R is non-canonical or of small order" }
        return nil
    }

    static func verify(publicKey: Data, message: Data, signature: Data) -> Bool {
        guard precheck(publicKey: publicKey, signature: signature) == nil,
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey)
        else { return false }
        return key.isValidSignature(signature, for: message)
    }
}
