// Byte and text helpers shared by the checks (e2e/bytes.ts,
// app/lib/e2e/bytes.dart).

import Foundation

/// A caller's mistake in what it passed to a check, or to framed. No input
/// bytes give one: they give a result.
public struct E2eCallError: Error, Equatable, CustomStringConvertible {
    public let description: String

    init(_ description: String) {
        self.description = description
    }
}

/// Whether two byte sequences hold the same bytes, in time that depends on
/// their lengths only.
func bytesEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    guard a.count == b.count else { return false }
    var d: UInt8 = 0
    for i in 0..<a.count {
        d |= a[i] ^ b[i]
    }
    return d == 0
}

/// Whether the bytes are well-formed UTF-8, as the Unicode Standard's table
/// 3-7 defines it: no overlong form, no surrogate, nothing above U+10FFFF,
/// no sequence cut short. Written out rather than left to Foundation, whose
/// decoders replace what is malformed or read a leading byte-order mark.
func isUTF8(_ b: [UInt8]) -> Bool {
    var i = 0
    let n = b.count
    /// Whether b[at] is a continuation byte within lo...hi.
    func cont(_ at: Int, _ lo: UInt8 = 0x80, _ hi: UInt8 = 0xBF) -> Bool {
        at < n && b[at] >= lo && b[at] <= hi
    }
    while i < n {
        let c = b[i]
        switch c {
        case 0x00...0x7F:
            i += 1
        case 0xC2...0xDF:
            guard cont(i + 1) else { return false }
            i += 2
        case 0xE0:
            guard cont(i + 1, 0xA0, 0xBF), cont(i + 2) else { return false }
            i += 3
        case 0xE1...0xEC, 0xEE...0xEF:
            guard cont(i + 1), cont(i + 2) else { return false }
            i += 3
        case 0xED:
            guard cont(i + 1, 0x80, 0x9F), cont(i + 2) else { return false }
            i += 3
        case 0xF0:
            guard cont(i + 1, 0x90, 0xBF), cont(i + 2), cont(i + 3) else { return false }
            i += 4
        case 0xF1...0xF3:
            guard cont(i + 1), cont(i + 2), cont(i + 3) else { return false }
            i += 4
        case 0xF4:
            guard cont(i + 1, 0x80, 0x8F), cont(i + 2), cont(i + 3) else { return false }
            i += 4
        default:
            return false
        }
    }
    return true
}

/// The text of valid UTF-8, or nil. A leading U+FEFF is text like any
/// other, as every language reads it.
func utf8Text(_ b: [UInt8]) -> String? {
    guard isUTF8(b) else { return nil }
    // Well-formed, so decoding replaces nothing.
    return String(decoding: b, as: UTF8.self)
}
