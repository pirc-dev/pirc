// Ed25519, verified strictly and alike on every platform (docs/e2e.md,
// section 2): byte checks first, then the verify of package:cryptography's
// pure-Dart Ed25519, which computes the cofactorless equation. The app
// takes that package from third_party/dart-cryptography, whose point
// comparison is fixed; without the fix it accepts signatures nothing else
// does. The checks are the same as crypto/ed25519.ts's, and
// cases/e2e/ed25519.json holds what all of them must decide.
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:cryptography/dart.dart';

import 'bytes.dart';

// The pure-Dart code on every platform, never a plugin's, so that the
// app decides as its tests do.
final _ed25519 = DartEd25519(sha512: const DartSha512());

// The group order L and the field prime p, little-endian.
final _l = unhex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
final _p = unhex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f');

// Every encoding of a small-order point once y < p is checked: the eight
// canonical ones, and the two with x = 0 and the sign bit set.
final _smallOrder = [
  '0100000000000000000000000000000000000000000000000000000000000000',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0000000000000000000000000000000000000000000000000000000000000080',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  '0100000000000000000000000000000000000000000000000000000000000080',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
].map(unhex).toList();

bool _lessLE(List<int> a, List<int> b) {
  for (var i = 31; i >= 0; i--) {
    if (a[i] != b[i]) return a[i] < b[i];
  }
  return false;
}

bool _pointOK(List<int> b) {
  final y = Uint8List.fromList(b);
  y[31] &= 0x7f;
  return _lessLE(y, _p) && !_smallOrder.any((s) => equal(b, s));
}

// Null if the signature may go to the verify, or why not.
String? precheck(List<int> publicKey, List<int> signature) {
  if (publicKey.length != 32 || signature.length != 64) return 'length';
  if (!_lessLE(signature.sublist(32), _l)) return 'S is not below L';
  if (!_pointOK(publicKey)) return 'the key is non-canonical or of small order';
  if (!_pointOK(signature.sublist(0, 32))) return 'R is non-canonical or of small order';
  return null;
}

Future<bool> verify(List<int> publicKey, List<int> message, List<int> signature) async {
  if (precheck(publicKey, signature) != null) return false;
  try {
    return await _ed25519.verify(message,
        signature: Signature(signature, publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519)));
  } catch (_) {
    return false;
  }
}

// A signing key: its public key, and signing with it.
abstract interface class Signer {
  Uint8List get publicKey;
  Future<Uint8List> sign(List<int> message);
}

// A Signer from a 32-byte seed, as the device keys and the tests keep it.
class SeedSigner implements Signer {
  SeedSigner._(this.publicKey, this._pair);

  @override
  final Uint8List publicKey;
  final SimpleKeyPair _pair;

  static Future<SeedSigner> fromSeed(List<int> seed) async {
    if (seed.length != 32) throw ArgumentError('an Ed25519 seed is 32 bytes, not ${seed.length}');
    final pair = await _ed25519.newKeyPairFromSeed(seed);
    final pub = await pair.extractPublicKey();
    return SeedSigner._(Uint8List.fromList(pub.bytes), pair);
  }

  static Future<SeedSigner> generate() => fromSeed(random(32));

  @override
  Future<Uint8List> sign(List<int> message) async =>
      Uint8List.fromList((await _ed25519.sign(message, keyPair: _pair)).bytes);
}
