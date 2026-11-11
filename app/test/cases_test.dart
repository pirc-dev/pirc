// The shared cases (cases/README.md), run against the Dart port of the
// client logic, as web/test runs them against web/core: every exchange,
// function and notice the TypeScript passes, this passes too.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/core/chat.dart';
import 'package:pirc/core/client.dart';
import 'package:pirc/core/fuzzy.dart';
import 'package:pirc/core/images.dart';
import 'package:pirc/core/names.dart';
import 'package:pirc/core/notices.dart';
import 'package:pirc/core/order.dart';
import 'package:pirc/core/pending.dart';
import 'package:pirc/core/protocol.dart';
import 'package:pirc/core/results.dart';
import 'package:pirc/core/view.dart';

const cases = '../cases';

List<File> filesIn(String dir) =>
    Directory('$cases/$dir').listSync().whereType<File>().where((f) => f.path.endsWith('.json')).toList()
      ..sort((a, b) => a.path.compareTo(b.path));

Json readJson(File f) => jsonDecode(f.readAsStringSync()) as Json;

// JSON as the cases compare it: a round trip, as the TypeScript's does.
Object? plain(Object? v) => jsonDecode(jsonEncode(v));

// --- Functions -----------------------------------------------------------

List<SessionView> sessions(Object? v) => [for (final s in v as List) SessionView.fromJson(s as Json)];
List<ChatItem> items(Object? v) => [for (final x in v as List) ChatItem.fromJson(x as Json)];
Map<String, int> starts(Object? v) => (v as Json).map((k, x) => MapEntry(k, (x as num).toInt()));

Pending<Object?> pending(Object? v) {
  final j = v as Json;
  return Pending(
    key: (j['key'] as num).toInt(),
    requestId: j['requestId'] as String,
    text: j['text'] as String,
    images: j['images'] as List?,
    delivery: j['delivery'] as String?,
    state: j['state'] as String,
    error: j['error'] as String?,
    unsure: j['unsure'] as bool? ?? false,
    before: {...(j['before'] as List).cast<String>()},
  );
}

Json pendingOut(Pending<Object?> p) => {
      'key': p.key,
      'requestId': p.requestId,
      'text': p.text,
      'images': ?p.images,
      'delivery': ?p.delivery,
      'state': p.state,
      'error': ?p.error,
      if (p.unsure) 'unsure': true,
      'before': p.before.toList(),
    };

Json part(Part p) => switch (p) {
      ToolsPart(:final tools) => {'tools': [for (final t in tools) t.id]},
      ItemPart(:final item) => {'item': item.id},
    };

Object? call(String fn, List<Object?> a) {
  switch (fn) {
    case 'applyToChat':
      return applyToChat(ChatView.fromJson(a[0] as Json), ViewEvent.fromJson(a[1] as Json)).toJson();
    case 'lastOf':
      return lastOf(items(a[0]))?.toJson();
    case 'folder':
      return folder(a[0] as String);
    case 'title':
      return title(SessionView.fromJson(a[0] as Json));
    case 'windowOf':
      return windowOf(SessionView.fromJson(a[0] as Json));
    case 'details':
      return details(SessionView.fromJson(a[0] as Json));
    case 'where':
      return where(SessionView.fromJson(a[0] as Json));
    case 'ago':
      return ago((a[0] as num).toInt(), (a[1] as num).toInt(), (t, weekday) => '${weekday ? 'weekday' : 'date'} $t');
    case 'fuzzy':
      return fuzzy(a[0] as String, a[1] as String)?.toJson();
    case 'rank':
      return [
        for (final r in rank(a[0] as String, (a[1] as List).cast<String>(), (t) => t)) {'item': r.item, 'match': r.match.toJson()},
      ];
    case 'imageKey':
      return imageKey(a[0] as String, base64.decode(a[1] as String));
    case 'outcome':
      return outcome(SessionMessage()..mergeFromProto3Json(a[0])).toJson();
    case 'starts':
      final s = Starts();
      return [for (final l in a[0] as List) s.update(sessions(l))];
    case 'order':
      return (sessions(a[1])..sort(compare(starts(a[0]), title))).map((s) => s.id).toList();
    case 'nextWaiting':
      return nextWaiting(sessions(a[0]), {...(a[1] as List).cast<String>()}, compare(starts(a[2]), title), a[3] as String?)?.id;
    case 'userIds':
      return userIds(items(a[0])).toList();
    case 'settle':
      return settle([for (final p in a[0] as List) pending(p)], items(a[1])).map((p) => p.key).toList();
    case 'answered':
      final p = answered(pending(a[0]), a[1] as bool, a[2] as String?, a[3] as bool);
      return p == null ? null : pendingOut(p);
    case 'quiet':
      return quiet(items(a[0]));
    case 'runs':
      return [
        for (final r in runs(items(a[0]))) [for (final p in r) part(p)],
      ];
    case 'signature':
      return signature(a[0] == null ? null : ChatItem.fromJson(a[0] as Json));
    case 'took':
      return took((a[0] as num).toInt());
    case 'diffLines':
      return [
        for (final l in diffLines(a[0] as String)) {'kind': l.kind, 'text': l.text},
      ];
    case 'cut':
      return cut(a[0] as String, (a[1] as num).toInt());
    case 'notification':
      return notification(SessionView.fromJson(a[0] as Json))?.toJson();
    case 'news':
      final r = news(starts(a[0]), sessions(a[1]), (a[2] as num?)?.toInt());
      return {'notify': r.notify.map((s) => s.id).toList(), 'shown': r.shown};
  }
  throw ArgumentError('no function named $fn');
}

// --- Exchanges -----------------------------------------------------------

String b64(List<int> b) => base64.encode(b);

