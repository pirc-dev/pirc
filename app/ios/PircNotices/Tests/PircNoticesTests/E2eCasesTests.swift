// The shared cases of cases/e2e/ (cases/README.md) that the notification
// extension runs: framed.json, list.json (all but the phone's maker), and
// the notices' opening in sealed.json. Each file's shape is checked as
// strictly as the TypeScript, Go and Dart runners check it, and the number
// of cases run is checked against a count made from the file.

import Foundation
import Testing

@testable import PircNotices

/// The parts the extension has: it checks lists in both modes and at a
/// join, and opens notices. It makes nothing and opens no announcements or
/// names.
let has: Set<String> = ["first-mode", "self", "notice"]

typealias Json = [String: Any]

enum CaseFileError: Error, CustomStringConvertible {
    case shape(String)
    var description: String {
        switch self { case let .shape(s): s }
    }
}

func unhex(_ v: Any?) throws -> [UInt8] {
    guard let s = v as? String, s.count % 2 == 0, s.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw CaseFileError.shape("not hex: \(String(describing: v))") }
    let chars = Array(s.utf8)
    return stride(from: 0, to: chars.count, by: 2).map { UInt8(String(decoding: chars[$0..<$0 + 2], as: UTF8.self), radix: 16)! }
}

func unhexData(_ v: Any?) throws -> Data { Data(try unhex(v)) }

func hex<S: Sequence>(_ b: S) -> String where S.Element == UInt8 {
    b.map { String(format: "%02x", $0) }.joined()
}

/// A decimal string of 0 to 2^64-1; anything else is a mistake in the file.
func u64(_ v: Any?) throws -> UInt64 {
    guard let s = v as? String, !s.isEmpty, s.allSatisfy(\.isASCII), s.allSatisfy(\.isNumber), let n = UInt64(s) else {
        throw CaseFileError.shape("not a 64-bit unsigned number: \(String(describing: v))")
    }
    return n
}

/// A JSON value's type, as the shape tables name it.
func typeName(_ v: Any) -> String {
    switch v {
    case is String: return "string"
    case is Bool: return "bool"
    case is Int: return "number"
    case is [Any]: return "array"
    case is [String: Any]: return "object"
    default: return "none"
    }
}

let keyTypes: [String: String] = [
    "check": "string", "about": "string", "context": "string", "value": "string", "bytes": "string",
    "phoneKey": "string", "mode": "string", "highest": "string", "accountId": "string", "seed": "string",
    "counter": "string", "previousBody": "string", "key": "string", "message": "string", "signature": "string",
    "sealed": "string", "recipientSecretKey": "string", "now": "string", "boxSecretKey": "string", "ordering": "string",
    "phoneSeed": "string", "phoneBoxSecretKey": "string",
    "needs": "array", "parts": "array", "devices": "array", "nonces": "array", "recipientSecretKeys": "array", "names": "array",
    "expect": "object", "go": "object", "self": "object", "slot": "object", "list": "object", "body": "object",
    "valid": "bool", "throws": "bool",
]

struct Shape {
    var required: [String]
    var optional: [String] = []
    var oneOf: [String] = []
    /// The keys expect (and go) may hold.
    var expectKeys: Set<String> = ["result", "reason", "counter", "hash", "list", "throws"]
}

let shapes: [String: Shape] = [
    "framed": Shape(required: ["check", "about", "needs", "context", "parts"], oneOf: ["bytes", "throws"]),
    "number": Shape(required: ["check", "about", "needs", "value"], oneOf: ["bytes", "throws"]),
    "list": Shape(required: ["check", "about", "needs", "bytes", "phoneKey", "mode", "highest", "expect"], optional: ["accountId", "self", "go"]),
    "make-list": Shape(required: ["check", "about", "needs", "seed", "accountId", "counter", "previousBody", "devices", "bytes"]),
    "verify": Shape(required: ["check", "about", "needs", "key", "message", "signature", "valid"]),
    "open": Shape(required: ["check", "about", "needs", "sealed", "slot", "recipientSecretKey", "list", "now", "expect"], optional: ["highest"],
                  expectKeys: ["result", "reason", "ordering", "body"]),
    "seal": Shape(required: ["check", "about", "needs", "list", "boxSecretKey", "slot", "ordering", "body", "nonces", "recipientSecretKeys", "expect"],
                  expectKeys: ["copies", "skipped", "opened", "throws"]),
]
let slotKeys: Set<String> = ["accountId", "computerKey", "sessionId", "kind"]
let deviceKeys: Set<String> = ["role", "signingKey", "channelKey", "boxKey", "readOnlyKey", "notificationKey"]
let listKeys: Set<String> = ["accountId", "counter", "previousHash", "devices"]

