// HKDF-SHA256 (RFC 5869) and HPKE's base mode with DHKEM(X25519,
// HKDF-SHA256), HKDF-SHA256 and AES-256-GCM (RFC 9180), single-shot, from
// package:cryptography's pure-Dart primitives, since Dart has no HPKE.
// A port of crypto/hpke.ts, held to the CFRG's vector in cases/e2e/hpke.json.
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

import 'bytes.dart';

// The pure-Dart code on every platform, as for Ed25519.
const _sha256 = DartSha256();
const _sha512 = DartSha512();
const _hmac = DartHmac(_sha256);
final _aes = DartAesGcm(secretKeyLength: 32, nonceLength: 12);
final _x25519 = DartX25519();

Future<Uint8List> hmacSha256(List<int> key, List<int> data) async =>
    Uint8List.fromList((await _hmac.calculateMac(data, secretKey: SecretKeyData(key))).bytes);

Future<Uint8List> sha256(List<int> data) async => Uint8List.fromList((await _sha256.hash(data)).bytes);

Future<Uint8List> sha512(List<int> data) async => Uint8List.fromList((await _sha512.hash(data)).bytes);

Future<Uint8List> extract(List<int> salt, List<int> ikm) => hmacSha256(salt.isEmpty ? Uint8List(32) : salt, ikm);

Future<Uint8List> expand(List<int> prk, List<int> info, int length) async {
  if (length > 255 * 32) throw RangeError('HKDF output too long');
  final out = Uint8List(length);
  var t = Uint8List(0);
  for (var i = 1, n = 0; n < length; i++, n += 32) {
    t = await hmacSha256(prk, concat([t, info, [i]]));
    out.setRange(n, n + (length - n < 32 ? length - n : 32), t);
  }
  return out;
}

Future<Uint8List> hkdf(List<int> ikm, List<int> salt, List<int> info, int length) async =>
    expand(await extract(salt, ikm), info, length);

// --- AES-256-GCM ---

// The ciphertext followed by the 16-byte tag, as WebCrypto gives it.
Future<Uint8List> aesSeal(List<int> key, List<int> nonce, List<int> aad, List<int> plaintext) async {
  final box = await _aes.encrypt(plaintext, secretKey: SecretKeyData(key), nonce: nonce, aad: aad);
  return concat([box.cipherText, box.mac.bytes]);
}

// Null when it does not open.
Future<Uint8List?> aesOpen(List<int> key, List<int> nonce, List<int> aad, List<int> ciphertext) async {
  if (ciphertext.length < 16) return null;
  final n = ciphertext.length - 16;
  final box = SecretBox(ciphertext.sublist(0, n), nonce: nonce, mac: Mac(ciphertext.sublist(n)));
  try {
    return Uint8List.fromList(await _aes.decrypt(box, secretKey: SecretKeyData(key), aad: aad));
  } on SecretBoxAuthenticationError {
    return null;
  }
}

// --- X25519 ---

class X25519Pair {
  X25519Pair._(this.privateKey, this.publicKey, this._pair);

  final Uint8List privateKey;
  final Uint8List publicKey;
  final SimpleKeyPair _pair;
}

Future<X25519Pair> x25519Generate() => x25519FromPrivate(random(32));

// From 32 private bytes: the tests' fixed keys, and CPace's scalars.
Future<X25519Pair> x25519FromPrivate(List<int> sk) async {
  if (sk.length != 32) throw ArgumentError('an X25519 private key is 32 bytes, not ${sk.length}');
  final pair = await _x25519.newKeyPairFromSeed(sk);
  final pub = await pair.extractPublicKey();
  return X25519Pair._(Uint8List.fromList(sk), Uint8List.fromList(pub.bytes), pair);
}

// X25519(sk, pk) as package:cryptography computes it: all zeros for a
// low-order point, where WebCrypto may throw instead.
Future<Uint8List> x25519Raw(X25519Pair privateKey, List<int> publicKey) async {
  final s = await _x25519.sharedSecretKey(
      keyPair: privateKey._pair, remotePublicKey: SimplePublicKey(publicKey, type: KeyPairType.x25519));
  return Uint8List.fromList(await s.extractBytes());
}

