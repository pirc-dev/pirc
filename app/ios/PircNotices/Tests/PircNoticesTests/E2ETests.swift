// cases/e2e, as crypto/test's runners read it, for what a notification
// needs: Ed25519 decided as every verifier decides it, HPKE's vector, and
// from objects.json the bundle, the announcement and the labels, opened
// with the read-only key's pre-key.

import CryptoKit
import Foundation
import SwiftProtobuf
import Testing

@testable import PircNotices

func unhex(_ s: String) -> Data {
    var out = Data()
    var i = s.startIndex
    while i < s.endIndex {
        let j = s.index(i, offsetBy: 2)
        out.append(UInt8(s[i..<j], radix: 16)!)
        i = j
    }
    return out
}

func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

/// A message from Protocol Buffers' JSON, as the file holds it.
func message<M: SwiftProtobuf.Message>(_: M.Type, _ v: Any) throws -> M {
    try M(jsonUTF8Data: JSONSerialization.data(withJSONObject: v))
}

struct E2ETests {
    @Test func ed25519() throws {
        let vectors = try json("cases/e2e/ed25519.json")["vectors"] as! [[String: Any]]
        #expect(vectors.count == 33)
        for v in vectors {
            let got = Ed25519.verify(publicKey: unhex(v["public_key"] as! String), message: unhex(v["message"] as! String), signature: unhex(v["signature"] as! String))
            #expect(got == v["valid"] as! Bool, Comment(rawValue: v["name"] as! String))
        }
    }

    @Test func hpke() throws {
        let v = try json("cases/e2e/hpke.json")["vector"] as! [String: Any]
        func s(_ k: String) -> Data { unhex(v[k] as! String) }
        let sk = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: s("skRm"))
        #expect(sk.publicKey.rawRepresentation == s("pkRm"))
        let dh = try sk.sharedSecretFromKeyAgreement(with: Curve25519.KeyAgreement.PublicKey(rawRepresentation: s("enc"))).withUnsafeBytes { Data($0) }
        let schedule = HPKE.schedule(dh: dh, enc: s("enc"), recipient: s("pkRm"), info: s("info"))
        #expect(schedule.sharedSecret == s("shared_secret"))
        #expect(schedule.key == s("key"))
        #expect(schedule.baseNonce == s("base_nonce"))
        // Single-shot is the first encryption, under the base nonce.
        let first = (v["encryptions"] as! [[String: String]])[0]
        let sealed = s("enc") + unhex(first["ct"]!)
        #expect(HPKE.open(sk, info: s("info"), aad: unhex(first["aad"]!), sealed: sealed) == unhex(first["pt"]!))
        #expect(HPKE.open(sk, info: s("info") + [0], aad: unhex(first["aad"]!), sealed: sealed) == nil)
        #expect(HPKE.open(sk, info: s("info"), aad: Data(), sealed: sealed) == nil)
    }
}

struct ObjectsTests {
    let file: [String: Any]
    let account: Data

    init() throws {
        file = try json("cases/e2e/objects.json")
        account = unhex(file["account_id"] as! String)
    }

    var objects: [String: [String: Any]] { file["objects"] as! [String: [String: Any]] }

    func obj(_ name: String) throws -> Pirc_V1alpha2_SignedObject {
        try Pirc_V1alpha2_SignedObject(serializedBytes: unhex(objects[name]!["encoded"] as! String))
    }

    func device(_ name: String) -> [String: String] { (file["devices"] as! [String: [String: Any]])[name]!.compactMapValues { $0 as? String } }

    func me(_ name: String) throws -> Me {
        Me(publicKey: unhex(device(name)["public_key"]!), preKey: try .init(rawRepresentation: unhex(device(name)["pre_key_private"]!)))
    }

    /// A list version's devices, as the app hands over the one it checked.
    func devices(_ version: String) throws -> Devices {
        Devices(try Pirc_V1alpha2_ListVersionBody(serializedBytes: try obj(version).body))
    }

