// The devices' names (docs/e2e.md, section 3): signed by the account's
// phone over framed("pirc-e2e-v2 names", account ID, body), the signature
// then the body sealed with crypto_box from the phone's box key to each
// client's box key. The phone makes them; every client opens them. The
// steps, their order and the names of results and reasons are those of
// e2e/names.ts, and on a body as the phone's maker writes it (fields in
// order, each with its declared wire type, varints and lengths in their
// shortest form) the two agree on every input. A body only the phone could
// sign in another encoding (a known field with another wire type, a length
// or varint wider than a maker writes, a field running past the end of its
// message, deeply nested unknown groups) can read differently in different
// languages, each protobuf library reading such bytes its own way. That is
// by design: the checks defend against
// everyone but the phone, which is trusted. No input bytes make opening
// throw; only a caller's mistake does.
import 'dart:typed_data';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:fixnum/fixnum.dart';
import 'package:sodium/sodium_sumo.dart';

import '../gen/pirc/v1alpha2/account.pb.dart';
import 'bytes.dart';
import 'framed.dart';
import 'list.dart';
import 'sealed.dart' show futureMs, nonceBytes;

const namesContext = 'pirc-e2e-v2 names';
const namesMaxBytes = 32768;
const nameMaxBytes = 200;

const _signatureBytes = 64;
const _keyBytes = 32;
const _accountIdBytes = 32;

/// A device's name, with its signing key.
class DeviceName {
  const DeviceName(this.signingKey, this.name);

  final List<int> signingKey;
  final String name;
}

/// What opening names gives: [result] is accepted, later or refused;
/// [reason] is set for refused; the rest for accepted: [names] of devices on
/// the list, [dropped] of devices not on it.
class NamesResult {
  const NamesResult._(this.result, {this.reason, this.ordering, this.listCounter, this.names = const [], this.dropped = const []});

  final String result;
  final String? reason;
  final Int64? ordering;
  final Int64? listCounter;
  final List<DeviceName> names;
  final List<DeviceName> dropped;

  static NamesResult _refused(String reason) => NamesResult._('refused', reason: reason);
}

/// One sealed copy: for the client with [signingKey], sealed to its
/// [recipientKey], the nonce then the ciphertext.
class SealedCopy {
  const SealedCopy({required this.signingKey, required this.recipientKey, required this.sealed});

  final Uint8List signingKey;
  final Uint8List recipientKey;
  final Uint8List sealed;
}

/// Names sealed for the clients: a copy each, and the keys libsodium
/// refused, by key, for the caller to log.
class MadeNames {
  const MadeNames({required this.copies, required this.skipped});

  final List<SealedCopy> copies;
  final List<Uint8List> skipped;
}

/// A caller's mistake in what it passed to [NamesChecks.openNames] or
/// [NamesChecks.makeNames].
class NamesCallError extends ArgumentError {
  NamesCallError(String super.message);
}

