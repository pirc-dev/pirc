// The shared cases every client passes (cases/README.md): the notices'
// functions, and the sessions a session list makes, by the same IDs as
// web/core's, which the Dart app keys the same shown numbers by.

import Foundation
import Testing

@testable import PircNotices

/// The repository's root, from this file's place in it.
let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

func json(_ path: String) throws -> [String: Any] {
    let d = try Data(contentsOf: repo.appendingPathComponent(path))
    return try JSONSerialization.jsonObject(with: d) as! [String: Any]
}

/// A SessionView's JSON as the package's Session.
func session(_ v: Any) throws -> Session {
    let d = try JSONSerialization.data(withJSONObject: v)
    return try JSONDecoder().decode(Session.self, from: d)
}

func numbers(_ v: Any) -> [String: UInt64] {
    (v as! [String: Any]).mapValues { ($0 as! NSNumber).uint64Value }
}

struct CasesTests {
    @Test func notices() throws {
        for file in ["cases/notices/news.json", "cases/notices/notifications.json"] {
            let cases = try json(file)["cases"] as! [[String: Any]]
            #expect(!cases.isEmpty)
            for c in cases {
                let about = "\(file): \(c["about"] as! String)"
                let args = c["args"] as! [Any]
                switch c["fn"] as! String {
                case "news":
                    let since = args.count > 2 ? (args[2] as? NSNumber)?.uint64Value : nil
                    let got = news(numbers(args[0]), try (args[1] as! [Any]).map(session), since: since)
                    let want = c["is"] as! [String: Any]
                    #expect(got.notify.map(\.id) == want["notify"] as! [String], Comment(rawValue: about))
                    #expect(got.shown == numbers(want["shown"]!), Comment(rawValue: about))
                case "notification":
                    let got = notification(try session(args[0]))
                    if let want = c["is"] as? [String: String] {
                        #expect(got?.title == want["title"], Comment(rawValue: about))
                        #expect(got?.body == want["body"], Comment(rawValue: about))
                    } else {
                        #expect(got == nil, Comment(rawValue: about))
                    }
                case "cut":
                    #expect(cut(args[0] as! String, (args[1] as! NSNumber).intValue) == c["is"] as? String, Comment(rawValue: about))
                default:
                    Issue.record(Comment(rawValue: "\(about): unknown fn"))
                }
            }
        }
    }

    /// Every session list the recorded exchanges send, read as the
    /// extension reads it, gives the sessions web/core shows: the same IDs,
    /// names and notices.
    @Test func sessionsFromExchanges() throws {
        let files = try FileManager.default.contentsOfDirectory(atPath: repo.appendingPathComponent("cases/exchanges").path).filter { $0.hasSuffix(".json") }.sorted()
        var compared = 0
        for file in files {
            var live: [String: Session] = [:]
            // A list comes in frames, all but the last with more set.
            var listed = true
            for step in try json("cases/exchanges/" + file)["steps"] as! [[String: Any]] {
                if let frame = step["in"] as? [String: Any] {
                    if let list = frame["sessionList"] as? [String: Any] {
                        if listed { live = [:] }
                        listed = list["more"] as? Bool != true
                        for e in list["sessions"] as? [[String: Any]] ?? [] {
                            let s = try entry(e)
                            live[s.id] = s
                        }
                    } else if let u = frame["sessionUpdated"] as? [String: Any] {
                        let s = try entry(u["entry"] as! [String: Any])
                        live[s.id] = s
                    }
                }
                guard let snapshot = step["snapshot"] as? [String: Any] else { continue }
                for v in snapshot["sessions"] as! [[String: Any]] {
                    let want = try session(v)
                    #expect(live[want.id] == want, Comment(rawValue: "\(file): \(want.id)"))
                    compared += 1
                }
            }
        }
        #expect(compared > 5)
    }

    @Test func sessionID() {
        #expect(Session.id(hostKey: Data((0..<32).map { UInt8($0 * 9 % 256) }), instanceID: "abc") == "0009121b242d363f-abc")
    }

    @Test func bareRelayURL() throws {
        #expect(try relayURL(URL(string: "wss://relay.example")!).absoluteString == "wss://relay.example/v1alpha1")
        #expect(try relayURL(URL(string: "ws://192.0.2.1:7400/")!).absoluteString == "ws://192.0.2.1:7400/v1alpha1")
        #expect(try relayURL(URL(string: "wss://relay.example/other")!).absoluteString == "wss://relay.example/other")
        #expect(throws: FetchError.badURL) { try relayURL(URL(string: "https://relay.example")!) }
    }
}

/// A session entry in the cases' JSON, its announcement given decoded, as
/// the extension would read it off the wire.
func entry(_ e: [String: Any]) throws -> Session {
    var plain = e
    let announcement = plain.removeValue(forKey: "announcement") ?? [:]
    var entry = try Pirc_V1alpha1_SessionEntry(jsonUTF8Data: JSONSerialization.data(withJSONObject: plain))
    entry.payload = try Pirc_V1alpha1_SessionAnnouncement(jsonUTF8Data: JSONSerialization.data(withJSONObject: announcement)).serializedData()
    return try #require(Session(entry: Pirc_V1alpha1_SessionEntry(serializedBytes: entry.serializedData())))
}
