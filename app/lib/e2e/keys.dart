// A process's keys of the day, and what is sealed under them (docs/e2e.md,
// section 4): sending keys derived from a secret, frames under them,
// bundles that wrap them for every pre-key, envelopes sealed to the
// request key; and the label key's records and wraps (section 3). A port
// of crypto/keys.ts.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import '../gen/pirc/v1alpha1/common.pb.dart';
import '../gen/pirc/v1alpha2/e2e.pb.dart';
import '../gen/pirc/v1alpha2/relay.pbenum.dart';
import 'bytes.dart';
import 'hpke.dart' as hpke;
import 'list.dart';

typedef SendingKeys = ({Uint8List announcement, Uint8List conversation});

Future<SendingKeys> sendingKeys(List<int> secret, List<int> keyId, List<int> accountId, List<int> hostKey) async {
  final prk = await hpke.extract(keyId, secret);
  return (
    announcement: await hpke.expand(prk, framed('pirc-e2e-v1 announcement key', [accountId, hostKey]), 32),
    conversation: await hpke.expand(prk, framed('pirc-e2e-v1 conversation key', [accountId, hostKey]), 32),
  );
}

// --- frames ---

class FrameAt {
  const FrameAt({
    required this.accountId,
    required this.keyId,
    required this.session,
    required this.kind,
    required this.recipient,
    required this.listVersion,
    required this.counter,
  });

  final List<int> accountId;
  final List<int> keyId;
  final SessionRef session;
  final FrameKind kind;
  // The client's key for an answer to one client; empty otherwise.
  final List<int> recipient;
  final Int64 listVersion;
  final Int64 counter;
}

Uint8List frameAad(FrameAt f) => framed('pirc-e2e-v1 frame', [
      f.accountId,
      f.keyId,
      f.session.hostKey,
      utf8(f.session.sessionId),
      utf8(f.session.instanceId),
      [Direction.DIRECTION_HOST_TO_CLIENT.value],
      [f.kind.value],
      f.recipient,
      u64(f.listVersion),
      u64(f.counter),
    ]);

Uint8List _frameNonce(Int64 counter) => concat([Uint8List(4), u64(counter)]);

Future<Uint8List> sealFrame(List<int> key, FrameAt f, List<int> plaintext) =>
    hpke.aesSeal(key, _frameNonce(f.counter), frameAad(f), plaintext);

Future<Uint8List?> openFrame(List<int> key, FrameAt f, List<int> ciphertext) =>
    hpke.aesOpen(key, _frameNonce(f.counter), frameAad(f), ciphertext);

// --- bundles ---

Uint8List _wrapInfo(List<int> accountId, List<int> hostKey, List<int> keyId, List<int> recipient) =>
    framed('pirc-e2e-v1 wrap', [accountId, hostKey, keyId, recipient]);
final _announcementAad = utf8('announcement key');
final _conversationAad = utf8('conversation key');

typedef PreKeyOf = ({List<int> publicKey, List<int> preKey});

bool _canReceive(DeviceRole? role) => role == DeviceRole.DEVICE_ROLE_CLIENT || role == DeviceRole.DEVICE_ROLE_READ_ONLY;

// The recipients of a bundle: for each current pre-key of a client (both
// keys) or a read-only key (the announcement key) on list, ordered by
// key. Pre-keys of devices not on the list are left out.
Future<List<BundleRecipient>> wrapFor(
  ListVersionBody list,
  List<PreKeyOf> preKeys,
  SendingKeys keys, {
  required List<int> accountId,
  required List<int> hostKey,
  required List<int> keyId,
  Future<hpke.X25519Pair> Function()? ephemeral,
}) async {
  final out = <BundleRecipient>[];
  for (final p in [...preKeys]..sort((a, b) => compare(a.publicKey, b.publicKey))) {
    final role = device(list, p.publicKey)?.role;
    if (!_canReceive(role)) continue;
    final info = _wrapInfo(accountId, hostKey, keyId, p.publicKey);
    out.add(BundleRecipient(
      publicKey: p.publicKey,
      preKey: p.preKey,
      announcementKey:
          await hpke.seal(p.preKey, info, _announcementAad, keys.announcement, ephemeral: await ephemeral?.call()),
      conversationKey: role == DeviceRole.DEVICE_ROLE_CLIENT
          ? await hpke.seal(p.preKey, info, _conversationAad, keys.conversation, ephemeral: await ephemeral?.call())
          : empty,
    ));
  }
  return out;
}

