// Notifications, written from the latest notice the host put in a
// session's announcement: which sessions have one not yet shown, and its
// title and text. A port of web/core/notices.ts and the parts of
// web/core/names.ts it uses, held to the same cases (cases/notices).

import Foundation

/// What was last shown: for each session, by `Session.id`, the number of
/// its latest notice; and when the list was last read, by the host's clock,
/// in milliseconds. The Dart app writes the same.
public struct Shown: Codable, Equatable, Sendable {
    public var numbers: [String: UInt64]
    public var since: UInt64?

    public init(numbers: [String: UInt64] = [:], since: UInt64? = nil) {
        self.numbers = numbers
        self.since = since
    }
}

/// A notification to post, for the session `session`.
public struct Note: Equatable, Sendable {
    public let session: String
    public let title: String
    public let body: String
}

/// A session's latest notice.
public struct Notice: Codable, Equatable, Sendable {
    public var number: UInt64
    /// "finished", "failed" or "question".
    public var kind: String
    public var text: String
}

/// What the notifications need of a live session, as web/core's
/// SessionView has it.
public struct Session: Codable, Equatable, Sendable {
    /// The pi process's ID: its host key's first 8 bytes in hex, "-", its
    /// instance ID, as web/core's viewId.
    public var id: String
    public var name: String
    public var first: String?
    public var cwd: String
    public var hostLabel: String
    public var hostname: String
    public var notice: Notice?
}

/// Cut to n Unicode code points, "…" included, as the host cuts a notice.
public func cut(_ s: String, _ n: Int) -> String {
    let points = Array(s.unicodeScalars)
    guard points.count > n else { return s }
    var head = String(String.UnicodeScalarView(points.prefix(n - 1)))
    while let last = head.unicodeScalars.last, isJSWhitespace(last) {
        head.unicodeScalars.removeLast()
    }
    return head + "…"
}

// What JavaScript's trim takes away, which is what web/core does.
private func isJSWhitespace(_ c: Unicode.Scalar) -> Bool {
    c.properties.isWhitespace || c == "\u{FEFF}"
}

private func trimJS(_ s: String) -> String {
    var u = s.unicodeScalars[...]
    while let f = u.first, isJSWhitespace(f) { u.removeFirst() }
    while let l = u.last, isJSWhitespace(l) { u.removeLast() }
    return String(String.UnicodeScalarView(u))
}

/// The last part of a folder, as web/core's folder.
public func folder(_ cwd: String) -> String {
    cwd.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? (cwd.isEmpty ? "pi" : cwd)
}

/// What a session is called: pi's name for it, its first message, or its
/// folder, as web/core's title.
public func title(_ s: Session) -> String {
    let name = trimJS(s.name)
    if !name.isEmpty { return name }
    if let first = s.first, !first.isEmpty { return first }
    return folder(s.cwd)
}

/// The session's title and host, and what its notice says; none when it
/// has no notice.
public func notification(_ s: Session) -> (title: String, body: String)? {
    guard let n = s.notice else { return nil }
    let body: String
    switch n.kind {
    case "failed": body = "Failed: " + (n.text.isEmpty ? "pi gave no reason" : n.text)
    case "question": body = "Asks: " + (n.text.isEmpty ? "a question in pi's terminal" : n.text)
    default: body = n.text.isEmpty ? "Finished" : n.text
    }
    let host = s.hostLabel.isEmpty ? s.hostname : s.hostLabel
    return (cut([title(s), host].filter { !$0.isEmpty }.joined(separator: " · "), 80), body)
}

/// The sessions whose notice is past the last shown for them, and the
/// numbers shown once they are: one for each session listed, 0 for one
/// with no notice yet. A session seen for the first time is not news,
/// unless since is given and its notice is later; one no longer listed is
/// forgotten.
public func news(_ shown: [String: UInt64], _ sessions: [Session], since: UInt64? = nil) -> (notify: [Session], shown: [String: UInt64]) {
    var notify: [Session] = []
    var next: [String: UInt64] = [:]
    for s in sessions {
        let number = s.notice?.number ?? 0
        let last = shown[s.id] ?? since ?? number
        if number > last { notify.append(s) }
        next[s.id] = max(number, shown[s.id] ?? 0)
    }
    return (notify, next)
}
