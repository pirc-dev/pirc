// The join's code and keys (docs/e2e.md, section 5, "The join's bytes"):
// nine Crockford base32 characters, four for the relay's lookup and five
// for CPace's password; CPace's key confirmed both ways, then one sealing
// key per direction, each message's additional data the transcript so far.
// A port of crypto/join.ts.
import 'dart:convert' as convert;
import 'dart:typed_data';

import '../gen/pirc/v1alpha2/e2e.pb.dart';
import 'bytes.dart';
import 'cpace.dart' as cp;
import 'ed25519.dart' as ed25519;
import 'hpke.dart' as hpke;
import 'objects.dart' as objects;
import 'utf8_check.dart';

const _alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

typedef Code = ({String lookup, String secret});

// A new code: nine characters, shown as K7QM-2XRP9.
({String lookup, String secret, String shown}) newCode() {
  final chars = [for (final b in random(9)) _alphabet[b & 31]].join();
  return (lookup: chars.substring(0, 4), secret: chars.substring(4), shown: '${chars.substring(0, 4)}-${chars.substring(4)}');
}

// A typed code in Crockford's reading: case and hyphens ignored, I and L
// read as 1, O as 0. Null unless it is nine characters.
Code? readCode(String typed) {
  final s = typed.toUpperCase().replaceAll(RegExp(r'[-\s]'), '').replaceAll(RegExp('[IL]'), '1').replaceAll('O', '0');
  if (s.length != 9 || s.split('').any((c) => !_alphabet.contains(c))) return null;
  return (lookup: s.substring(0, 4), secret: s.substring(4));
}

// CPace on package:cryptography's X25519, which gives zeros for a
// low-order point (cpace.dart's identity check catches it).
final env = cp.Env(
  x25519: (scalar, u) async => hpke.x25519Raw(await hpke.x25519FromPrivate(scalar), u),
  sha512: hpke.sha512,
  random: random,
);

Uint8List channelId(String origin, String lookup) => cp.lvCat([utf8('pirc-join-v1'), utf8(origin), utf8(lookup)]);

class JoinKeys {
  JoinKeys(this.transcript, this.deviceConfirm, this.clientConfirm, this.deviceSeal, this.clientSeal);
  final Uint8List transcript;
  final Uint8List deviceConfirm;
  final Uint8List clientConfirm;
  final Uint8List deviceSeal;
  final Uint8List clientSeal;
}

// From CPace's ISK and the four values of its exchange.
Future<JoinKeys> keys(List<int> isk, List<int> ci, List<int> nonce, List<int> ya, List<int> yb) async {
  final transcript = await hpke.sha256(framed('pirc-join-v1 transcript', [ci, nonce, ya, yb]));
  final okm = await hpke.hkdf(isk, empty, framed('pirc-join-v1 keys', [transcript]), 128);
  return JoinKeys(transcript, okm.sublist(0, 32), okm.sublist(32, 64), okm.sublist(64, 96), okm.sublist(96, 128));
}

Future<Uint8List> confirmation(List<int> confirmKey, List<int> transcript) => hpke.hmacSha256(confirmKey, transcript);

Future<bool> confirmed(List<int> confirmKey, List<int> transcript, List<int> given) async =>
    equal(await confirmation(confirmKey, transcript), given);

// One side's sealing: its key, how many it has sealed, and the transcript both sides track.
class Channel {
  Channel(this._sealKey, this._openKey, this._transcript);

  final List<int> _sealKey;
  final List<int> _openKey;
  Uint8List _transcript;
  var _sent = 0;
  var _received = 0;

  Uint8List get transcript => _transcript;

  Future<Uint8List> seal(List<int> plaintext) async {
    final ct = await hpke.aesSeal(_sealKey, _nonce(_sent++), _transcript, plaintext);
    await _advance(ct);
    return ct;
  }

  // Null when it does not open, which ends the join.
  Future<Uint8List?> open(List<int> ciphertext) async {
    final pt = await hpke.aesOpen(_openKey, _nonce(_received++), _transcript, ciphertext);
    if (pt != null) await _advance(ciphertext);
    return pt;
  }

