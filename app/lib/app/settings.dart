// This phone's settings (docs/design.md, section 12, step 13), kept on it:
// the lock, how long an unlocked key is held, and notifications. Changing
// the lock keeps the main key again, protected or not; turning
// notifications off unregisters this phone's push at the relay.
import 'package:flutter/foundation.dart';

import '../keys/key_store.dart';
import '../push/push.dart';
import '../relay/keys.dart';
import 'app.dart';
import 'outside.dart';

// How long an unlocked key may be held, as the switch offers them.
const holds = [Duration.zero, Duration(minutes: 5), Duration(minutes: 30), Duration(hours: 1), Duration(hours: 4)];

class PhoneSettings extends ChangeNotifier {
  PhoneSettings._(this.store, this.prefs, this.push, this.resync, this.lock, this.hold, this.notify, this.biometry);

  static Future<PhoneSettings> load({required KeyStore store, required AppPrefs prefs, PushPlatform? push, VoidCallback? resync, bool protect = true}) async {
    String biometry;
    try {
      biometry = await store.biometry();
    } on Object {
      biometry = 'none';
    }
    return PhoneSettings._(store, prefs, push, resync ?? () {}, protect && await prefs.locks(), await prefs.hold(), await prefs.notifies(), biometry);
  }

  final KeyStore store;
  final AppPrefs prefs;
  // None in tests without notifications.
  final PushPlatform? push;
  // Brings the relay's push registration in step (Notifications.answered).
  final VoidCallback resync;
  // What the phone asks with (KeyStore.biometry).
  final String biometry;

  // Whether the main key asks for the person.
  bool lock;
  Duration hold;
  // Whether notifications are on here; they show only if the phone allows
  // them too (permission).
  bool notify;
  Permission? permission;
  var busy = false;
  // Why the last change could not be made.
  String? lockProblem;

  // The relay joined and its main key, once unlocked: what a change of the
  // lock keeps again.
  String? relay;
  DeviceKey? key;

  // The lock's name, after "Lock with".
  String get lockWith => switch (biometry) {
        'face' => 'Face ID',
        'touch' => 'Touch ID',
        'fingerprint' => 'a fingerprint',
        _ => 'the passcode',
      };

  bool get notifying => notify && permission == Permission.granted;

  // The phone's permission, again: on opening and back from its Settings.
  Future<void> checkPermission() async {
    Permission? p;
    try {
      p = await push?.permission();
    } on Object {
      p = null;
    }
    if (p == permission) return;
    permission = p;
    notifyListeners();
  }

  // Turns the lock on or off. Off asks for the person first, as unlocking
  // does; on, the phone may refuse for want of a passcode, and Android asks
  // to lock the key. Either way the key is kept again, and kept as it was if
  // that fails (the platform keeps the old until the new is written).
  Future<void> setLock(bool on) async {
    final relay = this.relay, key = this.key;
    if (on == lock || busy || relay == null || key == null) return;
    busy = true;
    lockProblem = null;
    notifyListeners();
    try {
      if (!on) await goingOutside(() => store.load(relay, KeyKind.main, reason: 'Turn off the lock'));
      // Said first, so that a key kept the new way is never taken for the
      // old; put back if it is not.
      await prefs.setLocks(on);
      try {
        await goingOutside(() => store.store(relay, KeyKind.main, key.seed, protect: on));
      } on KeyUnavailable {
        await prefs.setLocks(!on);
        rethrow;
      }
      lock = on;
    } on KeyUnavailable catch (e) {
      if (!e.cancelled) lockProblem = e.reason;
    } on Object catch (e) {
      lockProblem = '$e';
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> setHold(Duration d) async {
    if (d == hold) return;
    hold = d;
    notifyListeners();
    await prefs.setHold(d);
  }

  // Turns notifications on or off here. On asks the phone first if it does
  // not allow them yet; off unregisters at the relay.
  Future<void> setNotify(bool on) async {
    final push = this.push;
    if (push == null || busy) return;
    busy = true;
    notify = on;
    notifyListeners();
    try {
      await prefs.setNotifies(on);
      if (on && permission != Permission.granted) {
        await goingOutside(push.ask);
        permission = await push.permission();
      }
      resync();
    } on Object {
      // The phone did not answer: as it was.
      permission = null;
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<void> openPhoneSettings() async => push?.openSettings();
}
