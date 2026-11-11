// The app's version, for lib/ui/settings_screen.dart's Licences over
// 'dev.pirc.app/about': as the build gave it, "1.0.0 (3)".
import Flutter

enum About {
  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.pirc.app/about", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "version" else { return result(FlutterMethodNotImplemented) }
      let info = Bundle.main.infoDictionary ?? [:]
      let name = info["CFBundleShortVersionString"] as? String ?? ""
      let build = info["CFBundleVersion"] as? String ?? ""
      result(build.isEmpty ? name : "\(name) (\(build))")
    }
  }
}
