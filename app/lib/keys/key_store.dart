// Where the phone keeps its keys (docs/design.md, section 12, step 13):
// the main key, released only after Face ID, a fingerprint or the device's
// PIN when the lock is on, and the read-only key a woken phone logs in
// with, readable from the first unlock. Seeds are made here; the platform
// only keeps them: on iOS in the Keychain, on Android in a file encrypted
// with a Keystore key (ios/Runner, android/app, over the channel below).
import 'dart:io';

import 'package:flutter/services.dart';

enum KeyKind { main, read }

// Why a key could not be had.
class KeyUnavailable implements Exception {
  const KeyUnavailable(this.reason, {this.cancelled = false});
  final String reason;
  // The person dismissed Face ID or the PIN.
  final bool cancelled;
  @override
  String toString() => 'KeyUnavailable: $reason';
}

abstract class KeyStore {
  // Keeps a seed for the relay. A main key kept with protect is released
  // only after the person proves they are there. Throws KeyUnavailable when
  // it cannot be kept so (no passcode), or the person declines.
  Future<void> store(String relay, KeyKind kind, Uint8List seed, {required bool protect});

  // A key's seed; null when there is none. A protected main key asks the
  // person first, with reason, and throws KeyUnavailable if they decline.
  Future<Uint8List?> load(String relay, KeyKind kind, {String reason = ''});

  // Forgets both of the relay's keys.
  Future<void> delete(String relay);

  // What the phone asks with, as the lock's switch names it: "face" or
  // "touch" (Face ID, Touch ID) or "none" (only the passcode) on iOS;
  // "fingerprint" on Android, which picks for itself.
  Future<String> biometry();
}

// The platform's store, over a method channel.
class ChannelKeyStore implements KeyStore {
  ChannelKeyStore([this.channel = const MethodChannel('dev.pirc.app/keys')]);

  final MethodChannel channel;

  @override
  Future<void> store(String relay, KeyKind kind, Uint8List seed, {required bool protect}) async {
    try {
      await channel.invokeMethod('store', {'relay': relay, 'kind': kind.name, 'seed': seed, 'protect': protect});
    } on PlatformException catch (e) {
      // No passcode to lock it with ("no-passcode"), or, on Android, the
      // person declining to lock it.
      throw KeyUnavailable(e.message ?? e.code, cancelled: e.code == 'cancelled');
    }
  }

  @override
  Future<Uint8List?> load(String relay, KeyKind kind, {String reason = ''}) async {
    try {
      return await channel.invokeMethod<Uint8List>('load', {'relay': relay, 'kind': kind.name, 'reason': reason});
    } on PlatformException catch (e) {
      throw KeyUnavailable(e.message ?? e.code, cancelled: e.code == 'cancelled');
    }
  }

  @override
  Future<void> delete(String relay) => channel.invokeMethod('delete', {'relay': relay});

  @override
  Future<String> biometry() async => Platform.isIOS ? await channel.invokeMethod<String>('biometry') ?? 'none' : 'fingerprint';
}

// A stand-in store in memory, for tests and for screens before the
// platform's halves exist. Asks no one: decline makes the next protected
// load be declined, as a person dismissing Face ID would.
class MemoryKeyStore implements KeyStore {
  final _seeds = <(String, KeyKind), (Uint8List, bool)>{};
  var decline = false;
  var asked = 0;

  @override
  Future<void> store(String relay, KeyKind kind, Uint8List seed, {required bool protect}) async =>
      _seeds[(relay, kind)] = (Uint8List.fromList(seed), protect);

  @override
  Future<Uint8List?> load(String relay, KeyKind kind, {String reason = ''}) async {
    final s = _seeds[(relay, kind)];
    if (s == null) return null;
    if (s.$2) {
      asked++;
      if (decline) throw const KeyUnavailable('declined', cancelled: true);
    }
    return s.$1;
  }

  @override
  Future<void> delete(String relay) async => _seeds.removeWhere((k, _) => k.$1 == relay);

  @override
  Future<String> biometry() async => 'face';

  // Whether the relay's main key is kept protected; null when there is none.
  bool? protected(String relay) => _seeds[(relay, KeyKind.main)]?.$2;
}