// X25519(sk, pk), refusing an all-zero result.
Future<Uint8List> x25519(X25519Pair privateKey, List<int> publicKey) async {
  final out = await x25519Raw(privateKey, publicKey);
  if (equal(out, Uint8List(32))) throw StateError('X25519 gave the all-zero value');
  return out;
}

// --- HPKE (RFC 9180, sections 4, 5.1 and 7.1) ---

final _kemSuite = concat([utf8('KEM'), const [0x00, 0x20]]);
final _hpkeSuite = concat([utf8('HPKE'), const [0x00, 0x20, 0x00, 0x01, 0x00, 0x02]]);
final _v1 = utf8('HPKE-v1');

Future<Uint8List> _labeledExtract(List<int> suite, List<int> salt, String label, List<int> ikm) =>
    extract(salt, concat([_v1, suite, utf8(label), ikm]));

Future<Uint8List> _labeledExpand(List<int> suite, List<int> prk, String label, List<int> info, int length) =>
    expand(prk, concat([[length >> 8, length & 0xff], _v1, suite, utf8(label), info]), length);

Future<Uint8List> _extractAndExpand(List<int> dh, List<int> kemContext) async {
  final prk = await _labeledExtract(_kemSuite, empty, 'eae_prk', dh);
  return _labeledExpand(_kemSuite, prk, 'shared_secret', kemContext, 32);
}

typedef Schedule = ({Uint8List key, Uint8List baseNonce});

Future<Schedule> _keySchedule(List<int> sharedSecret, List<int> info) async {
  final pskIdHash = await _labeledExtract(_hpkeSuite, empty, 'psk_id_hash', empty);
  final infoHash = await _labeledExtract(_hpkeSuite, empty, 'info_hash', info);
  final context = concat([const [0x00], pskIdHash, infoHash]);
  final secret = await _labeledExtract(_hpkeSuite, sharedSecret, 'secret', empty);
  return (
    key: await _labeledExpand(_hpkeSuite, secret, 'key', context, 32),
    baseNonce: await _labeledExpand(_hpkeSuite, secret, 'base_nonce', context, 12),
  );
}

// enc (32 bytes) followed by the ciphertext. ephemeral only for test vectors.
Future<Uint8List> seal(List<int> recipient, List<int> info, List<int> aad, List<int> plaintext,
    {X25519Pair? ephemeral}) async {
  final e = ephemeral ?? await x25519Generate();
  final dh = await x25519(e, recipient);
  final shared = await _extractAndExpand(dh, concat([e.publicKey, recipient]));
  final s = await _keySchedule(shared, info);
  return concat([e.publicKey, await aesSeal(s.key, s.baseNonce, aad, plaintext)]);
}

// Null when it does not open.
Future<Uint8List?> open(X25519Pair recipient, List<int> info, List<int> aad, List<int> sealed) async {
  if (sealed.length < 32 + 16) return null;
  final enc = sealed.sublist(0, 32);
  Uint8List dh;
  try {
    dh = await x25519(recipient, enc);
  } catch (_) {
    return null;
  }
  final shared = await _extractAndExpand(dh, concat([enc, recipient.publicKey]));
  final s = await _keySchedule(shared, info);
  return aesOpen(s.key, s.baseNonce, aad, sealed.sublist(32));
}

// The key schedule's outputs, for the test vector.
Future<({Uint8List sharedSecret, Uint8List key, Uint8List baseNonce})> testSchedule(
    List<int> dh, List<int> enc, List<int> pkR, List<int> info) async {
  final sharedSecret = await _extractAndExpand(dh, concat([enc, pkR]));
  final s = await _keySchedule(sharedSecret, info);
  return (sharedSecret: sharedSecret, key: s.key, baseNonce: s.baseNonce);
}
