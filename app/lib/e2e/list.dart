// A version of an account's device list (docs/e2e.md, sections 3 and 6):
// the check, the signature first on the bytes as received, then the body;
// and the account's phone's maker of a version. The steps, their order and
// the names of results and reasons are those of e2e/list.ts. No input bytes
// make the check throw; only a caller's mistake does.
import 'dart:async';
import 'dart:ffi';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:fixnum/fixnum.dart';
// The raw bindings, for SHA-256: the package's API has none.
import 'package:sodium/sodium.ffi.dart' show LibSodiumFFI;
import 'package:sodium/sodium_sumo.dart';

import '../gen/pirc/v1alpha2/account.pb.dart';
import 'framed.dart';

const listContext = 'pirc-e2e-v2 list';
const signatureBytes = 64;
const listMaxBytes = 16384;
const maxClients = 10;
const maxComputers = 50;
const roleComputer = 1;
const roleClient = 2;

const _keyBytes = 32;
const _accountIdBytes = 32;

enum ListMode { first, later }

/// What a check gives: [result] is accepted, old, unsupported or refused;
/// [reason] is set for unsupported and refused; [counter] and [hash] for
/// every result but refused; [list] for accepted only.
class ListResult {
  const ListResult._(this.result, {this.reason, this.counter, this.hash, this.list});

  final String result;
  final String? reason;
  final Int64? counter;
  final Uint8List? hash;
  final ListBody? list;

  static ListResult _refused(String reason) => ListResult._('refused', reason: reason);
}

/// A caller's mistake in what it passed to [E2e.checkList] or [E2e.makeList].
class ListCallError extends ArgumentError {
  ListCallError(String super.message);
}

bool _equal(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) {
    d |= a[i] ^ b[i];
  }
  return d == 0;
}

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

/// A device with only its fields that hold something set, and no unknown field.
Device _canonical(Device d) {
  List<int>? key(List<int> k) => k.isEmpty ? null : k;
  return Device(
    role: d.role == 0 ? null : d.role,
    signingKey: key(d.signingKey),
    channelKey: key(d.channelKey),
    boxKey: key(d.boxKey),
    readOnlyKey: key(d.readOnlyKey),
    notificationKey: key(d.notificationKey),
  );
}

bool _sameDevice(Device d, Device self) =>
    d.role == self.role &&
    _equal(d.signingKey, self.signingKey) &&
    _equal(d.channelKey, self.channelKey) &&
    _equal(d.boxKey, self.boxKey) &&
    _equal(d.readOnlyKey, self.readOnlyKey) &&
    _equal(d.notificationKey, self.notificationKey);

/// The checks over libsodium. Make one with [E2e.load].
class E2e {
  E2e._(this._sodium);

  final SodiumSumo _sodium;
  final LibSodiumFFI _ffi = const LibSodiumFFI();

  static Future<E2e>? _loaded;

  /// The checks, once libsodium has started; every call gives the same one,
  /// and a failed start is tried again on the next call.
  static Future<E2e> load() => loadWith(SodiumSumoInit.init);

  /// [load] with the start given, for the tests.
  @visibleForTesting
  static Future<E2e> loadWith(FutureOr<SodiumSumo> Function() init) {
    final loaded = _loaded;
    if (loaded != null) return loaded;
    // The start may throw before it returns a future; the async closure
    // turns that into a failed future, kept only until it has failed.
    Future<E2e> start() async => E2e._(await init());
    final started = start();
    _loaded = started;
    started.then((_) {}, onError: (Object _) {
      if (identical(_loaded, started)) _loaded = null;
    });
    return started;
  }

  /// Forgets the checks [load] gave, for the tests.
  @visibleForTesting
  static void forget() => _loaded = null;

  /// SHA-256, through libsodium's raw bindings: the package's API has none.
  Uint8List sha256(List<int> message) => using((arena) {
        final n = message.length;
        final input = arena<UnsignedChar>(n == 0 ? 1 : n);
        input.cast<Uint8>().asTypedList(n == 0 ? 1 : n).setRange(0, n, message);
        final out = arena<UnsignedChar>(32);
        if (_ffi.crypto_hash_sha256(out, input, n) != 0) throw StateError('crypto_hash_sha256 failed');
        return Uint8List.fromList(out.cast<Uint8>().asTypedList(32));
      });

  bool _verify(List<int> signature, Uint8List message, List<int> key) {
    try {
      return _sodium.crypto.sign.verifyDetached(message: message, signature: Uint8List.fromList(signature), publicKey: Uint8List.fromList(key));
    } catch (_) {
      return false;
    }
  }

  /// Checks a version of the device list. [accountId] is 32 bytes: optional
  /// in first mode (version 1's body must then hash to it), required in
  /// later mode. [highest] is the highest counter held, 0 if none. [self] is
  /// the joining device, in later mode only.
  ListResult checkList({
    required List<int> bytes,
    required List<int> phoneKey,
    required ListMode mode,
    List<int>? accountId,
    required Int64 highest,
    Device? self,
  }) {
    if (mode == ListMode.first && self != null) throw ListCallError('self is checked in later mode only');
    if (mode == ListMode.later ? accountId?.length != _accountIdBytes : accountId != null && accountId.length != _accountIdBytes) {
      throw ListCallError('the account ID is 32 bytes, and later mode needs it');
    }
    if (highest.isNegative) throw ListCallError('highest is 0 to 2^63-1');

    // 1. Size, before anything is read.
    if (bytes.length < signatureBytes || bytes.length > listMaxBytes) return ListResult._refused('size');
    // One copy of the caller's bytes, so that nothing read from them can
    // change while they are checked or after.
    final copy = Uint8List.fromList(bytes);
    final signature = Uint8List.sublistView(copy, 0, signatureBytes);
    final body = Uint8List.sublistView(copy, signatureBytes);

    // 2. The signature, over the body as received; only then the parse.
    final signedId = mode == ListMode.first ? const <int>[] : accountId!;
    if (!_verify(signature, framed(listContext, [signedId, body]), phoneKey)) return ListResult._refused('signature');
    final ListBody list;
    try {
      list = ListBody.fromBuffer(body);
    } catch (_) {
      return ListResult._refused('parse');
    }
    return _checkBody(list, sha256(body), phoneKey, mode, accountId, highest, self);
  }

