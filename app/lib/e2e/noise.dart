// Noise for a channel (docs/e2e.md, section 4), as e2e/noise.ts has it, over
// the core in noise_core.dart:
//
//   - IK, with the prologue built here from the account ID: the phone
//     initiates, knowing the computer's channel key from the list. The IK
//     responder, a computer's side, is here for the tests only.
//   - XXpsk3 (section 6), with the caller's prologue and 32-byte PSK, for
//     the tests only until a part needs it.
//
// Handshake messages carry no payload, so each has a fixed length: IK's
// are 96 and 48 bytes, XXpsk3's 48, 96 and 64. A handshake and a transport
// are synchronous. No input bytes make anything throw: a failure is a
// result with its reason, length, dh, decrypt or dead, and the handshake or
// transport is dead after it, both directions of a transport alike. A
// caller's mistake throws, and kills the state too: a call out of order, a
// key or account ID of the wrong length, a plaintext over 65,519 bytes, an
// IK responder sending before the initiator's first message has decrypted,
// a counter at its cap.
//
// An IK responder's transport is unconfirmed until a message from the
// initiator decrypts, and sends nothing before: message 1 can be replayed,
// and anyone holding the computer's channel key can write one. An XXpsk3
// initiator's transport is unconfirmed until a message from the responder
// decrypts, since only that shows the responder holds the PSK; it may send
// meanwhile.
//
// The static key is a SecureKey, the X25519 secret key, which must be live
// when the handshake is made: the sodium package exposes no disposed state,
// and reading a disposed key crashes the process rather than throwing. The
// handshake copies it into its own native memory at once, so the caller
// may dispose of it right after.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:sodium/sodium_sumo.dart' show SecureKey;

import 'framed.dart';
import 'list.dart' show E2e, roleClient, roleComputer;
import 'noise_core.dart' as core;

export 'noise_core.dart' show NoiseCallError, NoiseReason;

const channelContext = 'pirc-e2e-v2 channel';

/// The channel's own version, apart from the relay's protocol.
const channelVersion = 1;
const accountIdBytes = 32;

/// A copy of [b] as bytes; throws for a value that is not one.
Uint8List _bytes(List<int> b, String what) {
  for (final x in b) {
    if (x < 0 || x > 255) throw core.NoiseCallError('$what holds a value that is not a byte');
  }
  return Uint8List.fromList(b);
}

/// IK's prologue: framed(context, the channel's version, account ID, the
/// client's role, the computer's role).
Uint8List channelPrologue(List<int> accountId) {
  if (accountId.length != accountIdBytes) throw core.NoiseCallError('the account ID is not $accountIdBytes bytes');
  return framed(channelContext, [
    framedNumber(Int64(channelVersion)),
    _bytes(accountId, 'the account ID'),
    framedNumber(Int64(roleClient)),
    framedNumber(Int64(roleComputer)),
  ]);
}

/// A handshake call's result: [reason] on a failure; a write's [message];
/// after the last message, the [transport].
final class NoiseHandshakeResult {
  const NoiseHandshakeResult._({this.reason, this.message, this.transport});

  final core.NoiseReason? reason;
  final Uint8List? message;
  final NoiseTransport? transport;
  bool get ok => reason == null;
}

/// A send's result: [reason] on a failure, otherwise the [message].
final class NoiseSendResult {
  const NoiseSendResult._({this.reason, this.message});

  final core.NoiseReason? reason;
  final Uint8List? message;
  bool get ok => reason == null;
}

/// A receive's result: [reason] on a failure, otherwise the [plaintext].
final class NoiseReceiveResult {
  const NoiseReceiveResult._({this.reason, this.plaintext});

  final core.NoiseReason? reason;
  final Uint8List? plaintext;
  bool get ok => reason == null;
}

/// Both directions of a channel after its handshake. None of the core's
/// state is reachable through it.
final class NoiseTransport {
  NoiseTransport._(this._t);

  final core.Transport _t;

  /// The other side's static key; null once the transport is dead.
  Uint8List? get remoteStatic => _t.remoteStatic;

