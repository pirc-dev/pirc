// pirc://join links opened in the app, for lib/app/links.dart over
// 'dev.pirc.app/links': the one the scene was started with, once, and
// those that come while it runs. The token in a link goes to Dart only,
// never to a log.
import Flutter
import UIKit

final class Links {
  private let channel: FlutterMethodChannel
  // A link before Dart asked for one, as when the link started the app.
  private var waiting: String?
  private var asked = false

  init(channel: FlutterMethodChannel) {
    self.channel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self, call.method == "launchedWith" else { return result(FlutterMethodNotImplemented) }
      self.asked = true
      result(self.waiting)
      self.waiting = nil
    }
  }

  // Whether the URLs held a join link.
  func open(_ urls: [URL]) -> Bool {
    guard let url = urls.first(where: { $0.scheme == "pirc" && $0.host == "join" }) else { return false }
    if asked {
      channel.invokeMethod("opened", arguments: url.absoluteString)
    } else {
      waiting = url.absoluteString
    }
    return true
  }
}
