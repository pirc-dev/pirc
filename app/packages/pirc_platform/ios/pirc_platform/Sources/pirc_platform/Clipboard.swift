// Copying a secret, for lib/ui/invite.dart's copySecret over
// 'dev.pirc.app/clipboard': kept on this phone only (not Handoff's
// universal clipboard), and gone from the clipboard when it expires.
import Flutter
import UIKit
import UniformTypeIdentifiers

enum Clipboard {
  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.pirc.app/clipboard", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "copySecret", let args = call.arguments as? [String: Any], let text = args["text"] as? String else {
        return result(FlutterMethodNotImplemented)
      }
      var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
      if let ms = args["expiresAt"] as? Int64 ?? (args["expiresAt"] as? Int).map(Int64.init) {
        options[.expirationDate] = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
      }
      UIPasteboard.general.setItems([[UTType.plainText.identifier: text]], options: options)
      result(nil)
    }
  }
}