  static Uint8List _nonce(int n) => concat([Uint8List(4), u64Of(n)]);

  Future<void> _advance(List<int> ciphertext) async {
    _transcript = await hpke.sha256(framed('pirc-join-v1 transcript', [_transcript, ciphertext]));
  }
}

Channel deviceChannel(JoinKeys k) => Channel(k.deviceSeal, k.clientSeal, k.transcript);
Channel clientChannel(JoinKeys k) => Channel(k.clientSeal, k.deviceSeal, k.transcript);

// --- the two sides of a join, step by step (relay.proto's JoinMessage
// carries each step, encoded) ---

// Why a join ended: a wrong code, a relay that changed something, or a step out of order.
class JoinFailed implements Exception {
  JoinFailed(this.message);
  final String message;

  @override
  String toString() => 'JoinFailed: $message';
}

Uint8List _step(JoinStep s) => s.writeToBuffer();

JoinStep _readStep(List<int> b) {
  try {
    return JoinStep.fromBuffer(b);
  } catch (_) {
    throw JoinFailed('an undecodable step');
  }
}

const maxNameBytes = 128;

// The device that shows the code: it offers CPace's first share, checks
// the client's confirmation, sends its own with what it is, and reads the
// approval. Forgets the code at the first failure.
class DeviceJoin {
  DeviceJoin._(this._ci, this._nonce, this._party, this._role, this._signer, this._name);

  final Uint8List _ci;
  final Uint8List _nonce;
  final cp.Party _party;
  final DeviceRole _role;
  final ed25519.Signer _signer;
  final String _name;
  Channel? _channel;
  // Set by the first answer, whatever comes of it: one try per code.
  var _answered = false;

  // The join and its first step, for a code from newCode.
  static Future<({DeviceJoin join, Uint8List offer})> start(
      String origin, Code code, {required DeviceRole role, required ed25519.Signer signer, required String name}) async {
    final ci = channelId(origin, code.lookup);
    final nonce = random(16);
    final party = await cp.start(env, prs: utf8(code.secret), ci: ci, sid: nonce, ad: empty);
    return (
      join: DeviceJoin._(ci, nonce, party, role, signer, name),
      offer: _step(JoinStep(offer: JoinOffer(nonce: nonce, share: party.share))),
    );
  }

  // The client's answer: its share and confirmation. Gives the confirm step.
  // Only the first is taken (docs/e2e.md, section 5, The code): each try
  // gives the relay one guess at the code's secret, and a wrong one leaves
  // nothing to try again.
  Future<Uint8List> onAnswer(List<int> b) async {
    if (_answered) throw JoinFailed('this code was tried already: show a new one');
    _answered = true;
    final s = _readStep(b);
    if (s.whichStep() != JoinStep_Step.answer) throw JoinFailed("expected the client's answer");
    Uint8List isk;
    try {
      isk = (await cp.finish(env, _party, cp.Role.initiator, s.answer.share, empty)).isk;
    } catch (_) {
      throw JoinFailed("the client's share is not a point to use");
    }
    final k = await keys(isk, _ci, _nonce, _party.share, s.answer.share);
    if (!await confirmed(k.clientConfirm, k.transcript, s.answer.confirmation)) throw JoinFailed('the code does not match');
    final channel = _channel = deviceChannel(k);
    final device = await objects.sign(objects.Kind.join, empty, _signer,
        JoinDeviceBody(transcript: k.transcript, role: _role, publicKey: _signer.publicKey, name: cutName(_name)));
    final sealed = await channel.seal(JoinDevice(device: device).writeToBuffer());
    return _step(JoinStep(
        confirm: JoinConfirm(
            confirmation: await confirmation(k.deviceConfirm, k.transcript), device: JoinSealed(ciphertext: sealed))));
  }

