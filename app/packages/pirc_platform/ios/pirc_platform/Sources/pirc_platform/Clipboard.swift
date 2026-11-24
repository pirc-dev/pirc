// The clipboard over 'dev.pirc.app/clipboard': copying a secret, for
// lib/ui/invite.dart's copySecret, kept on this phone only (not Handoff's
// universal clipboard) and gone from the clipboard when it expires; and
// images for a message, for lib/ui/images.dart: whether it holds any, asked
// without reading them, so without the paste prompt; the images, each in its
// own encoding where it has one of pi's, else as a PNG; and 'changed' told
// as the clipboard changes.
import Flutter
import UIKit
import UniformTypeIdentifiers

enum Clipboard {
  // pi's kinds, as they come on the clipboard.
  static let kinds = [UTType.png, UTType.jpeg, UTType.gif, UTType.webP].map(\.identifier)

  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.pirc.app/clipboard", binaryMessenger: messenger)
    NotificationCenter.default.addObserver(forName: UIPasteboard.changedNotification, object: nil, queue: .main) { _ in
      channel.invokeMethod("changed", arguments: nil)
    }
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "copySecret":
        guard let args = call.arguments as? [String: Any], let text = args["text"] as? String else {
          return result(FlutterError(code: "args", message: "no text", details: nil))
        }
        var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
        if let ms = args["expiresAt"] as? Int64 ?? (args["expiresAt"] as? Int).map(Int64.init) {
          options[.expirationDate] = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
        }
        UIPasteboard.general.setItems([[UTType.plainText.identifier: text]], options: options)
        result(nil)
      case "hasImages":
        result(UIPasteboard.general.hasImages)
      case "images":
        result(images().map { FlutterStandardTypedData(bytes: $0) })
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  static func images() -> [Data] {
    let board = UIPasteboard.general
    var found: [Data] = []
    for (i, types) in (board.types(forItemSet: nil) ?? []).enumerated() {
      let one = IndexSet(integer: i)
      // As it was copied, where it is one of pi's kinds: the bytes, not a
      // picture drawn again.
      if let kind = kinds.first(where: types.contains), let data = board.data(forPasteboardType: kind, inItemSet: one)?.first {
        found.append(data)
        continue
      }
      // Any other image the phone can draw (a HEIC, a TIFF): as a JPEG, or a
      // PNG when it may be transparent; made to fit in lib/ui/images.dart.
      if let kind = types.first(where: { UTType($0)?.conforms(to: .image) == true }),
        let data = board.data(forPasteboardType: kind, inItemSet: one)?.first,
        let image = UIImage(data: data)
      {
        let alpha = image.cgImage.map { ![.none, .noneSkipFirst, .noneSkipLast].contains($0.alphaInfo) } ?? true
        if let encoded = alpha ? image.pngData() : image.jpegData(compressionQuality: 0.85) {
          found.append(encoded)
        }
      }
    }
    return found
  }
}