/// A need, and what in a case makes it need it.
let evidence: [String: (Json) -> Bool] = [
    "first-mode": { $0["mode"] as? String == "first" },
    "self": { $0["self"] != nil },
    "make-list": { $0["check"] as? String == "make-list" },
    "seal": { $0["check"] as? String == "seal" },
    "announcement": { $0["check"] as? String == "open" && ($0["slot"] as? Json)?["kind"] as? String == "announcement" },
    "notice": { $0["check"] as? String == "open" && ($0["slot"] as? Json)?["kind"] as? String == "notice" },
    "names": { $0["check"] as? String == "open-names" },
    "make-names": { $0["check"] as? String == "make-names" },
]

/// The checks each file this runner reads holds.
let checks: [String: Set<String>] = [
    "framed.json": ["framed", "number"],
    "list.json": ["list", "make-list", "verify"],
    "sealed.json": ["open", "seal"],
]

func hasExactly(_ v: Any?, _ keys: Set<String>) -> Bool {
    guard let o = v as? Json else { return false }
    return Set(o.keys) == keys
}

/// The file's cases, its shape checked: no unknown key, every needed key
/// present, needs exactly as the case shows them, at least one case.
func shapeChecked(_ name: String, _ data: Data) throws -> [Json] {
    func fail(_ why: String) -> CaseFileError { .shape("\(name): \(why)") }
    guard let file = try CaseReader.read(data) as? Json, Set(file.keys) == ["about", "cases"] else { throw fail("its keys are not about and cases") }
    guard let cases = file["cases"] as? [Any], !cases.isEmpty else { throw fail("no cases") }
    var out: [Json] = []
    for (i, any) in cases.enumerated() {
        func fail(_ why: String) -> CaseFileError { .shape("\(name), case \(i): \(why)") }
        guard let c = any as? Json else { throw fail("not an object") }
        guard let check = c["check"] as? String, checks[name]!.contains(check), let shape = shapes[check] else {
            throw fail("check \(String(describing: c["check"])) is not one of \(name)'s")
        }
        for k in shape.required where c[k] == nil { throw fail("no \(k)") }
        if !shape.oneOf.isEmpty && shape.oneOf.filter({ c[$0] != nil }).count != 1 { throw fail("not exactly one of \(shape.oneOf)") }
        let allowed = Set(shape.required + shape.optional + shape.oneOf)
        for (k, v) in c {
            if !allowed.contains(k) { throw fail("key \(k) is not a \(check) case's") }
            if typeName(v) != keyTypes[k] { throw fail("\(k) is \(typeName(v))") }
        }
        let needs = c["needs"] as! [Any]
        guard let named = needs as? [String] else { throw fail("a need is not a string") }
        for n in named where evidence[n] == nil { throw fail("unknown need \(n)") }
        for (need, shows) in evidence where named.contains(need) != shows(c) { throw fail("needs \(need) exactly when the case shows it") }
        for k in ["expect", "go"] {
            guard let e = c[k] as? Json else { continue }
            for ek in e.keys where !shape.expectKeys.contains(ek) { throw fail("unknown key \(k).\(ek)") }
            let standsFor = shape.expectKeys.contains("result") ? "result" : "copies"
            if (e[standsFor] != nil) == (e["throws"] != nil) { throw fail("\(k) has not exactly one of \(standsFor) and throws") }
            if let l = e["list"] {
                guard hasExactly(l, listKeys), let ds = (l as! Json)["devices"] as? [Any] else { throw fail("\(k).list's keys") }
                for d in ds where !hasExactly(d, deviceKeys) { throw fail("a listed device's keys") }
            }
        }
        for d in [c["self"]].compactMap({ $0 }) + (c["devices"] as? [Any] ?? []) where !hasExactly(d, deviceKeys) { throw fail("a device's keys") }
        if let slot = c["slot"], !hasExactly(slot, slotKeys) { throw fail("the slot's keys") }
        if let view = c["list"] {
            guard hasExactly(view, ["counter", "devices"]), let ds = (view as! Json)["devices"] as? [Any] else { throw fail("the list's keys") }
            for d in ds where !hasExactly(d, deviceKeys) { throw fail("a list device's keys") }
        }
        out.append(c)
    }
    return out
}