  ListResult _checkBody(ListBody list, Uint8List hash, List<int> phoneKey, ListMode mode, List<int>? accountId, Int64 highest, Device? self) {
    final counter = list.counter;
    // 3. The counter's range, before it is compared with anything: Dart
    // reads a uint64 of 2^63 or more as negative.
    if (counter.isNegative) return ListResult._refused('range');

    // 4. The mode and the body agree.
    if (mode == ListMode.first) {
      if (counter != Int64.ONE || list.accountId.isNotEmpty || list.previousHash.isNotEmpty || (accountId != null && !_equal(hash, accountId))) {
        return ListResult._refused('mode');
      }
    } else if (counter < 2 || !_equal(list.accountId, accountId!) || list.previousHash.length != _keyBytes) {
      return ListResult._refused('mode');
    }

    // 5. Newer than what is held.
    if (counter <= highest) return ListResult._('old', counter: counter, hash: hash);
    ListResult unsupported(String reason) => ListResult._('unsupported', reason: reason, counter: counter, hash: hash);
    final devices = list.devices;

    // 6. No unknown field, in the body or in any device.
    if (list.unknownFields.isNotEmpty || devices.any((d) => d.unknownFields.isNotEmpty)) return unsupported('unknown-field');

    // 7. Roles.
    if (devices.any((d) => d.role != roleComputer && d.role != roleClient)) return unsupported('role');

    // 8. The three keys every device has.
    if (devices.any((d) => d.signingKey.length != _keyBytes || d.channelKey.length != _keyBytes || d.boxKey.length != _keyBytes)) {
      return unsupported('key');
    }

    // 9. A phone's two keys: both or neither, and only on a client.
    for (final d in devices) {
      final r = d.readOnlyKey.length;
      final n = d.notificationKey.length;
      final both = r == _keyBytes && n == _keyBytes;
      final neither = r == 0 && n == 0;
      if (!(both || neither) || (both && d.role != roleClient)) return unsupported('phone-keys');
    }

    // 10. No public key twice, across devices and kinds.
    final seen = <String>{};
    for (final d in devices) {
      for (final k in [d.signingKey, d.channelKey, d.boxKey, d.readOnlyKey, d.notificationKey]) {
        if (k.isEmpty) continue;
        if (!seen.add(_hex(k))) return unsupported('duplicate-key');
      }
    }

    // 11. How many.
    final clients = devices.where((d) => d.role == roleClient).length;
    final computers = devices.length - clients;
    if (devices.isEmpty || clients > maxClients || computers > maxComputers || (mode == ListMode.first && devices.length != 1)) {
      return unsupported('count');
    }

    // 12. The pinned phone, as a client with its phone keys.
    final phone = devices.where((d) => _equal(d.signingKey, phoneKey)).firstOrNull;
    if (phone == null || phone.role != roleClient || phone.readOnlyKey.length != _keyBytes) return unsupported('phone');

    // 13. At a join, the joining device exactly as it is.
    if (self != null && !devices.any((d) => _sameDevice(d, self))) return ListResult._refused('self');

    return ListResult._('accepted', counter: counter, hash: hash, list: list);
  }

  /// The account's phone's next version: its body built with the fields in
  /// field-number order and signed. [accountId] and [previousBody] are null for
  /// version 1; for any other, a 32-byte account ID and a non-empty
  /// previous body. [counter] is the next counter, already saved. The bytes
  /// returned are checked as received before they are returned, which also
  /// refuses a key pair whose halves do not match. Any failure is the
  /// caller's mistake, a [ListCallError] naming the reason.
  Uint8List makeList({
    required KeyPair phone,
    required List<Device> devices,
    List<int>? previousBody,
    List<int>? accountId,
    required Int64 counter,
  }) {
    if (accountId == null ? previousBody != null : accountId.length != _accountIdBytes || previousBody == null || previousBody.isEmpty) {
      throw ListCallError('version 1 has no account ID and no previous body; any other, a 32-byte account ID and a previous body');
    }
    // Dart's protobuf writes a field set to its default (an empty key, role
    // 0) where the other languages leave it out, so only the fields that
    // hold something are set.
    final list = ListBody(
      accountId: accountId,
      counter: counter,
      previousHash: previousBody == null ? null : sha256(previousBody),
      devices: [for (final d in devices) _canonical(d)],
    );
    final body = list.writeToBuffer();
    final mode = accountId == null ? ListMode.first : ListMode.later;
    final signature = _sodium.crypto.sign.detached(message: framed(listContext, [accountId ?? const <int>[], body]), secretKey: phone.secretKey);
    final signed = Uint8List.fromList([...signature, ...body]);
    final received = checkList(bytes: signed, phoneKey: phone.publicKey, mode: mode, accountId: accountId, highest: Int64.ZERO);
    if (received.result != 'accepted') throw ListCallError('the version as received would be ${received.result} ${received.reason}');
    return signed;
  }
}
