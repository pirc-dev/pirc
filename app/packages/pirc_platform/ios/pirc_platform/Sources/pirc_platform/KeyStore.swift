// The phone's keys in the Keychain, for lib/keys/key_store.dart over the
// channel 'dev.pirc.app/keys' (docs/design.md, section 12, step 13). The
// main key, when protected, is released only after Face ID or the passcode;
// the read-only key is readable from the first unlock, in the access group
// the notification extension shares, where it logs in with it. Neither
// leaves this phone: ThisDeviceOnly keeps both out of backups and iCloud.
import Flutter
import LocalAuthentication
import Security

enum KeyStore {
  // The groups the two keys live in: the app's own, and the one it shares
  // with the notification extension (Runner.entitlements), under the App
  // ID prefix the app was built with (Identity).
  static let mainGroup = Identity.keyPrefix + Identity.bundle
  static let readGroup = Identity.keyPrefix + "dev.pirc.shared"

  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.pirc.app/keys", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      let args = call.arguments as? [String: Any] ?? [:]
      // Off the main thread: a protected load waits for Face ID.
      DispatchQueue.global(qos: .userInitiated).async {
        let out = handle(call.method, args)
        DispatchQueue.main.async { result(out) }
      }
    }
  }

  static func handle(_ method: String, _ args: [String: Any]) -> Any? {
    if method == "biometry" { return biometry() }
    guard let relay = args["relay"] as? String else { return FlutterError(code: "args", message: "no relay", details: nil) }
    switch method {
    case "store":
      guard let kind = args["kind"] as? String, let seed = args["seed"] as? FlutterStandardTypedData else {
        return FlutterError(code: "args", message: "no kind or seed", details: nil)
      }
      return store(relay, kind, seed.data, protect: args["protect"] as? Bool ?? true)
    case "load":
      guard let kind = args["kind"] as? String else { return FlutterError(code: "args", message: "no kind", details: nil) }
      return load(relay, kind, reason: args["reason"] as? String ?? "")
    case "delete":
      for kind in ["main", "read"] { SecItemDelete(item(relay, kind) as CFDictionary) }
      return nil
    default:
      return FlutterMethodNotImplemented
    }
  }

  // A key's item: a generic password named by its kind, for the relay.
  static func item(_ relay: String, _ kind: String) -> [CFString: Any] {
    [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: kind == "read" ? "dev.pirc.read-key" : "dev.pirc.main-key",
      kSecAttrAccount: relay,
      kSecAttrAccessGroup: kind == "read" ? readGroup : mainGroup,
    ]
  }

  static func store(_ relay: String, _ kind: String, _ seed: Data, protect: Bool) -> Any? {
    var q = item(relay, kind)
    SecItemDelete(q as CFDictionary)
    q[kSecValueData] = seed
    if kind == "read" {
      q[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    } else if protect {
      // Face ID, Touch ID or the passcode; gone if the passcode is removed.
      var error: Unmanaged<CFError>?
      guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error) else {
        return FlutterError(code: "keychain", message: "\(error!.takeRetainedValue())", details: nil)
      }
      q[kSecAttrAccessControl] = access
    } else {
      q[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    }
    let status = SecItemAdd(q as CFDictionary, nil)
    if status == errSecNotAvailable || status == errSecAuthFailed, protect, kind == "main" {
      return FlutterError(code: "no-passcode", message: "Set a passcode on this phone to lock PiRC", details: nil)
    }
    return status == errSecSuccess ? nil : failure(status)
  }

  static func load(_ relay: String, _ kind: String, reason: String) -> Any? {
    var q = item(relay, kind)
    q[kSecReturnData] = true
    q[kSecMatchLimit] = kSecMatchLimitOne
    let context = LAContext()
    context.localizedReason = reason.isEmpty ? "Unlock PiRC" : reason
    q[kSecUseAuthenticationContext] = context
    var out: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    switch status {
    case errSecSuccess:
      return FlutterStandardTypedData(bytes: out as! Data)
    case errSecItemNotFound:
      return nil
    case errSecUserCanceled:
      return FlutterError(code: "cancelled", message: "Cancelled", details: nil)
    default:
      return failure(status)
    }
  }

  // What the phone asks with besides the passcode, as the Settings switch
  // names it.
  static func biometry() -> String {
    let context = LAContext()
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return "none" }
    switch context.biometryType {
    case .faceID: return "face"
    case .touchID: return "touch"
    default: return "none"
    }
  }

  static func failure(_ status: OSStatus) -> FlutterError {
    let text = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    return FlutterError(code: "keychain", message: text, details: nil)
  }
}
