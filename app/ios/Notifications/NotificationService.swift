// The notification extension (docs/design.md, section 12, step 13): a push
// arrives with the fixed text "A session needs you"; this logs in to the
// relay with the read-only key, reads the session list (PircNotices) and
// writes what the sessions' notices say in its place. When the relay cannot
// be reached, or nothing is new, the fixed text stays; and while the App
// Store does not allow the phone (docs/design.md, step 15, Price), nothing
// is fetched, unless it is joined to the review relay.
import PircNotices
import Security
import StoreKit
import UserNotifications

// Shared with the app (Runner.entitlements): the App Group's defaults, with
// the relay's URL and what was last shown, and the read-only key, as the
// build was given them (ios/Flutter/Identity.xcconfig, through Info.plist).
let group = info("PircAppGroup")
let keyGroup = "\(info("PircTeam")).dev.pirc.shared"

private func info(_ key: String) -> String {
  guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String, !value.isEmpty else {
    fatalError("Info.plist has no \(key): the build takes it from ios/Flutter/Identity.xcconfig")
  }
  return value
}

// As the app's reviewRelay (lib/app/store.dart): allowed without the
// subscription.
let reviewRelay = "wss://review.pirc.dev"

final class NotificationService: UNNotificationServiceExtension {
  private let lock = NSLock()
  private var deliver: ((UNNotificationContent) -> Void)?
  private var fixed = UNNotificationContent()
  private var task: Task<Void, Never>?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
    deliver = handler
    fixed = request.content
    task = Task { finish(await written() ?? fixed) }
  }

  // iOS's 30 seconds are up: the fixed text.
  override func serviceExtensionTimeWillExpire() {
    task?.cancel()
    finish(fixed)
  }

  private func finish(_ content: UNNotificationContent) {
    lock.lock()
    let d = deliver
    deliver = nil
    lock.unlock()
    d?(content)
  }

  // The first note in place of the fixed text, the rest posted beside it;
  // nil when there is nothing to write.
  private func written() async -> UNNotificationContent? {
    guard let defaults = UserDefaults(suiteName: group),
          let relay = defaults.string(forKey: "relay").flatMap(URL.init(string:)),
          let seed = readKey(relay.absoluteString)
    else { return nil }
    // A build from source has no subscription ("store.none", which the app
    // writes at its start), and so no store to ask.
    if relay.absoluteString != reviewRelay, defaults.string(forKey: "store.none") == nil, !(await allowed(defaults)) { return nil }
    let shown = defaults.string(forKey: "notices.v1").flatMap { try? JSONDecoder().decode(Shown.self, from: Data($0.utf8)) } ?? Shown()
    let now = UInt64(Date().timeIntervalSince1970 * 1000)
    guard let (notes, next) = try? await Fetch.run(relay: relay, seed: seed, shown: shown, now: now, deadline: 20) else { return nil }
    if let json = try? JSONEncoder().encode(next) { defaults.set(String(decoding: json, as: UTF8.self), forKey: "notices.v1") }
    guard let first = notes.first else { return nil }
    for note in notes.dropFirst() {
      let request = UNNotificationRequest(identifier: UUID().uuidString, content: content(note), trigger: nil)
      try? await UNUserNotificationCenter.current().add(request)
    }
    return content(first)
  }

  private func content(_ note: Note) -> UNNotificationContent {
    let c = UNMutableNotificationContent()
    c.title = note.title
    c.body = note.body
    c.sound = .default
    c.threadIdentifier = note.session
    c.userInfo = ["session": note.session]
    return c
  }

  // Whether the subscription allows the phone: until the time the app
  // last left ("store.until", the period's or grace's end and a few days),
  // or past it, as StoreKit says here within a few seconds, out of iOS's
  // 30 for the whole notification.
  private func allowed(_ defaults: UserDefaults) async -> Bool {
    if let until = defaults.string(forKey: "store.until").flatMap(Double.init), Date().timeIntervalSince1970 * 1000 < until { return true }
    return await withTaskGroup(of: Bool?.self) { group in
      group.addTask {
        for await result in Transaction.currentEntitlements {
          if case .verified(let t) = result, t.productID == "dev.pirc.app.yearly", t.revocationDate == nil { return true }
        }
        return false
      }
      group.addTask {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        return nil
      }
      let first = await group.next() ?? nil
      group.cancelAll()
      return first ?? false
    }
  }

  // The read-only key's seed, as the app keeps it (Runner/KeyStore.swift).
  private func readKey(_ relay: String) -> Data? {
    let q: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: "dev.pirc.read-key",
      kSecAttrAccount: relay,
      kSecAttrAccessGroup: keyGroup,
      kSecReturnData: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var out: CFTypeRef?
    return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }
}