/// The signature, the body and everything in them: steps 3 to 7 of
/// opening, on the box's plaintext.
NamesResult _checkPlaintext(E2e e2e, Uint8List plaintext, List<int> accountId, List<int> phoneKey, ListBody list, Int64? highest, Int64 now) {
  if (plaintext.length < _signatureBytes) return NamesResult._refused('signature');
  // 3. The phone's signature over the body, then the parse.
  final body = Uint8List.sublistView(plaintext, _signatureBytes);
  bool verified;
  try {
    verified = e2e.sodium.crypto.sign.verifyDetached(
      message: framed(namesContext, [accountId, body]),
      signature: Uint8List.sublistView(plaintext, 0, _signatureBytes),
      publicKey: Uint8List.fromList(phoneKey),
    );
  } catch (_) {
    verified = false;
  }
  if (!verified) return NamesResult._refused('signature');
  final Names names;
  try {
    names = Names.fromBuffer(body);
  } catch (_) {
    return NamesResult._refused('parse');
  }
  // 4. The ordering value; Dart reads 2^63 and above as negative.
  if (names.ordering.isNegative) return NamesResult._refused('range');
  if (highest != null && names.ordering <= highest) return NamesResult._refused('ordering');
  if (names.ordering - now > Int64(futureMs)) return NamesResult._refused('future');
  // 5. Names from a list the caller does not have yet (a counter of 2^63
  // or more reads as negative, and is above any list's).
  if (names.listCounter.isNegative || names.listCounter > list.counter) return const NamesResult._('later');
  // 6. Each name, and each key once.
  final all = <DeviceName>[];
  for (final n in names.names) {
    final text = n.name.length <= nameMaxBytes ? utf8Text(n.name) : null;
    if (text == null) return NamesResult._refused('text');
    all.add(DeviceName(Uint8List.fromList(n.signingKey), text));
  }
  final seen = <String>{};
  for (final n in all) {
    if (!seen.add(hexOf(n.signingKey))) return NamesResult._refused('duplicate-key');
  }
  // 7. Names of devices not on the newest list, apart.
  bool listed(DeviceName n) => list.devices.any((d) => bytesEqual(d.signingKey, n.signingKey));
  return NamesResult._(
    'accepted',
    ordering: names.ordering,
    listCounter: names.listCounter,
    names: [for (final n in all) if (listed(n)) n],
    dropped: [for (final n in all) if (!listed(n)) n],
  );
}

extension NamesChecks on E2e {
  /// Opens names sealed to this client's box key. [phoneKey] is the
  /// account's phone's signing key, pinned at the join; [list] the caller's
  /// newest; [highest] the highest names ordering seen, null if none; [now]
  /// the time in milliseconds. [recipientSecretKey] is 32 bytes.
  NamesResult openNames({
    required List<int> sealed,
    required List<int> accountId,
    required ListBody list,
    required List<int> phoneKey,
    required List<int> recipientSecretKey,
    Int64? highest,
    required Int64 now,
  }) {
    if (recipientSecretKey.length != _keyBytes) throw NamesCallError('the recipient secret key is 32 bytes');
    if (highest != null && highest.isNegative) throw NamesCallError('highest is 0 to 2^63-1, or null');
    if (now.isNegative) throw NamesCallError('now is 0 to 2^63-1');

    // 1. Size.
    if (sealed.length > namesMaxBytes) return NamesResult._refused('size');
    // 2. The box, from the phone's box key on the newest list; then room
    // for a signature.
    final phone = list.devices.where((d) => bytesEqual(d.signingKey, phoneKey)).firstOrNull;
    if (phone == null) return NamesResult._refused('box');
    final bytes = Uint8List.fromList(sealed);
    final raw = Uint8List.fromList(recipientSecretKey);
    final secret = sodium.secureCopy(raw);
    raw.fillRange(0, raw.length, 0);
    final Uint8List plaintext;
    try {
      plaintext = sodium.crypto.box.openEasy(
        cipherText: Uint8List.sublistView(bytes, nonceBytes),
        nonce: Uint8List.sublistView(bytes, 0, nonceBytes),
        publicKey: Uint8List.fromList(phone.boxKey),
        secretKey: secret,
      );
    } catch (_) {
      return NamesResult._refused('box');
    } finally {
      secret.dispose();
    }
    return _checkPlaintext(this, plaintext, accountId, phoneKey, list, highest, now);
  }

