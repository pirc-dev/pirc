// Signed objects (docs/e2e.md, section 2): a body as its signer encoded
// it, the signer's key, and an Ed25519 signature over framed("pirc-e2e-v1
// <kind>", account ID, body). Verified on those bytes before the body is
// parsed; never encoded again. A port of crypto/objects.ts.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:protobuf/protobuf.dart';

import '../gen/pirc/v1alpha2/e2e.pb.dart';
import 'bytes.dart';
import 'ed25519.dart' as ed25519;
import 'hpke.dart' as hpke;

// Each kind of signed object: its context, its body, and which field names its signer.
class Kind<B extends GeneratedMessage> {
  Kind._(this.name, this.create, this._parse, this._signer);

  final String name;
  // An empty body, to fill from JSON (the tests do).
  final B Function() create;
  final B Function(List<int>) _parse;
  final List<int> Function(B) _signer;

  String get context => 'pirc-e2e-v1 $name';

  List<int> signerOf(B body) => _signer(body);

  static final list = Kind<ListVersionBody>._('list', ListVersionBody.new, ListVersionBody.fromBuffer, (b) => b.signer);
  static final withdrawal =
      Kind<WithdrawalBody>._('withdrawal', WithdrawalBody.new, WithdrawalBody.fromBuffer, (b) => b.signer);
  static final preKey = Kind<PreKeyBody>._('pre-key', PreKeyBody.new, PreKeyBody.fromBuffer, (b) => b.signer);
  static final labelKey =
      Kind<LabelKeyWrapBody>._('label-key', LabelKeyWrapBody.new, LabelKeyWrapBody.fromBuffer, (b) => b.signer);
  static final labels = Kind<LabelsBody>._('labels', LabelsBody.new, LabelsBody.fromBuffer, (b) => b.signer);
  static final bundle = Kind<BundleBody>._('bundle', BundleBody.new, BundleBody.fromBuffer, (b) => b.hostKey);
  // An announcement without a session names no signer, so none matches.
  static final announcement = Kind<AnnouncementBody>._('announcement', AnnouncementBody.new,
      AnnouncementBody.fromBuffer, (b) => b.hasSession() ? b.session.hostKey : empty);
  static final request = Kind<EnvelopeBody>._('request', EnvelopeBody.new, EnvelopeBody.fromBuffer, (b) => b.signer);
  static final join = Kind<JoinDeviceBody>._('join', JoinDeviceBody.new, JoinDeviceBody.fromBuffer, (b) => b.publicKey);

  static final List<Kind> all = [list, withdrawal, preKey, labelKey, labels, bundle, announcement, request, join];

  static Kind byName(String name) => all.firstWhere((k) => k.name == name);
}

// Dart's protobuf encodes a field set to its default value (a zero, an
// empty string or bytes) where proto3, and every other language PiRC
// uses, leaves it out: a Timestamp of whole seconds, from JSON or from a
// DateTime, gets nanos = 0 written. So bodies are cleared of those before
// they are encoded, and encode to the same bytes as elsewhere. Fields in a
// oneof keep theirs, since there being set is what they say.
T canonical<T extends GeneratedMessage>(T m) {
  final info = m.info_;
  for (final f in info.fieldInfo.values) {
    final tag = f.tagNumber;
    if (!m.hasField(tag)) continue;
    final v = m.getField(tag);
    if (f.isMapField) {
      for (final x in (v as PbMap).values) {
        if (x is GeneratedMessage) canonical(x);
      }
    } else if (f.isRepeated) {
      for (final x in v as List) {
        if (x is GeneratedMessage) canonical(x);
      }
    } else if (f.isGroupOrMessage) {
      canonical(v as GeneratedMessage);
    } else if (!info.oneofs.containsKey(tag) && _isDefault(v)) {
      m.clearField(tag);
    }
  }
  return m;
}

bool _isDefault(Object? v) =>
    v == 0 || v == false || v == '' || v == Int64.ZERO || (v is List && v.isEmpty) || (v is ProtobufEnum && v.value == 0);

Uint8List signedBytes(Kind kind, List<int> accountId, List<int> body) => framed(kind.context, [accountId, body]);

// Encodes the body once (canonical, on a copy), and signs those bytes.
Future<SignedObject> sign<B extends GeneratedMessage>(
    Kind<B> kind, List<int> accountId, ed25519.Signer signer, B body) async {
  final bytes = canonical(body.deepCopy()).writeToBuffer();
  if (!equal(kind.signerOf(body), signer.publicKey)) {
    throw ArgumentError("the ${kind.name}'s signer field is not the signing key");
  }
  return SignedObject(
    body: bytes,
    signature: await signer.sign(signedBytes(kind, accountId, bytes)),
    signer: signer.publicKey,
  );
}

// The body, if the signature checks and the body names the same signer; otherwise null.
Future<B?> open<B extends GeneratedMessage>(Kind<B> kind, List<int> accountId, SignedObject obj) async {
  if (!await ed25519.verify(obj.signer, signedBytes(kind, accountId, obj.body), obj.signature)) return null;
  B body;
  try {
    body = kind._parse(obj.body);
  } catch (_) {
    return null;
  }
  return equal(kind.signerOf(body), obj.signer) ? body : null;
}

// SHA-256 of the body: a version's hash, and version 1's is the account ID.
Future<Uint8List> hash(SignedObject obj) => hpke.sha256(obj.body);

Uint8List encode(SignedObject obj) => obj.writeToBuffer();

SignedObject decode(List<int> b) => SignedObject.fromBuffer(b);
