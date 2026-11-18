// The join's code and keys (docs/e2e.md, section 5, "The join's bytes"):
// nine Crockford base32 characters, four for the relay's lookup and five
// for CPace's password; CPace's key confirmed both ways, then one sealing
// key per direction, each message's additional data the transcript so far.
// A port of crypto/join.ts.
import 'dart:typed_data';

import 'bytes.dart';
import 'cpace.dart' as cp;
import 'hpke.dart' as hpke;

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