  // The client's sealed result.
  Future<JoinResult> onResult(List<int> b) async {
    final s = _readStep(b);
    final channel = _channel;
    if (s.whichStep() != JoinStep_Step.sealed || channel == null) throw JoinFailed("expected the client's result");
    final plain = await channel.open(s.sealed.ciphertext);
    if (plain == null) throw JoinFailed('the result does not open');
    final JoinResult r;
    try {
      r = JoinResult.fromBuffer(plain);
    } catch (_) {
      throw JoinFailed('an undecodable result');
    }
    if (!stringsAreUtf8(r.info_, plain)) throw JoinFailed('a result with a string that is not UTF-8');
    return r;
  }
}

// Cuts a name to 128 bytes of UTF-8, on a character boundary.
String cutName(String s) {
  final b = utf8(s);
  if (b.length <= maxNameBytes) return s;
  var end = maxNameBytes;
  while (end > 0 && (b[end] & 0xc0) == 0x80) {
    end--;
  }
  return convert.utf8.decode(b.sublist(0, end));
}

typedef JoiningDevice = ({DeviceRole role, Uint8List publicKey, String name});

// The client that types the code: it answers the offer, checks the
// device's confirmation and what the device says it is, and seals the
// person's decision.
class ClientJoin {
  ClientJoin._(this._k, this._channel);

  final JoinKeys _k;
  final Channel _channel;

  // The join and the answer step, from the code as typed and the device's offer.
  static Future<({ClientJoin join, Uint8List answer})> answer(String origin, Code code, List<int> offer) async {
    final s = _readStep(offer);
    if (s.whichStep() != JoinStep_Step.offer || s.offer.nonce.length != 16) throw JoinFailed("expected the device's offer");
    final ci = channelId(origin, code.lookup);
    final me = await cp.start(env, prs: utf8(code.secret), ci: ci, sid: s.offer.nonce, ad: empty);
    Uint8List isk;
    try {
      isk = (await cp.finish(env, me, cp.Role.responder, s.offer.share, empty)).isk;
    } catch (_) {
      throw JoinFailed("the device's share is not a point to use");
    }
    final k = await keys(isk, ci, s.offer.nonce, s.offer.share, me.share);
    return (
      join: ClientJoin._(k, clientChannel(k)),
      answer: _step(JoinStep(answer: JoinAnswer(share: me.share, confirmation: await confirmation(k.clientConfirm, k.transcript)))),
    );
  }

  // The device's confirmation and what it is: a host or a client, its key, its name.
  Future<JoiningDevice> onConfirm(List<int> b) async {
    final s = _readStep(b);
    if (s.whichStep() != JoinStep_Step.confirm) throw JoinFailed("expected the device's confirmation");
    if (!await confirmed(_k.deviceConfirm, _k.transcript, s.confirm.confirmation)) throw JoinFailed('the code does not match');
    final plain = await _channel.open(s.confirm.hasDevice() ? s.confirm.device.ciphertext : empty);
    if (plain == null) throw JoinFailed("the device's message does not open");
    SignedObject? signed;
    // JoinDevice holds bytes only; its signed body's strings are checked
    // as objects.open opens it.
    try {
      final d = JoinDevice.fromBuffer(plain);
      signed = d.hasDevice() ? d.device : null;
    } catch (_) {
      throw JoinFailed('an undecodable device');
    }
    final body = signed == null ? null : await objects.open(objects.Kind.join, empty, signed);
    if (body == null || !equal(body.transcript, _k.transcript)) throw JoinFailed("the device's signature does not check");
    if (body.role != DeviceRole.DEVICE_ROLE_HOST && body.role != DeviceRole.DEVICE_ROLE_CLIENT) {
      throw JoinFailed('the device is neither a host nor a client');
    }
    if (utf8(body.name).length > maxNameBytes) throw JoinFailed("the device's name is too long");
    return (role: body.role, publicKey: Uint8List.fromList(body.publicKey), name: body.name);
  }

  // The person's decision, sealed for the device.
  Future<Uint8List> result(JoinResult r) async =>
      _step(JoinStep(sealed: JoinSealed(ciphertext: await _channel.seal(r.writeToBuffer()))));
}