    @Test func framedStrings() {
        for f in file["framed"] as! [[String: Any]] {
            let got = framed(f["context"] as! String, (f["parts"] as! [String]).map(unhex))
            #expect(hex(got) == f["out"] as! String)
        }
        #expect(hex(framed("x", Data(), Data([0]))) == "7800" + "00" + "0100")
    }

    func check<B: SignedBody>(_: B.Type, _ name: String) throws {
        let o = objects[name]!
        #expect(o["kind"] as! String == B.kind, Comment(rawValue: name))
        let fromJSON = try message(B.self, o["json"]!)
        #expect(hex(try fromJSON.serializedBytes()) == o["body"] as! String, Comment(rawValue: name))
        let signed = try obj(name)
        #expect(hex(signed.body) == o["body"] as! String, Comment(rawValue: name))
        #expect(hex(Objects.hash(signed)) == o["hash"] as! String, Comment(rawValue: name))
        let opened = Objects.open(B.self, accountID: account, signed)
        #expect(opened == fromJSON, Comment(rawValue: name))
        // Under another account, another kind, or with a byte changed: no.
        #expect(Objects.open(B.self, accountID: Data(count: 32), signed) == nil, Comment(rawValue: name))
        var bent = signed
        bent.signature[0] ^= 1
        #expect(Objects.open(B.self, accountID: account, bent) == nil, Comment(rawValue: name))
    }

    @Test func bodiesHashesAndSignatures() throws {
        var n = 0
        for (name, o) in objects {
            switch o["kind"] as! String {
            case "bundle": try check(Pirc_V1alpha2_BundleBody.self, name)
            case "announcement": try check(Pirc_V1alpha2_AnnouncementBody.self, name)
            case "labels": try check(Pirc_V1alpha2_LabelsBody.self, name)
            case "label-key": try check(Pirc_V1alpha2_LabelKeyWrapBody.self, name)
            default: continue
            }
            n += 1
        }
        #expect(n == 5)
        // A bundle is not an announcement.
        #expect(Objects.open(Pirc_V1alpha2_AnnouncementBody.self, accountID: account, try obj("bundle")) == nil)
    }

    @Test func bundleUnwraps() throws {
        let b = file["bundle"] as! [String: Any]
        let v3 = try devices(b["list"] as! String)
        let bundle = try #require(openBundle(accountID: account, try obj("bundle"), devices: v3))
        for u in b["unwraps"] as! [[String: Any]] {
            let name = u["device"] as! String
            let got = unwrap(accountID: account, bundle, devices: v3, me: try me(name))
            #expect(got.map { hex($0.announcement) } == u["announcement"] as? String, Comment(rawValue: name))
            #expect(got?.conversation.map(hex) == u["conversation"] as? String, Comment(rawValue: name))
        }
        let read = try me("phone-read")
        #expect(unwrap(accountID: account, bundle, devices: v3, me: read)?.conversation == nil)
        // Another pre-key, or a device not in the bundle: nothing.
        let wrongPreKey = Me(publicKey: read.publicKey, preKey: try me("phone").preKey)
        #expect(unwrap(accountID: account, bundle, devices: v3, me: wrongPreKey) == nil)
        #expect(unwrap(accountID: account, bundle, devices: v3, me: try me("stranger")) == nil)
        // A bundle naming a device off the list gives nobody anything.
        #expect(unwrap(accountID: account, bundle, devices: try devices("v4a"), me: read) == nil)
        // Recipients out of order: nothing.
        var swapped = bundle
        swapped.recipients.swapAt(0, 1)
        #expect(unwrap(accountID: account, swapped, devices: v3, me: read) == nil)
        // A bundle whose signer is not a host on the list is not taken.
        var notHost = v3.roles
        notHost[bundle.hostKey] = .client
        #expect(openBundle(accountID: account, try obj("bundle"), devices: Devices(notHost)) == nil)
    }

