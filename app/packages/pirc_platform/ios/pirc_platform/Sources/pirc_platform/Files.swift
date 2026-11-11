// The folder for what the app keeps of what it shows (the chats, the
// drafts), for lib/app/files.dart over the channel 'dev.pirc.app/files':
// unreadable while the phone is locked (complete protection), and out of
// backups; each file written there is given both again, since a file
// replaced by a rename keeps what the one it was had. The simulator keeps
// no protection: it reads back empty there.
import Flutter

enum Files {
  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.pirc.app/files", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      do {
        switch call.method {
        case "folder":
          let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
          var folder = support.appendingPathComponent("private", isDirectory: true)
          try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
          try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: folder.path)
          var values = URLResourceValues()
          values.isExcludedFromBackup = true
          try folder.setResourceValues(values)
          result(folder.path)
        case "protect":
          guard let path = (call.arguments as? [String: Any])?["path"] as? String else {
            return result(FlutterError(code: "args", message: "no path", details: nil))
          }
          try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: path)
          var file = URL(fileURLWithPath: path)
          var values = URLResourceValues()
          values.isExcludedFromBackup = true
          try file.setResourceValues(values)
          result(nil)
        case "protection":
          // For checking: the file's protection and whether it is backed up.
          guard let path = (call.arguments as? [String: Any])?["path"] as? String else {
            return result(FlutterError(code: "args", message: "no path", details: nil))
          }
          // Resource values, not the file's attributes, which carry its dates
          // and so would need a reason in PrivacyInfo.xcprivacy; named as the
          // attributes name it (NSFileProtectionComplete, not NSURLFile...).
          let values = try URL(fileURLWithPath: path).resourceValues(forKeys: [.fileProtectionKey, .isExcludedFromBackupKey])
          let protection = values.fileProtection?.rawValue.replacingOccurrences(of: "NSURLFileProtection", with: "NSFileProtection") ?? ""
          result(["protection": protection, "excludedFromBackup": values.isExcludedFromBackup ?? false])
        default:
          result(FlutterMethodNotImplemented)
        }
      } catch {
        result(FlutterError(code: "files", message: error.localizedDescription, details: nil))
      }
    }
  }
}
