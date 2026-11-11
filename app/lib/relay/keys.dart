// A device's Ed25519 key: the 32-byte seed it is made from, and the raw
// public key the relay knows it by. Where the seed is kept (the Keychain,
// the Keystore) is the app's business, not this file's.
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

class DeviceKey {
  DeviceKey._(this.seed, this.publicKey, this._pair);

  final Uint8List seed;
  final Uint8List publicKey;
  final SimpleKeyPair _pair;

  static final _ed25519 = Ed25519();

  static Future<DeviceKey> fromSeed(List<int> seed) async {
    if (seed.length != 32) throw ArgumentError('an Ed25519 seed is 32 bytes, not ${seed.length}');
    final pair = await _ed25519.newKeyPairFromSeed(seed);
    final pub = await pair.extractPublicKey();
    return DeviceKey._(Uint8List.fromList(seed), Uint8List.fromList(pub.bytes), pair);
  }

  static Future<DeviceKey> generate() async {
    final pair = await _ed25519.newKeyPair();
    return fromSeed(await pair.extractPrivateKeyBytes());
  }

  Future<Uint8List> sign(List<int> data) async =>
      Uint8List.fromList((await _ed25519.sign(data, keyPair: _pair)).bytes);
}