Json encodeEntry(Json e) {
  if (!e.containsKey('announcement')) return e;
  final out = Json.of(e)..remove('announcement');
  final a = SessionAnnouncement()..mergeFromProto3Json(e['announcement']);
  return out..['payload'] = b64(a.writeToBuffer());
}

// A frame in the exchanges' form, as a Frame.
Frame frameIn(Json j) {
  final f = Json.of(j);
  final routed = f['routed'] as Json?;
  if (routed != null && routed.containsKey('message')) {
    final m = SessionMessage()..mergeFromProto3Json(routed['message']);
    f['routed'] = Json.of(routed)
      ..remove('message')
      ..['payload'] = b64(m.writeToBuffer());
  }
  final list = f['sessionList'] as Json?;
  if (list != null) {
    f['sessionList'] = {
      ...list,
      'sessions': [for (final e in (list['sessions'] as List? ?? [])) encodeEntry(e as Json)],
    };
  }
  final updated = f['sessionUpdated'] as Json?;
  if (updated != null) f['sessionUpdated'] = {'entry': encodeEntry(updated['entry'] as Json)};
  return Frame()..mergeFromProto3Json(f);
}

// A Frame in the exchanges' form.
Json frameOut(Frame f) {
  final j = f.toProto3Json() as Json;
  if (f.whichBody() == Frame_Body.routed) {
    final r = Json.of(j['routed'] as Json)..remove('payload');
    j['routed'] = r..['message'] = SessionMessage.fromBuffer(f.routed.payload).toProto3Json();
  }
  return j;
}

// A clock whose time moves only when told to.
class FakeClock implements Clock {
  var _now = 0;
  var _next = 1;
  final _timers = <int, ({int at, void Function() fn})>{};

  @override
  Object setTimeout(void Function() fn, int ms) {
    final id = _next++;
    _timers[id] = (at: _now + ms, fn: fn);
    return id;
  }

  @override
  void clearTimeout(Object? t) => _timers.remove(t);

  void advance(int ms) {
    final end = _now + ms;
    for (;;) {
      final due = _timers.entries.where((e) => e.value.at <= end).toList()..sort((a, b) => a.value.at - b.value.at);
      if (due.isEmpty) break;
      _timers.remove(due.first.key);
      _now = due.first.value.at;
      due.first.value.fn();
    }
    _now = end;
  }
}

Future<void> settleQueue() => Future<void>.delayed(Duration.zero);

Future<void> replay(List<Json> steps) async {
  final clock = FakeClock();
  var n = 0;
  final sent = <Frame>[];
  final events = <ViewEvent>[];
  final replies = <String, ({bool done, Object? value})>{};
  final c = Client(
    send: (f) {
      sent.add(f);
      return true;
    },
    onEvent: events.add,
    newId: () => 'id-${++n}',
    clock: clock,
  );
  for (final (i, step) in steps.indexed) {
    final at = 'step ${i + 1} ${jsonEncode(step).substring(0, jsonEncode(step).length.clamp(0, 80))}';
    if (step.containsKey('state')) {
      c.onState(RelayView(state: step['state'] as String));
    } else if (step.containsKey('seed')) {
      final seed = step['seed'] as Json;
      c.seed(seed['sessionId'] as String, ChatView.fromJson(seed['chat'] as Json));
    } else if (step.containsKey('in')) {
      c.onFrame(frameIn(step['in'] as Json));
    } else if (step.containsKey('wait')) {
      clock.advance((step['wait'] as num).toInt());
    } else if (step.containsKey('ask')) {
      final a = step['ask'] as Json;
      final as = step['as'] as String;
      replies[as] = (done: false, value: null);
      final m = SessionMessage()..mergeFromProto3Json(a['body']);
      c.ask(a['id'] as String, m).then((r) => replies[as] = (done: true, value: r.toProto3Json()));
    } else if (step.containsKey('sent')) {
      expect(plain(sent.map(frameOut).toList()), step['sent'], reason: at);
      sent.clear();
    } else if (step.containsKey('events')) {
      await settleQueue();
      expect(plain(events.map((e) => e.toJson()).toList()), step['events'], reason: at);
      events.clear();
    } else if (step.containsKey('reply')) {
      final r = step['reply'] as Json;
      await settleQueue();
      final got = replies[r['as']];
      expect(got, isNotNull, reason: '$at: no request named ${r['as']}');
      expect(got!.done ? plain(got.value) : 'unanswered', r['is'], reason: at);
    } else if (step.containsKey('snapshot')) {
      expect(plain(c.snapshot().toJson()), step['snapshot'], reason: at);
    } else if (step.containsKey('chat')) {
      final ch = step['chat'] as Json;
      expect(plain(c.chat(ch['id'] as String)?.toJson()), ch['is'], reason: at);
    } else {
      fail('$at: unknown step');
    }
    await settleQueue();
  }
  expect(plain(sent.map(frameOut).toList()), isEmpty, reason: 'frames sent after the last check');
  expect(plain(events.map((e) => e.toJson()).toList()), isEmpty, reason: 'events after the last check');
}

void main() {
  for (final dir in ['functions', 'notices']) {
    for (final f in filesIn(dir)) {
      final file = readJson(f);
      test('$dir/${f.uri.pathSegments.last}: ${file['about']}', () {
        for (final c in (file['cases'] as List).cast<Json>()) {
          expect(plain(call(c['fn'] as String, c['args'] as List)), c['is'], reason: '${c['fn']}: ${c['about']}');
        }
      });
    }
  }
  for (final f in filesIn('exchanges')) {
    final file = readJson(f);
    test('exchanges/${f.uri.pathSegments.last}: ${file['about']}', () => replay((file['steps'] as List).cast<Json>()));
  }
}
