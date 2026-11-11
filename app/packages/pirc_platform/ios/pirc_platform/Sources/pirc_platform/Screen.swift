// Keeping a secret off the screen's copies, for lib/ui/invite.dart over
// 'dev.pirc.app/screen': while secure, a plain cover over the app as it
// goes inactive, so that the app switcher's snapshot, taken then, shows
// nothing; gone when it is active again.
import Flutter
import UIKit

final class Screen: NSObject {
  private var secure = false
  private var cover: UIView?

  static func register(with messenger: FlutterBinaryMessenger) -> Screen {
    let screen = Screen()
    let channel = FlutterMethodChannel(name: "dev.pirc.app/screen", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "secure" else { return result(FlutterMethodNotImplemented) }
      screen.set((call.arguments as? [String: Any])?["on"] as? Bool ?? false)
      result(nil)
    }
    let center = NotificationCenter.default
    center.addObserver(screen, selector: #selector(resigning), name: UIApplication.willResignActiveNotification, object: nil)
    center.addObserver(screen, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
    return screen
  }

  private func set(_ on: Bool) {
    secure = on
    if !on { active() }
  }

  @objc private func resigning() {
    guard secure, cover == nil, let window = Screen.window() else { return }
    let view = UIView(frame: window.bounds)
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.backgroundColor = .systemBackground
    window.addSubview(view)
    cover = view
  }

  @objc private func active() {
    cover?.removeFromSuperview()
    cover = nil
  }

  private static func window() -> UIWindow? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
  }
}
