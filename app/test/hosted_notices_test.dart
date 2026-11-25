// A woken phone's notices on a hosted account (lib/hosted/notices.dart,
// the Android wake), against the Go relay with a TypeScript computer that
// ends a turn: the notice fetched with the read-only key, opened with the
// notification key, shown once, a later one shown again, an old one on a
// first wake not shown; a phone taken off the account shows nothing.
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart';
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/keys.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/notices.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/push/push.dart' show Shown;
import 'package:pirc/push/wake.dart';

import 'support/relay.dart';
import 'support/ts_computer.dart';

Future<Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => Attestation(test: [1]);

void main() {
  final ready = hasGo && hasNode;
  late Directory dir;
  late HostedRelay relay;
  late E2e e2e;
  late MemoryKeyStore store;
  late MemoryPrefs prefs;
  late OpenAccount open;
  late TsComputer computer;
  late String relayKey;

  setUpAll(() async {
    if (!ready) return;
    e2e = await E2e.load();
    dir = await Directory.systemTemp.createTemp('pirc-hosted-notices-');
    relay = await HostedRelay.start(dir);
    store = MemoryKeyStore();
    prefs = MemoryPrefs();
    open = await signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false);
    relayKey = hostedRelayKey(relay.origin);
    await prefs.setRelay(relayKey);
    computer = await TsComputer.start(relay.origin);
    final text = await computer.until((l) => l.startsWith('PIRC1'));
    final a = open.account;
    final link = await HostedLink.connect(origin: a.origin, publicKey: open.main.signing.publicKey, sign: (m) async => open.main.sign(m), accountId: a.accountId);
    final frames = link.frames.asBroadcastStream();
    for (var i = 0;; i++) {
      final add = AddDevice(
        e2e: e2e,
        account: PhoneAccount(accountId: a.accountId, phone: a.self, signing: open.main.signing, channel: open.main.channel.secretKey, first: a.first, newest: a.newest.bytes, name: 'Pixel 9', counter: MemoryCounter().next),
        frames: frames,
        send: link.send,
      );
      try {
        await add.start(text);
        await a.take(await add.confirm());
        break;
      } on JoinFailed catch (e) {
        if (!e.message.startsWith('no device shows') || i > 20) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
    }
    await link.close();
    await computer.until((l) => l == 'status ready');
  });

  tearDownAll(() async {
    if (!ready) return;
    computer.kill();
    relay.kill();
    open.dispose();
    await dir.delete(recursive: true);
  });

  Future<List<HostedNote>> notes({int? since}) =>
      hostedNotes(e2e: e2e, values: prefs, store: store, relay: relayKey, now: DateTime.now().millisecondsSinceEpoch, since: since);

  test('a turn\'s end: fetched with the read-only key, opened, shown once; a later one shown too', () async {
    final before = DateTime.now().millisecondsSinceEpoch - 1;
    computer.say('notice All tests pass');
    List<HostedNote> got = [];
    for (var i = 0; i < 50 && got.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      got = await notes(since: before);
    }
    expect(got.map((n) => '${n.title}: ${n.body}'), ['fix the build · build box: All tests pass']);
    // Shown: not again.
    expect(await notes(since: before), isEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 5));
    computer.say('notice May I push?');
    got = [];
    for (var i = 0; i < 50 && got.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      got = await notes(since: before);
    }
    expect(got.single.body, 'May I push?');
  }, skip: !ready);

  // Two real notices of one session, as the relay kept them in turn.
  Future<List<StoredNotice>> fetchRaw() async {
    final seed = (await store.load(relayKey, KeyKind.read))!;
    final read = ReadKeys.fromSeed(e2e.sodium, seed);
    final a = open.account;
    final l = await HostedLink.connect(origin: a.origin, publicKey: read.readOnly.publicKey, sign: (m) async => read.sign(m), accountId: a.accountId);
    l.send(Frame(fetchNotices: FetchNotices(requestId: 'raw')));
    final got = <StoredNotice>[];
    await for (final f in l.frames) {
      if (!f.hasNotices()) continue;
      got.addAll(f.notices.notices);
      if (!f.notices.more) break;
    }
    await l.close();
    read.dispose();
    return got;
  }

  test('a relay replaying, reordering or repeating notices shows each at most once, the newest last', () async {
    computer.say('notice One');
    await Future<void>.delayed(const Duration(milliseconds: 500));
    final one = (await fetchRaw()).single;
    computer.say('notice Two');
    await Future<void>.delayed(const Duration(milliseconds: 500));
    final two = (await fetchRaw()).single;
    expect(two.sealed, isNot(one.sealed));
    final seed = (await store.load(relayKey, KeyKind.read))!;
    final read = ReadKeys.fromSeed(e2e.sodium, seed);
    addTearDown(read.dispose);
    final secret = read.notification.secretKey.extractBytes();
    final key = '${_hex(one.session.hostKey)}/${one.session.sessionId}';
    final now = DateTime.now().millisecondsSinceEpoch;
    ({List<HostedNote> notes, Map<String, Int64> seen}) run(List<StoredNotice> stored, Map<String, Int64> highest) =>
        openNotices(e2e: e2e, account: open.account, notificationSecret: secret, stored: stored, highest: highest, since: 0, now: now);
    // Both newer than what was seen: the newer first, the older after it refused.
    final low = {key: Int64(1)};
    final r1 = run([two, one], low);
    expect(r1.notes.map((n) => n.body), ['Two']);
    expect(r1.seen[key], isNot(lessThan(Int64(now - 60000))));
    // One notice three times: once.
    expect(run([one, one, one], low).notes.map((n) => n.body), ['One']);
    // In order: both, the highest the newer's.
    final r2 = run([one, two], low);
    expect(r2.notes.map((n) => n.body), ['One', 'Two']);
    // A session first seen, its notice a minute before the last wake by
    // a computer's clock behind the phone's: shown; ten minutes before, not.
    final oneAt = run([one], low).seen[key]!.toInt();
    expect(openNotices(e2e: e2e, account: open.account, notificationSecret: secret, stored: [one], highest: {}, since: oneAt + 60000, now: now).notes.map((n) => n.body), ['One']);
    expect(openNotices(e2e: e2e, account: open.account, notificationSecret: secret, stored: [one], highest: {}, since: oneAt + 600000, now: now).notes, isEmpty);
    // Again after: nothing.
    expect(run([two], r2.seen).notes, isEmpty);
    expect(run([one], r2.seen).notes, isEmpty);
    // For the Swift test.
    File('${dir.path}/captured.json').writeAsStringSync(jsonEncode({
      for (final (name, n) in [('one', one), ('two', two)])
        name: {'hostKey': base64Url.encode(n.session.hostKey), 'sessionId': n.session.sessionId, 'instanceId': n.session.instanceId, 'sealed': base64Url.encode(n.sealed)},
    }));
  }, skip: !ready);

  // The iOS notification extension's Swift (PircNotices' HostedFetch), on
  // the same relay and computer: given the account as the app keeps it and
  // the read seed, it shows the same notice.
  final hasSwift = Platform.isMacOS && Process.runSync('sh', ['-c', 'command -v swift']).exitCode == 0;
  test('the iOS extension\'s Swift wakes the same', () async {
    final before = DateTime.now().millisecondsSinceEpoch - 1;
    computer.say('notice Swift sees this');
    await Future<void>.delayed(const Duration(milliseconds: 500));
    final seed = (await store.load(relayKey, KeyKind.read))!;
    final captured = File('${dir.path}/captured.json');
    final state = File('${dir.path}/wake.json')
      ..writeAsStringSync(jsonEncode({
        'account': await prefs.get(accountKey),
        'seed': base64Url.encode(seed).replaceAll('=', ''),
        'since': before,
        'expect': 'fix the build · build box: Swift sees this',
        if (captured.existsSync()) 'captured': jsonDecode(captured.readAsStringSync()),
      }));
    final r = await Process.run('swift', ['test', '--filter', 'aWakeAgainstTheRelay|replayedNoticesShowOnce'], workingDirectory: 'ios/PircNotices', environment: {'PIRC_HOSTED_WAKE': state.path});
    expect(r.exitCode, 0, reason: '${r.stdout}\n${r.stderr}');
    expect('${r.stdout}', contains('aWakeAgainstTheRelay() passed'));
    expect('${r.stdout}', contains('replayedNoticesShowOnce() passed'));
  }, skip: !ready || !hasSwift ? 'needs go, node and swift on macOS' : false, timeout: const Timeout(Duration(minutes: 10)));

  test('the highest values are only raised', () async {
    final v = MemoryValues();
    await raiseHighest(v, {'a/1': Int64(5), 'b/2': Int64(9)});
    await raiseHighest(v, {'a/1': Int64(7), 'b/2': Int64(3)});
    expect(jsonDecode(v.values[noticesKey]!), {'a/1': '7', 'b/2': '9'});
  });

  test('a phone behind takes the newer list at the login, and the notices it opens', () async {
    // The account as a phone that never heard the computer was added.
    final behind = MemoryPrefs();
    final kept = jsonDecode((await prefs.get(accountKey))!) as Map<String, Object?>;
    kept['newest'] = kept['first'];
    await behind.set(accountKey, jsonEncode(kept));
    await behind.setRelay(relayKey);
    final before = DateTime.now().millisecondsSinceEpoch - 1;
    computer.say('notice Behind no more');
    List<HostedNote> got = [];
    for (var i = 0; i < 50 && got.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      got = await hostedNotes(e2e: e2e, values: behind, store: store, relay: relayKey, now: DateTime.now().millisecondsSinceEpoch, since: before);
    }
    expect(got.single.body, 'Behind no more');
    expect((await HostedAccount.load(e2e, behind))!.newest.counter, open.account.newest.counter);
  }, skip: !ready);

  test('a first wake shows no notice older than the last', () async {
    // As a phone that never saw this session: its notice is older than
    // the last wake.
    await prefs.set(noticesKey, null);
    // Past the slack for a computer's clock behind the phone's.
    expect(await notes(since: DateTime.now().millisecondsSinceEpoch + firstSightSlack.inMilliseconds + 60000), isEmpty);
  }, skip: !ready);

  test('through the wake, as Android runs it', () async {
    await prefs.setNotices(Shown(numbers: const {}, since: DateTime.now().millisecondsSinceEpoch - 1));
    computer.say('notice Woken');
    List<Note> got = [];
    for (var i = 0; i < 50 && got.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      got = await wake(prefs: prefs, store: store, now: DateTime.now().millisecondsSinceEpoch);
    }
    expect(got.single.body, 'Woken');
  }, skip: !ready);

  test('no read-only key, or no account: the fixed text, by Unreachable', () async {
    await expectLater(hostedNotes(e2e: e2e, values: prefs, store: MemoryKeyStore(), relay: relayKey, now: 0), throwsA(isA<NoticesUnreadable>()));
    await expectLater(hostedNotes(e2e: e2e, values: MemoryPrefs(), store: store, relay: relayKey, now: 0), throwsA(isA<NoticesUnreadable>()));
  }, skip: !ready);

  test('taken off the account: nothing shown, and the version that says so kept', () async {
    // A second phone of the account, then a version without it.
    final store2 = MemoryKeyStore();
    final prefs2 = MemoryPrefs();
    final second = await JoiningPhone.start(e2e: e2e, store: store2, values: prefs2, origin: relay.origin, attest: testAttest, protect: false);
    final a = open.account;
    final link = await HostedLink.connect(origin: a.origin, publicKey: open.main.signing.publicKey, sign: (m) async => open.main.sign(m), accountId: a.accountId);
    final frames = link.frames.asBroadcastStream();
    for (var i = 0;; i++) {
      final add = AddDevice(
        e2e: e2e,
        account: PhoneAccount(accountId: a.accountId, phone: a.self, signing: open.main.signing, channel: open.main.channel.secretKey, first: a.first, newest: a.newest.bytes, name: 'Pixel 9', counter: MemoryCounter().next),
        frames: frames,
        send: link.send,
      );
      try {
        await add.start(second.text);
        await a.take(await add.confirm());
        break;
      } on JoinFailed catch (e) {
        if (!e.message.startsWith('no device shows') || i > 20) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
    }
    final theirs = await second.done;
    addTearDown(theirs.dispose);
    // Before: the second phone reads notices.
    await prefs2.setRelay(relayKey);
    final before = DateTime.now().millisecondsSinceEpoch - 1;
    computer.say('notice For both phones');
    List<HostedNote> seenBefore = [];
    for (var i = 0; i < 50 && seenBefore.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
      seenBefore = await hostedNotes(e2e: e2e, values: prefs2, store: store2, relay: relayKey, now: DateTime.now().millisecondsSinceEpoch, since: before);
    }
    expect(seenBefore.single.body, 'For both phones');
    computer.say('notice After the removal');
    await Future<void>.delayed(const Duration(milliseconds: 500));
    final body = Uint8List.sublistView(a.newest.bytes, signatureBytes);
    final without = e2e.makeList(phone: open.main.signing, devices: [for (final d in a.newest.body.devices) if (!sameDevice(d, theirs.account.self)) d], previousBody: body, accountId: a.accountId, counter: a.newest.counter + 1);
    link.send(Frame(publishList: PublishList(requestId: 'rm', list: without)));
    await frames.firstWhere((f) => f.hasDone()).timeout(const Duration(seconds: 10));
    await link.close();
    expect(await hostedNotes(e2e: e2e, values: prefs2, store: store2, relay: relayKey, now: DateTime.now().millisecondsSinceEpoch, since: before), isEmpty);
    expect((await HostedAccount.load(e2e, prefs2))!.listed, isFalse);
  }, skip: !ready);
}

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
