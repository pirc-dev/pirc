// framed (docs/e2e.md, section 2): how every signed string is built, as
// e2e/framed.ts and app/lib/e2e/framed.dart build it.
//
// Nothing parses framed bytes: a reader builds the bytes it expects and
// compares.

/// A length as an unsigned LEB128.
func leb128(_ n: UInt64) -> [UInt8] {
    var n = n
    var out: [UInt8] = []
    repeat {
        let low = UInt8(n & 0x7F)
        n >>= 7
        out.append(n > 0 ? low | 0x80 : low)
    } while n > 0
    return out
}

/// The context's ASCII, a NUL byte, then each part prefixed by its length
/// as an unsigned LEB128. Throws an E2eCallError for a context that is
/// empty or holds a byte below 0x20 or above 0x7E (any character outside
/// ASCII among them).
func framed(_ context: String, _ parts: [[UInt8]]) throws -> [UInt8] {
    let ascii = Array(context.utf8)
    if ascii.isEmpty { throw E2eCallError("framed: empty context") }
    if ascii.contains(where: { $0 < 0x20 || $0 > 0x7E }) { throw E2eCallError("framed: a context byte outside 0x20 to 0x7E") }
    var out = ascii
    out.append(0)
    for p in parts {
        out += leb128(UInt64(p.count))
        out += p
    }
    return out
}

/// The limit of counters and ordering values: 2^63.
let numberLimit: UInt64 = 1 << 63

/// A number as a framed part holds it: 8 bytes, big-endian. Throws an
/// E2eCallError for a value of 2^63 or above.
func framedNumber(_ value: UInt64) throws -> [UInt8] {
    if value >= numberLimit { throw E2eCallError("framedNumber: outside 0 to 2^63-1") }
    return (0..<8).map { UInt8(truncatingIfNeeded: value >> (56 - 8 * UInt64($0))) }
}