/// What a lone surrogate escape is read as: U+F8FF, which the files never
/// hold otherwise.
let loneSurrogate: Unicode.Scalar = "\u{F8FF}"

/// A JSON reader for the case files, since Foundation's drops a U+FEFF at
/// the start of a string and refuses a lone surrogate escape (a \\ud800 not
/// followed by a low one, or a low one alone). It reads strings, integers,
/// true, false, null, arrays and objects, and reads a lone surrogate as
/// loneSurrogate: the files hold them only in text a computer is given to
/// seal, and readCases makes sure no case this runner runs holds one.
struct CaseReader {
    let b: [UInt8]
    var i = 0

    static func read(_ data: Data) throws -> Any {
        var r = CaseReader(b: [UInt8](data))
        guard isUTF8(r.b), !String(decoding: r.b, as: UTF8.self).unicodeScalars.contains(loneSurrogate) else { throw CaseFileError.shape("not UTF-8, or holds U+F8FF") }
        let v = try r.value()
        r.space()
        guard r.i == r.b.count else { throw r.fail("text after the value") }
        return v
    }

    func fail(_ why: String) -> CaseFileError { .shape("JSON at byte \(i): \(why)") }

    mutating func space() {
        while i < b.count, [0x20, 0x09, 0x0A, 0x0D].contains(b[i]) { i += 1 }
    }

    mutating func literal(_ word: String) -> Bool {
        let w = Array(word.utf8)
        guard i + w.count <= b.count, Array(b[i..<(i + w.count)]) == w else { return false }
        i += w.count
        return true
    }

    mutating func value() throws -> Any {
        space()
        guard i < b.count else { throw fail("end of text") }
        switch b[i] {
        case UInt8(ascii: "{"):
            i += 1
            var o: [String: Any] = [:]
            space()
            if i < b.count, b[i] == UInt8(ascii: "}") { i += 1; return o }
            while true {
                space()
                let k = try string()
                space()
                guard i < b.count, b[i] == UInt8(ascii: ":") else { throw fail("no colon") }
                i += 1
                guard o.updateValue(try value(), forKey: k) == nil else { throw fail("key \(k) twice") }
                space()
                guard i < b.count else { throw fail("end of text") }
                i += 1
                if b[i - 1] == UInt8(ascii: "}") { return o }
                guard b[i - 1] == UInt8(ascii: ",") else { throw fail("no comma") }
            }
        case UInt8(ascii: "["):
            i += 1
            var a: [Any] = []
            space()
            if i < b.count, b[i] == UInt8(ascii: "]") { i += 1; return a }
            while true {
                a.append(try value())
                space()
                guard i < b.count else { throw fail("end of text") }
                i += 1
                if b[i - 1] == UInt8(ascii: "]") { return a }
                guard b[i - 1] == UInt8(ascii: ",") else { throw fail("no comma") }
            }
        case UInt8(ascii: "\""):
            return try string()
        default:
            if literal("true") { return true }
            if literal("false") { return false }
            if literal("null") { return NSNull() }
            let start = i
            if i < b.count, b[i] == UInt8(ascii: "-") { i += 1 }
            while i < b.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(b[i]) { i += 1 }
            guard let n = Int(String(decoding: b[start..<i], as: UTF8.self)) else { throw fail("not a value the files hold") }
            return n
        }
    }

