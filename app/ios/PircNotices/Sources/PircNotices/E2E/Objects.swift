// Signed objects (docs/e2e.md, section 2): a body as its signer encoded
// it, the signer's key, and an Ed25519 signature over framed("pirc-e2e-v1
// <kind>", account ID, body). Verified on those bytes before the body is
// parsed; never encoded again. The kinds a notification needs, of
// crypto/objects.ts's.

import CryptoKit
import Foundation
import SwiftProtobuf

/// A body of a signed object: its kind, and the field that names its signer.
protocol SignedBody: SwiftProtobuf.Message, Equatable {
    static var kind: String { get }
    var signedBy: Data { get }
}

extension Pirc_V1alpha2_BundleBody: SignedBody {
    static var kind: String { "bundle" }
    var signedBy: Data { hostKey }
}

extension Pirc_V1alpha2_AnnouncementBody: SignedBody {
    static var kind: String { "announcement" }
    var signedBy: Data { session.hostKey }
}

extension Pirc_V1alpha2_LabelsBody: SignedBody {
    static var kind: String { "labels" }
    var signedBy: Data { signer }
}

extension Pirc_V1alpha2_LabelKeyWrapBody: SignedBody {
    static var kind: String { "label-key" }
    var signedBy: Data { signer }
}

enum Objects {
    static func signedBytes(_ kind: String, accountID: Data, body: Data) -> Data {
        framed("pirc-e2e-v1 \(kind)", accountID, body)
    }

    /// The body, if the signature checks and the body names the same
    /// signer; otherwise nil.
    static func open<B: SignedBody>(_: B.Type, accountID: Data, _ obj: Pirc_V1alpha2_SignedObject) -> B? {
        guard Ed25519.verify(publicKey: obj.signer, message: signedBytes(B.kind, accountID: accountID, body: obj.body), signature: obj.signature),
              let body = try? B(serializedBytes: obj.body)
        else { return nil }
        return body.signedBy == obj.signer ? body : nil
    }

    /// SHA-256 of the body.
    static func hash(_ obj: Pirc_V1alpha2_SignedObject) -> Data {
        Data(SHA256.hash(data: obj.body))
    }
}
