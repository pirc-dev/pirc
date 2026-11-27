// Files the person picks with the document picker, for lib/ui/files.dart
// over the channel 'dev.pirc.app/pick': each as its name, type and size,
// with its bytes while they come to the call's max together. The picker hands
// over copies, which are removed once read.
import Flutter
import UIKit
import UniformTypeIdentifiers

final class Picker: NSObject, UIDocumentPickerDelegate {
  private var pending: FlutterResult?
  private var max = 0

  static func register(with messenger: FlutterBinaryMessenger) -> Picker {
    let picker = Picker()
    let channel = FlutterMethodChannel(name: "dev.pirc.app/pick", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "files" else { return result(FlutterMethodNotImplemented) }
      picker.pick(max: (call.arguments as? [String: Any])?["max"] as? Int ?? 0, result)
    }
    return picker
  }

  private func pick(max: Int, _ result: @escaping FlutterResult) {
    guard pending == nil, let top = Picker.top() else {
      return result(FlutterError(code: "busy", message: "the picker cannot show now", details: nil))
    }
    pending = result
    self.max = max
    let vc = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
    vc.allowsMultipleSelection = true
    vc.delegate = self
    top.present(vc, animated: true)
  }

  private static func top() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    var vc = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
    while let shown = vc?.presentedViewController { vc = shown }
    return vc
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    let result = pending
    let max = self.max
    pending = nil
    DispatchQueue.global(qos: .userInitiated).async {
      var files: [[String: Any]] = []
      var room = max
      for url in urls {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        var file: [String: Any] = ["name": url.lastPathComponent, "mimeType": mime, "size": size]
        if size <= room, let data = try? Data(contentsOf: url), data.count <= room {
          room -= data.count
          file["size"] = data.count
          file["data"] = FlutterStandardTypedData(bytes: data)
        }
        try? FileManager.default.removeItem(at: url)
        files.append(file)
      }
      DispatchQueue.main.async { result?(files) }
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    pending?([])
    pending = nil
  }
}