    mutating func hex4() throws -> UInt32 {
        guard i + 4 <= b.count, let u = UInt32(String(decoding: b[i..<(i + 4)], as: UTF8.self), radix: 16) else { throw fail("a bad \\u escape") }
        i += 4
        return u
    }

    mutating func string() throws -> String {
        guard i < b.count, b[i] == UInt8(ascii: "\"") else { throw fail("not a string") }
        i += 1
        var s = String.UnicodeScalarView()
        var raw: [UInt8] = []
        func flush() {
            s.append(contentsOf: String(decoding: raw, as: UTF8.self).unicodeScalars)
            raw = []
        }
        while true {
            guard i < b.count else { throw fail("end of text in a string") }
            let c = b[i]
            i += 1
            if c == UInt8(ascii: "\"") { break }
            guard c == UInt8(ascii: "\\") else {
                guard c >= 0x20 else { throw fail("a control character in a string") }
                raw.append(c)
                continue
            }
            flush()
            guard i < b.count else { throw fail("end of text in a string") }
            let e = b[i]
            i += 1
            switch e {
            case UInt8(ascii: "\""): s.append("\"")
            case UInt8(ascii: "\\"): s.append("\\")
            case UInt8(ascii: "/"): s.append("/")
            case UInt8(ascii: "b"): s.append("\u{8}")
            case UInt8(ascii: "f"): s.append("\u{C}")
            case UInt8(ascii: "n"): s.append("\n")
            case UInt8(ascii: "r"): s.append("\r")
            case UInt8(ascii: "t"): s.append("\t")
            case UInt8(ascii: "u"):
                let u = try hex4()
                if (0xD800...0xDBFF).contains(u), i + 6 <= b.count, b[i] == UInt8(ascii: "\\"), b[i + 1] == UInt8(ascii: "u") {
                    let back = i
                    i += 2
                    let low = try hex4()
                    if (0xDC00...0xDFFF).contains(low) {
                        s.append(Unicode.Scalar(0x10000 + ((u - 0xD800) << 10) + (low - 0xDC00))!)
                        continue
                    }
                    i = back
                }
                s.append(Unicode.Scalar(u) ?? loneSurrogate)
            default:
                throw fail("a bad escape")
            }
        }
        flush()
        return String(s)
    }
}

/// Whether a JSON value holds a lone surrogate, as readable wrote it.
func holdsLoneSurrogate(_ v: Any) -> Bool {
    switch v {
    case let s as String: return s.unicodeScalars.contains(loneSurrogate)
    case let a as [Any]: return a.contains(where: holdsLoneSurrogate)
    case let o as [String: Any]: return o.keys.contains(where: holdsLoneSurrogate) || o.values.contains(where: holdsLoneSurrogate)
    default: return false
    }
}

func readCases(_ name: String) throws -> [Json] {
    try checkedCases(name, Data(contentsOf: repo.appendingPathComponent("cases/e2e/" + name)))
}

/// The file's cases, its shape checked, and none this runner runs holding
/// a lone surrogate.
func checkedCases(_ name: String, _ data: Data) throws -> [Json] {
    let cases = try shapeChecked(name, data)
    if let c = cases.first(where: { runnable($0) && holdsLoneSurrogate($0) }) {
        throw CaseFileError.shape("\(name): \(c["about"] as! String) holds a lone surrogate, which this runner cannot read")
    }
    return cases
}

func runnable(_ c: Json) -> Bool {
    (c["needs"] as! [String]).allSatisfy(has.contains)
}

func device(_ v: Any?) throws -> DeviceKeys {
    let d = v as! Json
    guard let role = (d["role"] as? Int).flatMap({ UInt32(exactly: $0) }) else { throw CaseFileError.shape("a role: \(String(describing: d["role"]))") }
    return DeviceKeys(role: role, signingKey: try unhexData(d["signingKey"]), channelKey: try unhexData(d["channelKey"]), boxKey: try unhexData(d["boxKey"]),
                      readOnlyKey: try unhexData(d["readOnlyKey"]), notificationKey: try unhexData(d["notificationKey"]))
}

