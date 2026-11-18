// The one way PiRC frames strings for signing, HKDF's and HPKE's info and
// AES-GCM's additional data (docs/e2e.md, section 2, "Exact bytes"): the
// context's ASCII, a NUL byte, then each part prefixed by its length as an
// unsigned LEB128. A port of crypto/bytes.ts.

import Foundation

func leb128(_ n: Int) -> Data {
    precondition(n >= 0)
    var n = UInt64(n)
    var out = Data()
    repeat {
        out.append(n < 128 ? UInt8(n) : UInt8(n & 0x7f) | 0x80)
        n >>= 7
    } while n > 0
    return out
}

func framed(_ context: String, _ parts: Data...) -> Data {
    framed(context, parts)
}

func framed(_ context: String, _ parts: [Data]) -> Data {
    var out = Data(context.utf8)
    out.append(0)
    for p in parts {
        out.append(leb128(p.count))
        out.append(p)
    }
    return out
}

/// 8 bytes big-endian.
func u64(_ n: UInt64) -> Data {
    withUnsafeBytes(of: n.bigEndian) { Data($0) }
}

/// Bytewise order, for the lists that are kept sorted by key.
func before(_ a: Data, _ b: Data) -> Bool {
    a.lexicographicallyPrecedes(b)
}
