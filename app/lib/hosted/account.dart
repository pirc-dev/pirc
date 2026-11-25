// A hosted account as this phone keeps it (docs/e2e.md, sections 3 and 5):
// its ID, its phone's signing key, the relay's origin, this phone as the
// list holds it, version 1 and the newest version of the list as signed.
// Both versions are checked on every read, as from the relay: the account's
// phone's signature, the account, and the newest's counter at least 2 or
// version 1 itself. A newer version is taken from wherever it comes, the
// relay or a computer, and only if it checks out.
//
// Kept in the prefs the notification extension shares ("hosted.v1"), so a
// list either takes is the other's too; each writes only a newer one. The
// account's phone's counter is kept apart (PhoneCounter), out of backups.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';

import '../e2e/bytes.dart';
import '../e2e/list.dart';
import '../gen/pirc/v1alpha2/account.pb.dart';

const accountKey = 'hosted.v1';

/// Where the account is kept: the app's prefs, or a map in tests.
abstract class KeyValues {
  Future<String?> get(String key);
  Future<void> set(String key, String? value);
}

class MemoryValues implements KeyValues {
  final values = <String, String>{};
  @override
  Future<String?> get(String key) async => values[key];
  @override
  Future<void> set(String key, String? value) async => value == null ? values.remove(key) : values[key] = value;
}

/// What was kept could not be read as an account: the person makes a new
/// one, or joins again.
class AccountUnreadable implements Exception {
  const AccountUnreadable(this.reason);
  final String reason;
  @override
  String toString() => 'the account kept on this phone cannot be read: $reason';
}

/// A version of the list, checked.
class HeldList {
  const HeldList(this.bytes, this.counter, this.body);
  final Uint8List bytes;
  final Int64 counter;
  final ListBody body;
}

/// What a version offered came to: newer (taken), old (as held or
/// older), or refused, with why.
sealed class Taken {
  const Taken();
}

class TakenNewer extends Taken {
  const TakenNewer(this.list);
  final HeldList list;
}

class TakenOld extends Taken {
  const TakenOld();
}

class TakenRefused extends Taken {
  const TakenRefused(this.reason);
  final String reason;
}

String _b64(List<int> b) => base64Url.encode(b).replaceAll('=', '');

Uint8List _unb64(Object? v, String what) {
  if (v is! String) throw AccountUnreadable('$what is missing');
  try {
    return base64Url.decode(base64Url.normalize(v));
  } on FormatException {
    throw AccountUnreadable('$what is not base64url');
  }
}

bool sameDevice(Device a, Device b) =>
    a.role == b.role &&
    bytesEqual(a.signingKey, b.signingKey) &&
    bytesEqual(a.channelKey, b.channelKey) &&
    bytesEqual(a.boxKey, b.boxKey) &&
    bytesEqual(a.readOnlyKey, b.readOnlyKey) &&
    bytesEqual(a.notificationKey, b.notificationKey);

class HostedAccount {
  HostedAccount._(this._e2e, this._values, this._newest, {required this.origin, required this.accountId, required this.phoneKey, required this.self, required this.first});

  final E2e _e2e;
  final KeyValues _values;
  final String origin;
  final Uint8List accountId;

  /// The account's phone's signing key, which signs every version.
  final Uint8List phoneKey;

  /// This phone as the list holds it.
  final Device self;

  /// Version 1, as signed.
  final Uint8List first;
  HeldList _newest;
  final _changes = StreamController<HeldList>.broadcast(sync: true);
  Future<void> _writing = Future.value();

  HeldList get newest => _newest;

  /// Whether this phone is the account's phone, which alone signs versions.
  bool get isPhone => bytesEqual(self.signingKey, phoneKey);

  /// Whether the newest version still has this phone, exactly as it is.
  bool get listed => _newest.body.devices.any((d) => sameDevice(d, self));

  /// Each newer version taken, in order.
  Stream<HeldList> get changes => _changes.stream;

  /// The account kept, checked; null when there is none. Throws
  /// AccountUnreadable when what is kept does not check out.
  static Future<HostedAccount?> load(E2e e2e, KeyValues values) async {
    final text = await values.get(accountKey);
    if (text == null) return null;
    final Map<String, Object?> f;
    try {
      f = jsonDecode(text) as Map<String, Object?>;
    } on Object {
      throw const AccountUnreadable('not JSON');
    }
    final origin = f['origin'];
    if (origin is! String || origin.isEmpty) throw const AccountUnreadable('origin is missing');
    final accountId = _unb64(f['accountId'], 'accountId');
    final phoneKey = _unb64(f['phoneKey'], 'phoneKey');
    final Device self;
    try {
      self = Device.fromBuffer(_unb64(f['self'], 'self'));
    } on AccountUnreadable {
      rethrow;
    } on Object {
      throw const AccountUnreadable('self does not parse');
    }
    final first = _unb64(f['first'], 'first');
    final newest = _check(e2e, accountId: accountId, phoneKey: phoneKey, first: first, newest: _unb64(f['newest'], 'newest'));
    return HostedAccount._(e2e, values, newest, origin: origin, accountId: accountId, phoneKey: phoneKey, self: self, first: first);
  }