func deviceJson(_ d: DeviceKeys) -> Json {
    ["role": Int(d.role), "signingKey": hex(d.signingKey), "channelKey": hex(d.channelKey), "boxKey": hex(d.boxKey),
     "readOnlyKey": hex(d.readOnlyKey), "notificationKey": hex(d.notificationKey)]
}

/// A check's result as the files write it.
func expectOf(_ r: ListResult) -> Json {
    switch r {
    case let .accepted(l, counter, hash):
        return ["result": "accepted", "counter": String(counter), "hash": hex(hash),
                "list": ["accountId": hex(l.accountId), "counter": String(l.counter), "previousHash": hex(l.previousHash), "devices": l.devices.map(deviceJson)]]
    case let .old(counter, hash):
        return ["result": "old", "counter": String(counter), "hash": hex(hash)]
    case let .unsupported(reason, counter, hash):
        return ["result": "unsupported", "reason": reason.rawValue, "counter": String(counter), "hash": hex(hash)]
    case let .refused(reason):
        return ["result": "refused", "reason": reason.rawValue]
    }
}

/// An opened notice as the files write it.
func expectOf(_ r: NoticeResult) -> Json {
    switch r {
    case let .accepted(ordering, body):
        return ["result": "accepted", "ordering": String(ordering), "body": ["sessionName": body.sessionName, "computerName": body.computerName, "notice": body.notice]]
    case let .refused(reason):
        return ["result": "refused", "reason": reason.rawValue]
    }
}

func same(_ got: Json, _ want: Any?) -> Bool {
    guard let want = want as? Json else { return false }
    return NSDictionary(dictionary: got).isEqual(to: want)
}

func slot(_ v: Any?) throws -> Slot {
    let s = v as! Json
    return Slot(accountId: try unhexData(s["accountId"]), computerKey: try unhexData(s["computerKey"]), sessionId: try unhexData(s["sessionId"]))
}

func listView(_ v: Any?) throws -> DeviceList {
    let l = v as! Json
    return DeviceList(counter: try u64(l["counter"]), devices: try (l["devices"] as! [Any]).map(device))
}

/// One case's outcome: what it is, and why it failed, or nil.
struct Outcome {
    let about: String
    let failure: String?
}

func runFramed(_ cases: [Json]) throws -> [Outcome] {
    try cases.filter(runnable).map { c in
        let run: () throws -> [UInt8] = c["check"] as! String == "framed"
            ? { [parts = try (c["parts"] as! [Any]).map(unhex)] in try framed(c["context"] as! String, parts) }
            : { [value = try u64(c["value"])] in try framedNumber(value) }
        let failure: String?
        if c["throws"] != nil {
            do {
                _ = try run()
                failure = "did not throw"
            } catch is E2eCallError {
                failure = nil
            }
        } else {
            let got = hex(try run())
            failure = got == c["bytes"] as! String ? nil : "gave \(got)"
        }
        return Outcome(about: c["about"] as! String, failure: failure)
    }
}

func runList(_ cases: [Json]) throws -> [Outcome] {
    try cases.filter(runnable).map { c in
        let about = c["about"] as! String
        switch c["check"] as! String {
        case "verify":
            let got = Sodium.verify(signature: try unhex(c["signature"]), message: try unhex(c["message"]), key: try unhex(c["key"]))
            return Outcome(about: about, failure: got == c["valid"] as! Bool ? nil : "verify gave \(got)")
        case "list":
            let mode: ListMode
            switch c["mode"] as! String {
            case "first": mode = .first
            case "later": mode = .later
            case let m: return Outcome(about: about, failure: "unknown mode \(m)")
            }
            let bytes = try unhexData(c["bytes"]), phoneKey = try unhexData(c["phoneKey"]), highest = try u64(c["highest"])
            let accountId = try c["accountId"].map(unhexData)
            let joining = try c["self"].map(device)
            let want = c["expect"] as! Json
            if want["throws"] != nil {
                do {
                    _ = try checkList(bytes: bytes, phoneKey: phoneKey, mode: mode, accountId: accountId, highest: highest, joining: joining)
                    return Outcome(about: about, failure: "did not throw")
                } catch is E2eCallError {
                    return Outcome(about: about, failure: nil)
                }
            }
            let got = expectOf(try checkList(bytes: bytes, phoneKey: phoneKey, mode: mode, accountId: accountId, highest: highest, joining: joining))
            return Outcome(about: about, failure: same(got, want) ? nil : "gave \(got)")
        case let check:
            return Outcome(about: about, failure: "\(check) needs only what the extension has, but it does not run it")
        }
    }
}

