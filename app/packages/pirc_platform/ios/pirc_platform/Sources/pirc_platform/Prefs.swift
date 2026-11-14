// What the app keeps besides its keys, for lib/app/app.dart's ChannelPrefs
// over the channel 'dev.pirc.app/prefs': the App Group's defaults, which
// the notification extension reads too ("relay", "notices.v1").
import Flutter

enum Prefs {
  static let group = Identity.appGroup

  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.pirc.app/prefs", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      let args = call.arguments as? [String: Any] ?? [:]
      guard let key = args["key"] as? String, let defaults = UserDefaults(suiteName: group) else {
        return result(FlutterError(code: "args", message: "no key, or no App Group", details: nil))
      }
      switch call.method {
      case "get":
        result(defaults.string(forKey: key))
      case "set":
        if let value = args["value"] as? String { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }
}