  /// A new account kept, after signing up or joining: [first] is version
  /// 1, [newest] the newest the device has, which may be version 1 too.
  static Future<HostedAccount> create(
    E2e e2e,
    KeyValues values, {
    required String origin,
    required Uint8List accountId,
    required Uint8List phoneKey,
    required Device self,
    required Uint8List first,
    required Uint8List newest,
  }) async {
    final held = _check(e2e, accountId: accountId, phoneKey: phoneKey, first: first, newest: newest);
    final a = HostedAccount._(e2e, values, held, origin: origin, accountId: accountId, phoneKey: phoneKey, self: self, first: first);
    await a._write();
    return a;
  }

  static HeldList _check(E2e e2e, {required Uint8List accountId, required Uint8List phoneKey, required Uint8List first, required Uint8List newest}) {
    final one = e2e.checkList(bytes: first, phoneKey: phoneKey, mode: ListMode.first, accountId: accountId, highest: Int64.ZERO);
    if (one.result != 'accepted') throw AccountUnreadable('version 1 is ${one.result} (${one.reason})');
    if (bytesEqual(newest, first)) return HeldList(Uint8List.fromList(first), Int64.ONE, one.list!);
    final n = e2e.checkList(bytes: newest, phoneKey: phoneKey, mode: ListMode.later, accountId: accountId, highest: Int64.ONE);
    if (n.result != 'accepted') throw AccountUnreadable('the newest version is ${n.result} (${n.reason})');
    return HeldList(Uint8List.fromList(newest), n.counter!, n.list!);
  }

  /// A version from the relay or a computer: kept if newer and it checks out.
  Future<Taken> take(List<int> bytes) async {
    final Taken t;
    if (bytesEqual(bytes, _newest.bytes) || bytesEqual(bytes, first)) {
      t = const TakenOld();
    } else {
      final r = _e2e.checkList(bytes: bytes, phoneKey: phoneKey, mode: ListMode.later, accountId: accountId, highest: _newest.counter);
      t = switch (r.result) {
        'accepted' => TakenNewer(HeldList(Uint8List.fromList(bytes), r.counter!, r.list!)),
        'old' => const TakenOld(),
        _ => TakenRefused('${r.result} (${r.reason})'),
      };
    }
    if (t is TakenNewer) {
      _newest = t.list;
      _changes.add(t.list);
      await _write();
    }
    return t;
  }

  // In order, so that an older write never lands after a newer one; and
  // never over a newer version another writer (the notification
  // extension) kept meanwhile.
  Future<void> _write() => _writing = _writing.then((_) async {
        final kept = await _values.get(accountKey);
        if (kept != null) {
          try {
            final f = jsonDecode(kept) as Map<String, Object?>;
            if (_b64(accountId) == f['accountId']) {
              final other = _unb64(f['newest'], 'newest');
              final r = _e2e.checkList(bytes: other, phoneKey: phoneKey, mode: ListMode.later, accountId: accountId, highest: _newest.counter);
              if (r.result == 'accepted') return;
            }
          } on Object {
            // Unreadable: written over.
          }
        }
        await _values.set(accountKey, jsonEncode(_json()));
      });

  Map<String, Object?> _json() => {
        'origin': origin,
        'accountId': _b64(accountId),
        'phoneKey': _b64(phoneKey),
        'self': _b64(self.writeToBuffer()),
        'first': _b64(first),
        'newest': _b64(_newest.bytes),
      };

  /// Forgets the account: after deleting it, or on leaving it.
  Future<void> forget() async {
    await _writing;
    await _values.set(accountKey, null);
    await _changes.close();
  }
}

/// The account's phone's counter (docs/e2e.md, section 3), saved before
/// each signature, in a file out of backups, so that neither a restored
/// backup nor a crash signs two versions with one counter.
abstract class PhoneCounter {
  /// The next counter, at least [atLeast], saved before it is returned.
  Future<Int64> next(Int64 atLeast);
}

class MemoryCounter implements PhoneCounter {
  Int64 last = Int64.ZERO;
  @override
  Future<Int64> next(Int64 atLeast) async {
    final n = last + 1 > atLeast ? last + 1 : atLeast;
    last = n;
    return n;
  }
}

/// The counter in a file of the private folder (app/files.dart), written
/// aside, flushed, then renamed over the old one.
class FileCounter implements PhoneCounter {
  FileCounter(this.path, {this.protect});

  final String path;

  /// Gives a file the folder's protection again, after the rename.
  final Future<void> Function(String path)? protect;
  Future<Int64>? _last;

  Future<Int64> _read() async {
    try {
      final v = Int64.parseInt((await File(path).readAsString()).trim());
      return v.isNegative ? throw const FormatException('negative') : v;
    } on PathNotFoundException {
      return Int64.ZERO;
    }
  }

  @override
  Future<Int64> next(Int64 atLeast) {
    final prev = _last ?? _read();
    final n = _last = prev.then((last) async {
      final n = last + 1 > atLeast ? last + 1 : atLeast;
      final tmp = File('$path.new');
      final f = await tmp.open(mode: FileMode.write);
      try {
        await f.writeString('$n\n');
        await f.flush();
      } finally {
        await f.close();
      }
      await tmp.rename(path);
      await protect?.call(path);
      return n;
    });
    // A failed write leaves the file as it was, to be read again.
    n.then((_) {}, onError: (Object _) {
      if (identical(_last, n)) _last = null;
    });
    return n;
  }
}