  /// Makes the names the account's phone sends: [names] signed, then one
  /// copy sealed to each client on [list] (whose counter goes in), each with
  /// its own random nonce. Each name is cut to its cap at a code point
  /// boundary. A client whose key libsodium refuses is skipped, and the
  /// others still get theirs.
  ///
  /// [phone] is the phone's signing key pair and [phoneBoxSecretKey] its box
  /// secret key; [ordering] is made as an announcement's and kept by the
  /// caller. What is sealed is checked as a client would check it before
  /// anything is returned; anything that fails is the caller's mistake, a
  /// [NamesCallError] naming the reason.
  MadeNames makeNames({
    required List<int> accountId,
    required ListBody list,
    required KeyPair phone,
    required SecureKey phoneBoxSecretKey,
    required Int64 ordering,
    required List<DeviceName> names,
  }) =>
      makeNamesWithNonces(
        accountId: accountId,
        list: list,
        phone: phone,
        phoneBoxSecretKey: phoneBoxSecretKey,
        ordering: ordering,
        names: names,
        nonceFor: (_) => sodium.randombytes.buf(nonceBytes),
      );

  /// [makeNames] with the nonce for each client, in the list's order of
  /// clients, given: for the tests, which hold exact bytes.
  @visibleForTesting
  MadeNames makeNamesWithNonces({
    required List<int> accountId,
    required ListBody list,
    required KeyPair phone,
    required SecureKey phoneBoxSecretKey,
    required Int64 ordering,
    required List<DeviceName> names,
    required Uint8List Function(int i) nonceFor,
  }) {
    if (accountId.length != _accountIdBytes) throw NamesCallError('the account ID is 32 bytes');
    if (list.counter == Int64.ZERO) throw NamesCallError('the list is a version, 1 or more');
    final self = list.devices.where((d) => bytesEqual(d.signingKey, phone.publicKey)).firstOrNull;
    if (self == null) throw NamesCallError('the phone is not on the list');
    if (!bytesEqual(sodium.crypto.scalarmult.base(n: phoneBoxSecretKey), self.boxKey)) {
      throw NamesCallError('the box secret key is not the phone\'s on the list');
    }

    // Dart's protobuf writes a field set to its default where the other
    // languages leave it out, so only the fields that hold something are set.
    final body = Names(
      listCounter: list.counter,
      ordering: ordering == Int64.ZERO ? null : ordering,
      names: [
        for (final n in names)
          if (utf8Cut(n.name, nameMaxBytes) case final cut) Name(signingKey: n.signingKey, name: cut.isEmpty ? null : cut),
      ],
    ).writeToBuffer();
    final signature = sodium.crypto.sign.detached(message: framed(namesContext, [accountId, body]), secretKey: phone.secretKey);
    final plaintext = Uint8List.fromList([...signature, ...body]);

    // What a client would find: an authentic body of this list's names, none
    // for a device off the list, within the size every client accepts.
    if (nonceBytes + sodium.crypto.box.macBytes + plaintext.length > namesMaxBytes) throw NamesCallError('the names are over $namesMaxBytes bytes sealed');
    final received = _checkPlaintext(this, plaintext, accountId, phone.publicKey, list, null, ordering);
    if (received.result != 'accepted') throw NamesCallError('the names as received would be ${received.result}${received.reason == null ? '' : ' ${received.reason}'}');
    if (received.dropped.isNotEmpty) throw NamesCallError('a name is for a device not on the list');

    final copies = <SealedCopy>[];
    final skipped = <Uint8List>[];
    var i = 0;
    for (final d in list.devices.where((d) => d.role == roleClient)) {
      final nonce = nonceFor(i++);
      if (nonce.length != nonceBytes) throw NamesCallError('a nonce is 24 bytes');
      try {
        final box = sodium.crypto.box.easy(message: plaintext, nonce: nonce, publicKey: Uint8List.fromList(d.boxKey), secretKey: phoneBoxSecretKey);
        copies.add(SealedCopy(
          signingKey: Uint8List.fromList(d.signingKey),
          recipientKey: Uint8List.fromList(d.boxKey),
          sealed: Uint8List.fromList([...nonce, ...box]),
        ));
      } catch (_) {
        skipped.add(Uint8List.fromList(d.boxKey));
      }
    }
    return MadeNames(copies: copies, skipped: skipped);
  }
}
