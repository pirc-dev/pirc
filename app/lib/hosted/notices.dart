// A woken phone's notices on a hosted account (docs/e2e.md, section 5): it
// logs in with its read-only key, which the relay lets fetch only the
// account's newest list and the notices sealed to this phone, takes the
// list if it is newer and checks out, and opens each notice with its
// notification key: from a computer on the newest list, for the slot the
// relay gave it from, with an ordering value above the highest seen for
// that session and no more than a day ahead. The highest values are kept
// in the prefs the iOS notification extension shares ("hosted.notices.v1"),
// and each writer only raises them.
//
// The Dart side is Android's (push/wake.dart); iOS's is PircNotices, in
// Swift, the same.
import 'dart:async';
import 'dart:convert';

import 'package:fixnum/fixnum.dart';

import '../core/client.dart' show viewId;
import '../core/notices.dart' show cut;
import '../e2e/bytes.dart';
import '../e2e/list.dart';
import '../e2e/sealed.dart';
import '../gen/pirc/v1alpha2/relay.pb.dart';
import '../keys/key_store.dart';
import 'account.dart';
import 'keys.dart';
import 'link.dart';
import 'setup.dart' show hostedRelayKey;

const noticesKey = 'hosted.notices.v1';

/// A notification to show, for a session by its view ID.
class HostedNote {
  const HostedNote(this.session, this.title, this.body);
  final String session;
  final String title;
  final String body;
}

/// Why the notices were not read: the notification is then the fixed text.
class NoticesUnreadable implements Exception {
  const NoticesUnreadable(this.reason);
  final String reason;
  @override
  String toString() => 'NoticesUnreadable: $reason';
}

/// The highest ordering seen per computer and session, as kept.
Future<Map<String, Int64>> _keptHighest(KeyValues values) async {
  final v = await values.get(noticesKey);
  if (v == null) return {};
  try {
    return (jsonDecode(v) as Map<String, Object?>).map((k, n) => MapEntry(k, Int64.parseInt(n as String)));
  } on Object {
    return {};
  }
}

// Each value only raised: one kept meanwhile by the other writer stays if
// higher.
Future<void> raiseHighest(KeyValues values, Map<String, Int64> seen) async {
  final kept = await _keptHighest(values);
  for (final MapEntry(key: k, value: v) in seen.entries) {
    final had = kept[k];
    if (had == null || v > had) kept[k] = v;
  }
  await values.set(noticesKey, jsonEncode({for (final MapEntry(key: k, value: v) in kept.entries) k: '$v'}));
}

/// The notes for a wake: notices newer than any shown for their session;
/// a session first seen shows only a notice made after [since] (the last
/// wake, in milliseconds), so that an install does not show old ones.
Future<List<HostedNote>> hostedNotes({
  required E2e e2e,
  required KeyValues values,
  required KeyStore store,
  required String relay,
  required int now,
  int? since,
  Duration deadline = const Duration(seconds: 15),
}) async {
  final account = await HostedAccount.load(e2e, values);
  if (account == null || hostedRelayKey(account.origin) != relay) throw const NoticesUnreadable('no hosted account');
  final seed = await store.load(relay, KeyKind.read);
  if (seed == null) throw const NoticesUnreadable('no read-only key');
  final read = ReadKeys.fromSeed(e2e.sodium, seed);
  seed.fillRange(0, seed.length, 0);
  try {
    if (!bytesEqual(read.readOnly.publicKey, account.self.readOnlyKey)) throw const NoticesUnreadable('the read-only key is not this phone\'s');
    final HostedLink link;
    try {
      link = await HostedLink.connect(
        origin: account.origin,
        publicKey: read.readOnly.publicKey,
        sign: (m) async => read.sign(m),
        accountId: account.accountId,
        listCounter: account.newest.counter,
        timeout: deadline,
      );
    } on LinkError catch (e) {
      // Refused after the newest list: taken off the account, nothing to
      // show, the list kept for the app to act on.
      if (e.list != null) {
        await account.take(e.list!);
        if (!account.listed) return const [];
      }
      throw NoticesUnreadable('$e');
    } on Object catch (e) {
      throw NoticesUnreadable('$e');
    }
    final List<StoredNotice> stored;
    try {
      if (link.welcome.list.isNotEmpty) await account.take(link.welcome.list);
      // Taken off the account: nothing to show.
      if (!account.listed) return const [];
      link.send(Frame(fetchNotices: FetchNotices(requestId: 'n')));
      stored = <StoredNotice>[];
      await for (final f in link.frames.timeout(deadline)) {
        if (f.hasError()) throw NoticesUnreadable(f.error.message);
        if (!f.hasNotices() || f.notices.requestId != 'n') continue;
        stored.addAll(f.notices.notices);
        if (!f.notices.more) break;
      }
    } on TimeoutException {
      throw const NoticesUnreadable('no answer in time');
    } finally {
      await link.close();
    }
    final highest = await _keptHighest(values);
    final secret = read.notification.secretKey.extractBytes();
    final seen = <String, Int64>{};
    final notes = <HostedNote>[];
    try {
      for (final n in stored) {
        if (!n.hasSession()) continue;
        final ref = n.session;
        final sessionId = utf8.encode(ref.sessionId);
        if (!goodSessionId(sessionId)) continue;
        final key = '${hexOf(ref.hostKey)}/${ref.sessionId}';
        final r = e2e.openNotice(
          sealed: n.sealed,
          slot: Slot(accountId: account.accountId, computerKey: ref.hostKey, sessionId: sessionId),
          recipientSecretKey: secret,
          list: account.newest.body,
          highest: highest[key] ?? seen[key],
          now: Int64(now),
        );
        if (r.result != 'accepted') continue;
        final ordering = r.ordering!;
        final firstSight = highest[key] == null && seen[key] == null;
        seen[key] = ordering;
        if (firstSight && (since == null || ordering <= Int64(since))) continue;
        final t = r.body!;
        final title = cut([t.sessionName, t.computerName].where((x) => x.isNotEmpty).join(' · '), 80);
        notes.add(HostedNote(viewId(ref), title.isEmpty ? 'PiRC' : title, t.notice.isNotEmpty ? t.notice : 'Finished'));
      }
    } finally {
      secret.fillRange(0, secret.length, 0);
    }
    await raiseHighest(values, seen);
    return notes;
  } finally {
    read.dispose();
  }
}