func runSealed(_ cases: [Json]) throws -> [Outcome] {
    try cases.filter(runnable).map { c in
        let about = c["about"] as! String
        guard c["check"] as! String == "open", (c["slot"] as! Json)["kind"] as! String == "notice" else {
            return Outcome(about: about, failure: "needs only what the extension has, but is not a notice's opening")
        }
        let got = try openNotice(sealed: unhexData(c["sealed"]), slot: slot(c["slot"]), recipientSecretKey: unhexData(c["recipientSecretKey"]),
                                 list: listView(c["list"]), highest: c["highest"].map(u64), now: u64(c["now"]))
        return Outcome(about: about, failure: same(expectOf(got), c["expect"]) ? nil : "gave \(expectOf(got))")
    }
}

func failures(_ outcomes: [Outcome]) -> [String] {
    outcomes.compactMap { o in o.failure.map { "\(o.about): \($0)" } }
}

struct E2eCasesTests {
    @Test func framedFile() throws {
        let cases = try readCases("framed.json")
        let outcomes = try runFramed(cases)
        #expect(failures(outcomes) == [])
        // framed needs no part: every case runs.
        #expect(outcomes.count == cases.count)
    }

    @Test func listFile() throws {
        let cases = try readCases("list.json")
        let outcomes = try runList(cases)
        #expect(failures(outcomes) == [])
        // Only the phone's maker is left out.
        #expect(outcomes.count == cases.count - cases.filter { $0["check"] as? String == "make-list" }.count)
        #expect(outcomes.count > 90)
    }

    @Test func sealedFile() throws {
        let cases = try readCases("sealed.json")
        let outcomes = try runSealed(cases)
        #expect(failures(outcomes) == [])
        // Only the notices' opening runs: announcements and sealing are left out.
        let notices = cases.filter { $0["check"] as? String == "open" && ($0["slot"] as? Json)?["kind"] as? String == "notice" }
        #expect(outcomes.count == notices.count)
        #expect(outcomes.count > 60)
    }

    @Test func aFileOfAnotherShapeFails() throws {
        func refused(_ name: String, _ text: String) -> Bool {
            do {
                _ = try shapeChecked(name, Data(text.utf8))
                return false
            } catch is CaseFileError {
                return true
            } catch {
                return false
            }
        }
        for name in ["framed.json", "list.json", "sealed.json"] {
            #expect(refused(name, #"{"about": "x", "cases": []}"#), Comment(rawValue: name))
            #expect(refused(name, #"{"about": "x"}"#), Comment(rawValue: name))
            #expect(refused(name, #"{"about": "x", "cases": [], "more": 1}"#), Comment(rawValue: name))
        }
        let good = #"{"check": "number", "about": "1", "needs": [], "value": "1", "bytes": "0000000000000001"}"#
        #expect(!refused("framed.json", #"{"about": "x", "cases": [\#(good)]}"#))
        // An unknown key; a need the case does not show; a need it shows but
        // does not name; a check of another file; two of oneOf.
        #expect(refused("framed.json", #"{"about": "x", "cases": [{"check": "number", "about": "1", "needs": [], "value": "1", "bytes": "00", "x": 1}]}"#))
        #expect(refused("framed.json", #"{"about": "x", "cases": [{"check": "number", "about": "1", "needs": ["self"], "value": "1", "bytes": "00"}]}"#))
        #expect(refused("framed.json", #"{"about": "x", "cases": [{"check": "number", "about": "1", "needs": ["other"], "value": "1", "bytes": "00"}]}"#))
        #expect(refused("framed.json", #"{"about": "x", "cases": [{"check": "verify", "about": "1", "needs": [], "key": "", "message": "", "signature": "", "valid": true}]}"#))
        #expect(refused("framed.json", #"{"about": "x", "cases": [{"check": "number", "about": "1", "needs": [], "value": "1", "bytes": "00", "throws": true}]}"#))
        #expect(refused("framed.json", #"{"about": "x", "cases": [{"check": "number", "about": "1", "needs": [], "value": 1, "bytes": "00"}]}"#))
        // A notice's opening that does not name the need, and one in first mode that does not.
        let sealed = try readCases("sealed.json").first { ($0["slot"] as? Json)?["kind"] as? String == "notice" }!
        var unnamed = sealed
        unnamed["needs"] = [String]()
        let unnamedFile = try JSONSerialization.data(withJSONObject: ["about": "x", "cases": [unnamed]])
        #expect(refused("sealed.json", String(decoding: unnamedFile, as: UTF8.self)))
        let list = try readCases("list.json").first { $0["mode"] as? String == "first" && $0["self"] == nil }!
        var unnamedList = list
        unnamedList["needs"] = [String]()
        let unnamedListFile = try JSONSerialization.data(withJSONObject: ["about": "x", "cases": [unnamedList]])
        #expect(refused("list.json", String(decoding: unnamedListFile, as: UTF8.self)))
    }

