// Who the app was built as, from its Info.plist, which the build fills in
// from ios/Flutter/Identity.xcconfig: the App ID prefix, as the
// entitlements' Keychain groups have it ("<team>." on current accounts,
// older ones may differ), and the App Group. The bundle ID is the app's own.
import Foundation

enum Identity {
  static let keyPrefix = info("PircKeyPrefix")
  static let appGroup = info("PircAppGroup")
  static let bundle = Bundle.main.bundleIdentifier!

  private static func info(_ key: String) -> String {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String, !value.isEmpty else {
      fatalError("Info.plist has no \(key): the build takes it from ios/Flutter/Identity.xcconfig")
    }
    return value
  }
}
