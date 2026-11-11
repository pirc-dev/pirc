// A phone woken by a push, on Android (on iOS the notification extension
// does this, in Swift: ios/PircNotices): log in to the relay with the
// read-only key, read the session list once, and write the notifications
// for the notices not yet shown, as the extension does.
import 'dart:async';

import '../app/app.dart';
import '../app/store.dart';
import '../core/client.dart';
import '../core/notices.dart';
import '../core/view.dart';
import '../keys/key_store.dart';
import '../relay/connection.dart';
import '../relay/keys.dart';
import 'push.dart';

// A notification to post, for a session.
class Note {
  const Note(this.session, this.title, this.body);
  final String session;
  final String title;
  final String body;
}

// Why the relay was not read: the notification is then the fixed text.
class Unreachable implements Exception {
  const Unreachable(this.reason);
  final String reason;
  @override
  String toString() => 'Unreachable: $reason';
}

// The live sessions, read with the read-only key whose seed is given.
Future<List<SessionView>> readSessions(String relay, DeviceKey key, {Duration deadline = const Duration(seconds: 15)}) async {
  final done = Completer<List<SessionView>>();
  late final Client client;
  late final RelayConnection conn;
  conn = RelayConnection(
    url: relay,
    key: key,
    software: 'pirc-app-wake',
    onFrame: (f) {
      client.onFrame(f);
      if (f.hasSessionList() && !f.sessionList.more && !done.isCompleted) done.complete(client.snapshot().sessions);
      if (f.hasError() && f.error.requestId.isEmpty && !done.isCompleted) done.completeError(Unreachable(f.error.message));
    },
    onState: (s) {
      if (s is Ready) client.onState(const RelayView(state: 'ready'));
      if (s is Refused && !done.isCompleted) done.completeError(Unreachable(s.reason));
    },
  );
  // A read-only key may only subscribe to the session list.
  client = Client(send: (f) => f.hasSubscribeSessions() ? conn.send(f) : true, onEvent: (_) {});
  conn.start();
  try {
    return await done.future.timeout(deadline, onTimeout: () => throw const Unreachable('no answer in time'));
  } finally {
    conn.stop();
  }
}

// Whether the subscription allows a wake: the store asked, for 3 seconds at
// most, and when it does not answer the time the app left (store.until).
Future<bool> allowed(AppPrefs prefs, Store subscription, int now) async {
  try {
    return (await subscription.status().timeout(const Duration(seconds: 3))).access == Access.allowed;
  } on Object {
    final until = await prefs.allowedUntil();
    return until != null && until.millisecondsSinceEpoch > now;
  }
}

// The notes for a wake, and what is shown once they are; none while the
// subscription does not allow the phone, not even the fixed text, unless
// it is joined to the review relay; throws Unreachable when the relay
// cannot be read, or the phone has no relay or key.
Future<List<Note>> wake({required AppPrefs prefs, required KeyStore store, Store? subscription, required int now, Duration deadline = const Duration(seconds: 15)}) async {
  final relay = await prefs.relay();
  if (subscription != null && relay != reviewRelay && !await allowed(prefs, subscription, now)) return const [];
  if (relay == null) throw const Unreachable('not joined');
  final seed = await store.load(relay, KeyKind.read);
  if (seed == null) throw const Unreachable('no read-only key');
  final sessions = await readSessions(relay, await DeviceKey.fromSeed(seed), deadline: deadline);
  final shown = await prefs.notices();
  final (:notify, shown: numbers) = news(shown.numbers, sessions, shown.since);
  await prefs.setNotices(Shown(numbers: numbers, since: now));
  return [
    for (final s in notify)
      if (notification(s) case final n?) Note(s.id, n.title, n.body),
  ];
}
