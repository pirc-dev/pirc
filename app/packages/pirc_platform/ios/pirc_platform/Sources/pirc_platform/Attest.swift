// App Attest for the hosted relay (docs/e2e.md, section 6; docs/design.md,
// step 14), over 'dev.pirc.app/attest': a new key attested for what the
// relay's login binds, whose SHA-256 is the clientDataHash. A key attests
// once, so each sign-up or join makes its own.
import CryptoKit
import DeviceCheck
import Flutter

enum Attest {
  static func register(with messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "dev.pirc.app/attest", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "attest", let data = (call.arguments as? FlutterStandardTypedData)?.data else {
        return result(FlutterMethodNotImplemented)
      }
      let service = DCAppAttestService.shared
      guard service.isSupported else {
        return result(FlutterError(code: "unsupported", message: "App Attest is not supported here", details: nil))
      }
      Task {
        do {
          let keyID = try await service.generateKey()
          let attestation = try await service.attestKey(keyID, clientDataHash: Data(SHA256.hash(data: data)))
          guard let id = Data(base64Encoded: keyID) else { throw DCError(.invalidKey) }
          result(["keyId": FlutterStandardTypedData(bytes: id), "attestation": FlutterStandardTypedData(bytes: attestation)])
        } catch {
          result(FlutterError(code: "attest", message: String(describing: error), details: nil))
        }
      }
    }
  }
}
