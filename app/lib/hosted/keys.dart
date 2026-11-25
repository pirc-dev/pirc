// A phone's keys in a hosted account (docs/e2e.md, section 2), made from
// the two seeds the key store already keeps, so that each key is kept as
// its seed is: the main seed, behind Face ID or the PIN on this device
// only, gives the signing, channel and box keys; the read seed, readable
// from the first unlock, the read-only key and the notification key. Each
// key's own seed is libsodium's crypto_kdf_derive_from_key of its stored
// seed, under a context and number of its own, so no two keys share one.
import 'dart:typed_data';

import 'package:sodium/sodium_sumo.dart' show KeyPair, SecureKey, SodiumSumo;

import '../e2e/list.dart' show roleClient;
import '../gen/pirc/v1alpha2/account.pb.dart';

/// crypto_kdf's context: eight bytes.
const _mainContext = 'pircmain';
const _readContext = 'pircread';
const seedBytes = 32;

enum _MainKey { signing, channel, box }

enum _ReadKey { readOnly, notification }

SecureKey _derive(SodiumSumo sodium, Uint8List seed, String context, int id) {
  final master = sodium.secureCopy(seed);
  try {
    return sodium.crypto.kdf.deriveFromKey(masterKey: master, context: context, subkeyId: BigInt.from(id + 1), subkeyLen: seedBytes);
  } finally {
    master.dispose();
  }
}

KeyPair _pair(SodiumSumo sodium, Uint8List seed, String context, int id, {required bool sign}) {
  if (seed.length != seedBytes) throw ArgumentError('a seed is $seedBytes bytes, not ${seed.length}');
  final s = _derive(sodium, seed, context, id);
  try {
    return sign ? sodium.crypto.sign.seedKeyPair(s) : sodium.crypto.box.seedKeyPair(s);
  } finally {
    s.dispose();
  }
}

/// The keys the main seed gives, held while the app is unlocked.
class MainKeys {
  MainKeys._(this._sodium, this.signing, this.channel, this.box);

  factory MainKeys.fromSeed(SodiumSumo sodium, Uint8List seed) => MainKeys._(
        sodium,
        _pair(sodium, seed, _mainContext, _MainKey.signing.index, sign: true),
        _pair(sodium, seed, _mainContext, _MainKey.channel.index, sign: false),
        _pair(sodium, seed, _mainContext, _MainKey.box.index, sign: false),
      );

  final SodiumSumo _sodium;
  final KeyPair signing;
  final KeyPair channel;
  final KeyPair box;

  Uint8List sign(Uint8List message) => _sodium.crypto.sign.detached(message: message, secretKey: signing.secretKey);

  void dispose() {
    for (final k in [signing, channel, box]) {
      k.secretKey.dispose();
    }
  }
}

/// The keys the read seed gives: a woken phone's.
class ReadKeys {
  ReadKeys._(this._sodium, this.readOnly, this.notification);

  factory ReadKeys.fromSeed(SodiumSumo sodium, Uint8List seed) => ReadKeys._(
        sodium,
        _pair(sodium, seed, _readContext, _ReadKey.readOnly.index, sign: true),
        _pair(sodium, seed, _readContext, _ReadKey.notification.index, sign: false),
      );

  final SodiumSumo _sodium;
  final KeyPair readOnly;
  final KeyPair notification;

  Uint8List sign(Uint8List message) => _sodium.crypto.sign.detached(message: message, secretKey: readOnly.secretKey);

  void dispose() {
    readOnly.secretKey.dispose();
    notification.secretKey.dispose();
  }
}

/// The phone as the list holds it: a client with all five public keys.
/// The read-only and notification keys come from the read seed, which a
/// phone always has beside its main seed.
Device phoneDevice(MainKeys main, ReadKeys read) => Device(
      role: roleClient,
      signingKey: main.signing.publicKey,
      channelKey: main.channel.publicKey,
      boxKey: main.box.publicKey,
      readOnlyKey: read.readOnly.publicKey,
      notificationKey: read.notification.publicKey,
    );
