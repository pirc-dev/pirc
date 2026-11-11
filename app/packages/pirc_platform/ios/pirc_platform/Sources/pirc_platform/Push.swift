// Notifications on iOS, for lib/push/push.dart over 'dev.pirc.app/push':
// whether they are allowed and asking for them, the APNs token with the
// environment it is for, and the session of the one the person tapped.
// The notification extension writes them (ios/Notifications), not this.
import Flutter
import UIKit
import UserNotifications

final class Push: NSObject, UNUserNotificationCenterDelegate {
  private let channel: FlutterMethodChannel
  private var waitingForToken: [FlutterResult] = []
  private var lastToken: String?
  // A tap before Dart asked for it, as when the tap opened the app.
  private var launchedFor: String?

  init(channel: FlutterMethodChannel) {
    self.channel = channel
    super.init()
    UNUserNotificationCenter.current().delegate = self
    channel.setMethodCallHandler { [weak self] call, result in self?.handle(call, result) }
  }

  private func handle(_ call: FlutterMethodCall, _ result: @escaping FlutterResult) {
    switch call.method {
    case "permission":
      UNUserNotificationCenter.current().getNotificationSettings { s in
        let p: String
        switch s.authorizationStatus {
        case .authorized, .provisional, .ephemeral: p = "granted"
        case .denied: p = "denied"
        default: p = "undetermined"
        }
        DispatchQueue.main.async { result(p) }
      }
    case "ask":
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
        DispatchQueue.main.async { result(granted) }
      }
    case "token":
      waitingForToken.append(result)
      DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
    case "launchedFor":
      result(launchedFor)
      launchedFor = nil
    case "post":
      result(nil)
    case "settings":
      // The app's page in the phone's Settings, with its notifications.
      if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  func registered(_ deviceToken: Data) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    let token: [String: Any] = ["platform": "apns", "token": hex, "environment": Push.environment]
    let waiting = waitingForToken
    waitingForToken = []
    for r in waiting { r(token) }
    // A token changed by Apple, not asked for: registered again.
    if waiting.isEmpty, lastToken != nil, lastToken != hex { channel.invokeMethod("token", arguments: token) }
    lastToken = hex
  }

  func failed(_ error: Error) {
    let waiting = waitingForToken
    waitingForToken = []
    for r in waiting { r(nil) }
  }

  // Which of Apple's push servers this build's tokens are for, decided
  // here: a development build's profile says "development" in its
  // aps-environment; an App Store or TestFlight build carries no profile
  // and uses the production servers; the simulator, the development ones.
  static let environment: String = {
    #if targetEnvironment(simulator)
      return "development"
    #else
      guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
            let data = try? Data(contentsOf: url),
            let text = String(data: data, encoding: .isoLatin1),
            let start = text.range(of: "<plist"), let end = text.range(of: "</plist>"),
            let plist = try? PropertyListSerialization.propertyList(from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil) as? [String: Any],
            let entitlements = plist["Entitlements"] as? [String: Any],
            let aps = entitlements["aps-environment"] as? String
      else { return "production" }
      return aps
    #endif
  }()

  // The app is open: what the extension would write is on the screen.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([])
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    if let session = response.notification.request.content.userInfo["session"] as? String {
      launchedFor = session
      channel.invokeMethod("opened", arguments: ["session": session])
    }
    done()
  }
}