    @Test func framesOpenOnlyWhereSealed() throws {
        let fr = file["frames"] as! [String: Any]
        let keys = file["sending_keys"] as! [String: String]
        let session = try message(Pirc_V1alpha1_SessionRef.self, fr["session"]!)
        let kinds: [String: Pirc_V1alpha2_FrameKind] = ["ANNOUNCEMENT": .announcement, "BROADCAST": .broadcast, "ANSWER": .answer]
        let v3 = try devices("v3")
        for f in fr["frames"] as! [[String: String]] {
            let about = Comment(rawValue: f["about"]!)
            let key = unhex(keys[f["key"]!]!)
            let at = FrameAt(accountID: account, keyID: unhex(keys["key_id"]!), session: session, kind: kinds[f["kind"]!]!, recipient: unhex(f["recipient"]!),
                             listVersion: UInt64(f["list_version"]!)!, counter: UInt64(f["counter"]!)!)
            let ct = unhex(f["ciphertext"]!)
            #expect(hex(frameAad(at)) == f["aad"]!, about)
            #expect(openFrame(key: key, at, ciphertext: ct).map(hex) == f["plaintext"]!, about)
            var other = session
            other.sessionID = "another"
            var moved = [at, at, at, at, at]
            moved[0].session = other
            moved[1].recipient = f["recipient"]!.isEmpty ? unhex(device("tablet")["public_key"]!) : Data()
            moved[2].kind = at.kind == .broadcast ? .answer : .broadcast
            moved[3].counter += 1
            moved[4].listVersion += 1
            for m in moved { #expect(openFrame(key: key, m, ciphertext: ct) == nil, about) }
            if at.kind == .announcement {
                let body = try #require(openAnnouncement(key: key, at, ciphertext: ct, devices: v3))
                #expect(body == (try message(Pirc_V1alpha2_AnnouncementBody.self, objects["announcement"]!["json"]!)))
                #expect(openAnnouncement(key: key, moved[0], ciphertext: ct, devices: v3) == nil, about)
                #expect(openAnnouncement(key: unhex(keys["conversation"]!), at, ciphertext: ct, devices: v3) == nil, about)
            }
        }
    }

    @Test func labelsAndTheLabelKey() throws {
        let l = file["labels"] as! [String: Any]
        let labelKey = unhex(l["label_key"] as! String)
        let rec = try #require(Objects.open(Pirc_V1alpha2_LabelsBody.self, accountID: account, try obj(l["object"] as! String)))
        let got = try #require(openLabels(labelKey: labelKey, accountID: account, rec.labelKey, counter: rec.counter, sealed: rec.sealed))
        #expect(got == (try message(Pirc_V1alpha2_Labels.self, l["labels"]!)))
        #expect(got.label(unhex(device("laptop")["public_key"]!)) == "laptop")
        #expect(openLabels(labelKey: labelKey, accountID: account, rec.labelKey, counter: rec.counter + 1, sealed: rec.sealed) == nil)
        for w in l["wraps"] as! [[String: String]] {
            let body = try #require(Objects.open(Pirc_V1alpha2_LabelKeyWrapBody.self, accountID: account, try obj(w["object"]!)))
            let mine = try me(w["device"]!)
            #expect(unwrapLabelKey(preKey: mine.preKey, accountID: account, body.labelKey, me: mine.publicKey, wrap: body.wrap) == labelKey)
            // Not for another device, nor for this one under another's key.
            let phone = try me("phone")
            #expect(unwrapLabelKey(preKey: phone.preKey, accountID: account, body.labelKey, me: phone.publicKey, wrap: body.wrap) == nil)
            #expect(unwrapLabelKey(preKey: phone.preKey, accountID: account, body.labelKey, me: mine.publicKey, wrap: body.wrap) == nil)
        }
    }
}
