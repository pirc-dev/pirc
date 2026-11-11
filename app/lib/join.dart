// Joining a relay by a link or QR code from another client (docs/web.md,
// section 5: "Add an app"): pirc://join?relay=<url>&token=<token>. The phone
// makes its two keys, logs in with the main one and the token, which
// registers it, then registers its read-only key under it.
import 'dart:async';

import 'core/protocol.dart';
import 'keys/key_holder.dart';
import 'keys/key_store.dart';
import 'relay/connection.dart';
import 'relay/keys.dart';

class JoinLink {
  const JoinLink(this.relay, this.token);
  final String relay;
  final String token;
}

// The link in text a QR code or a paste gave; null when it is not one.
JoinLink? parseJoinLink(String text) {
  final u = Uri.tryParse(text.trim());
  if (u == null || u.scheme != 'pirc' || u.host != 'join') return null;
  final relay = u.queryParameters['relay'] ?? '';
  final token = u.queryParameters['token'] ?? '';
  if (token.isEmpty) return null;
  try {
    relayUri(relay);
  } on FormatException {
    return null;
  }
  return JoinLink(relay, token);
}

class JoinFailed implements Exception {
  const JoinFailed(this.reason);
  final String reason;
  @override
  String toString() => reason;
}

// Joins the relay the link names. On success the phone's keys are kept in
// store; on failure nothing is.
Future<({DeviceKey main, DeviceKey read})> join(
  JoinLink link,
  KeyStore store, {
  String label = '',
  bool protect = true,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final ({DeviceKey main, DeviceKey read}) keys;
  try {
    keys = await KeyHolder.create(store, link.relay, protect: protect);
  } on KeyUnavailable catch (e) {
    // No passcode to lock the key with, or the person declined.
    await store.delete(link.relay);
    throw JoinFailed(e.cancelled ? 'Joining was cancelled.' : e.reason);
  }
  final done = Completer<void>();
  var lastReason = '';
  late final RelayConnection conn;
  conn = RelayConnection(
    url: link.relay,
    key: keys.main,
    token: link.token,
    label: label,
    retryUsedToken: false,
    onState: (s) {
      if (done.isCompleted) return;
      switch (s) {
        case Ready():
          conn.send(Frame(registerReadKey: RegisterReadKey(requestId: 'join-read-key', publicKey: keys.read.publicKey)));
        case Refused():
          done.completeError(JoinFailed(s.code == ErrorCode.ERROR_CODE_TOKEN_INVALID
              ? 'This link has been used or has expired. Ask for a new one.'
              : 'The relay refused this phone: ${s.reason}'));
        case Offline(:final reason):
          // Retried by the connection until the timeout.
          lastReason = reason;
        default:
      }
    },
    onFrame: (f) {
      if (done.isCompleted) return;
      if (f.hasKeyChanged() && f.keyChanged.requestId == 'join-read-key') done.complete();
      if (f.hasError() && f.error.requestId == 'join-read-key') {
        done.completeError(JoinFailed('The relay did not take this phone\'s second key: ${f.error.message}'));
      }
    },
  );
  conn.start();
  try {
    await done.future.timeout(timeout, onTimeout: () {
      throw JoinFailed(lastReason.isEmpty ? 'The relay did not answer.' : 'Could not reach the relay: $lastReason');
    });
    return keys;
  } catch (_) {
    await store.delete(link.relay);
    rethrow;
  } finally {
    conn.stop();
  }
}
