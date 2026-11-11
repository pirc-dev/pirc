// The main key while the app is in use: unlocked on opening, held, and
// forgotten after a time (30 minutes by default, as the web app's sign-in),
// so that the next use asks for Face ID or the PIN again.
import 'dart:async';

import '../relay/keys.dart';
import 'key_store.dart';

class KeyHolder {
  KeyHolder(this.store, this.relay, {this.holdFor = const Duration(minutes: 30), this.protect = true});

  final KeyStore store;
  final String relay;
  // How long an unlocked key is held; Duration.zero asks every time.
  Duration holdFor;
  // Whether the main key asks for the person; the Settings switch.
  final bool protect;

  DeviceKey? _key;
  Timer? _forget;

  // Makes the phone's two keys for joining a relay, and keeps them.
  static Future<({DeviceKey main, DeviceKey read})> create(KeyStore store, String relay, {bool protect = true}) async {
    final main = await DeviceKey.generate();
    final read = await DeviceKey.generate();
    await store.store(relay, KeyKind.main, main.seed, protect: protect);
    await store.store(relay, KeyKind.read, read.seed, protect: false);
    return (main: main, read: read);
  }

  // The main key, asking for the person if it is not held; null when the
  // phone has none for this relay. Throws KeyUnavailable if they decline.
  Future<DeviceKey?> unlock({String reason = 'Unlock PiRC'}) async {
    if (_key != null) {
      _hold();
      return _key;
    }
    final seed = await store.load(relay, KeyKind.main, reason: reason);
    if (seed == null) return null;
    final key = await DeviceKey.fromSeed(seed);
    if (holdFor > Duration.zero) {
      _key = key;
      _hold();
    }
    return key;
  }

  bool get held => _key != null;

  // Forgets the key now, as when the app goes to the background for good.
  void forget() {
    _forget?.cancel();
    _key = null;
  }

  void _hold() {
    _forget?.cancel();
    _forget = Timer(holdFor, forget);
  }
}