  Uint8List get handshakeHash => _t.handshakeHash;

  /// False at an IK responder and an XXpsk3 initiator until a message from
  /// the other side has decrypted.
  bool get confirmed => _t.confirmed;

  NoiseSendResult send(Uint8List plaintext) {
    final r = _t.send(plaintext);
    return NoiseSendResult._(reason: r.reason, message: r.bytes);
  }

  NoiseReceiveResult receive(Uint8List message) {
    final r = _t.receive(message);
    return NoiseReceiveResult._(reason: r.reason, plaintext: r.bytes);
  }

  /// Zeroes both keys; every later call gives dead.
  void close() => _t.close();
}

/// A handshake: [writeMessage] and [readMessage] in the pattern's order.
final class NoiseHandshake {
  NoiseHandshake._(this._h);

  final core.Handshake _h;

  /// The next message, this side's turn; with the transport after the last.
  NoiseHandshakeResult writeMessage() => _result(_h.writeMessage());

  /// The other side's message; with the transport after the last.
  NoiseHandshakeResult readMessage(Uint8List message) {
    final r = _h.readMessage(message);
    return NoiseHandshakeResult._(reason: r.reason, transport: _transport(r));
  }

  /// The other side's static key once a message has carried it, at an IK
  /// responder unconfirmed; null once dead.
  Uint8List? get remoteStatic => _h.remoteStatic;

  static NoiseHandshakeResult _result(core.HandshakeResult r) => NoiseHandshakeResult._(reason: r.reason, message: r.message, transport: _transport(r));

  static NoiseTransport? _transport(core.HandshakeResult r) {
    final t = r.transport;
    return t == null ? null : NoiseTransport._(t);
  }
}

/// Noise over the libsodium [E2e] has started: `e2e.noise`.
final class Noise {
  const Noise._();

  /// The phone's side of a channel: IK's initiator, with the computer's
  /// channel key from the list and the account's 32-byte ID. [staticKey]
  /// must not be disposed yet; it may be once this returns.
  NoiseHandshake ikInitiator({required SecureKey staticKey, required List<int> responderKey, required List<int> accountId}) =>
      _handshake(core.ik, true, staticKey, prologue: channelPrologue(accountId), remoteStatic: _bytes(responderKey, 'the responder\'s key'));

  /// A computer's side of a channel. Tests only.
  @visibleForTesting
  NoiseHandshake ikResponder({required SecureKey staticKey, required List<int> accountId}) =>
      _handshake(core.ik, false, staticKey, prologue: channelPrologue(accountId));

  /// XXpsk3's initiator, with a 32-byte PSK. Tests only.
  @visibleForTesting
  NoiseHandshake xxpsk3Initiator({required SecureKey staticKey, required List<int> prologue, required List<int> psk}) =>
      _handshake(core.xxpsk3, true, staticKey, prologue: _bytes(prologue, 'the prologue'), psk: _bytes(psk, 'the PSK'));

  /// XXpsk3's responder, with a 32-byte PSK. Tests only.
  @visibleForTesting
  NoiseHandshake xxpsk3Responder({required SecureKey staticKey, required List<int> prologue, required List<int> psk}) =>
      _handshake(core.xxpsk3, false, staticKey, prologue: _bytes(prologue, 'the prologue'), psk: _bytes(psk, 'the PSK'));

  /// The core's handshake for a side, with no payloads and a random
  /// ephemeral key; the PSK's copy made here zeroed once the core holds it.
  static NoiseHandshake _handshake(core.NoisePattern pattern, bool initiator, SecureKey staticKey,
      {required Uint8List prologue, Uint8List? remoteStatic, Uint8List? psk}) {
    try {
      return NoiseHandshake._(core.Handshake(
        pattern: pattern,
        initiator: initiator,
        staticKey: staticKey,
        remoteStatic: remoteStatic,
        prologue: prologue,
        psk: psk,
        payloads: false,
      ));
    } finally {
      psk?.fillRange(0, psk.length, 0);
    }
  }
}

/// Noise, from libsodium once started.
extension E2eNoise on E2e {
  Noise get noise => const Noise._();
}