// This device's keys from a bundle whose signature the caller has checked
// (objects.open): only if every recipient is on list and recipients are
// in order. A read-only key gets the announcement key alone, and a null
// conversation key.
Future<({Uint8List announcement, Uint8List? conversation})?> unwrap(
  List<int> accountId,
  BundleBody bundle,
  ListVersionBody list, {
  required List<int> publicKey,
  required hpke.X25519Pair preKey,
}) async {
  final rs = bundle.recipients;
  for (var i = 0; i < rs.length; i++) {
    if (!_canReceive(device(list, rs[i].publicKey)?.role)) return null;
    if (i > 0 && compare(rs[i - 1].publicKey, rs[i].publicKey) >= 0) return null;
  }
  final mine = rs.where((r) => equal(r.publicKey, publicKey) && equal(r.preKey, preKey.publicKey)).firstOrNull;
  if (mine == null) return null;
  final info = _wrapInfo(accountId, bundle.hostKey, bundle.keyId, publicKey);
  final announcement = await hpke.open(preKey, info, _announcementAad, mine.announcementKey);
  if (announcement == null || announcement.length != 32) return null;
  if (mine.conversationKey.isEmpty) return (announcement: announcement, conversation: null);
  final conversation = await hpke.open(preKey, info, _conversationAad, mine.conversationKey);
  return conversation?.length == 32 ? (announcement: announcement, conversation: conversation) : null;
}

// --- requests ---

Uint8List _requestInfo(List<int> accountId, List<int> hostKey, List<int> keyId) =>
    framed('pirc-e2e-v1 request', [accountId, hostKey, keyId]);

// A signed envelope (objects.encode of the "request" kind), sealed to a process's request key.
Future<Uint8List> sealEnvelope(List<int> requestKey, List<int> accountId, List<int> hostKey, List<int> keyId,
        List<int> signed, {hpke.X25519Pair? ephemeral}) =>
    hpke.seal(requestKey, _requestInfo(accountId, hostKey, keyId), empty, signed, ephemeral: ephemeral);

Future<Uint8List?> openEnvelope(
        hpke.X25519Pair requestKey, List<int> accountId, List<int> hostKey, List<int> keyId, List<int> sealed) =>
    hpke.open(requestKey, _requestInfo(accountId, hostKey, keyId), empty, sealed);

// --- labels ---

List<List<int>> _labelKeyParts(LabelKeyRef ref) => [u64(ref.version.number), ref.version.hash];

Uint8List _labelsAad(List<int> accountId, LabelKeyRef ref, Int64 counter) =>
    framed('pirc-e2e-v1 labels', [accountId, ..._labelKeyParts(ref), u64(counter)]);

// A random 12-byte nonce, then the ciphertext: several clients write under one key.
Future<Uint8List> sealLabels(List<int> labelKey, List<int> accountId, LabelKeyRef ref, Int64 counter, Labels labels,
    {List<int>? nonce}) async {
  final n = nonce ?? random(12);
  return concat([n, await hpke.aesSeal(labelKey, n, _labelsAad(accountId, ref, counter), labels.writeToBuffer())]);
}

Future<Labels?> openLabels(List<int> labelKey, List<int> accountId, LabelKeyRef ref, Int64 counter, List<int> sealed) async {
  if (sealed.length < 12 + 16) return null;
  final plain = await hpke.aesOpen(labelKey, sealed.sublist(0, 12), _labelsAad(accountId, ref, counter), sealed.sublist(12));
  if (plain == null) return null;
  try {
    return Labels.fromBuffer(plain);
  } catch (_) {
    return null;
  }
}

Uint8List _labelKeyInfo(List<int> accountId, LabelKeyRef ref, List<int> recipient) =>
    framed('pirc-e2e-v1 label-key', [accountId, ..._labelKeyParts(ref), recipient]);

Future<Uint8List> wrapLabelKey(List<int> preKey, List<int> accountId, LabelKeyRef ref, List<int> recipient, List<int> labelKey,
        {hpke.X25519Pair? ephemeral}) =>
    hpke.seal(preKey, _labelKeyInfo(accountId, ref, recipient), empty, labelKey, ephemeral: ephemeral);

Future<Uint8List?> unwrapLabelKey(
    hpke.X25519Pair preKey, List<int> accountId, LabelKeyRef ref, List<int> me, List<int> wrap) async {
  final k = await hpke.open(preKey, _labelKeyInfo(accountId, ref, me), empty, wrap);
  return k?.length == 32 ? k : null;
}