    @Test func theReaderKeepsWhatFoundationsDrops() throws {
        let v = try CaseReader.read(Data(#"{"a": "\ufeffx", "b": "\ud800", "c": "\ud83d\ude00\n\"\\/", "d": "\udc00\ud800y", "e": [1, -2, true, false, null]}"#.utf8)) as! Json
        #expect(v["a"] as? String == "\u{FEFF}x")
        #expect((v["a"] as? String)?.unicodeScalars.count == 2)
        #expect(v["b"] as? String == String(loneSurrogate))
        #expect(v["c"] as? String == "\u{1F600}\n\"\\/")
        #expect(v["d"] as? String == String(loneSurrogate) + String(loneSurrogate) + "y")
        #expect((v["e"] as? [Any])?.map(typeName) == ["number", "number", "bool", "bool", "none"])
        let raw = try CaseReader.read(Data("{\"a\": \"\u{FEFF}x\"}".utf8)) as! Json
        #expect((raw["a"] as? String)?.unicodeScalars.first == "\u{FEFF}")
        for bad in [#"{"a": 1} 2"#, #"{"a": 1, "a": 2}"#, #"{"a" 1}"#, #"{"a": "\x"}"#, #"["a" "b"]"#, #"1.5"#, "{\"a\": \"\u{F8FF}\"}", "\"\u{1}\""] {
            #expect(throws: CaseFileError.self, Comment(rawValue: bad)) { try CaseReader.read(Data(bad.utf8)) }
        }
        // A case this runner runs that holds a lone surrogate fails the file;
        // one it does not run is read.
        let notice = try readCases("sealed.json").first { ($0["slot"] as? Json)?["kind"] as? String == "notice" }!
        let file = String(decoding: try JSONSerialization.data(withJSONObject: ["about": "x", "cases": [notice]]), as: UTF8.self)
        #expect(try checkedCases("sealed.json", Data(file.utf8)).count == 1)
        let held = file.replacingOccurrences(of: #""about":""#, with: #""about":"\ud800"#)
        #expect(held != file)
        #expect(throws: CaseFileError.self) { try checkedCases("sealed.json", Data(held.utf8)) }
        let seal = try readCases("sealed.json").first { $0["check"] as? String == "seal" }!
        let sealFile = String(decoding: try JSONSerialization.data(withJSONObject: ["about": "x", "cases": [seal]]), as: UTF8.self)
            .replacingOccurrences(of: #""about":""#, with: #""about":"\ud800"#)
        #expect(try checkedCases("sealed.json", Data(sealFile.utf8)).count == 1)
    }

    @Test func aNumberOf2To64InAFileIsItsMistake() throws {
        #expect(throws: CaseFileError.self) { try u64("18446744073709551616") }
        #expect(throws: CaseFileError.self) { try u64("-1") }
        #expect(throws: CaseFileError.self) { try u64("+1") }
        #expect(try u64("18446744073709551615") == UInt64.max)
    }
}
