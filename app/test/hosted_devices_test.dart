// A hosted account's devices in Settings (ui/hosted_devices.dart,
// app/hosted_devices.dart, hosted/names.dart): against the Go relay, the
// account's phone adds a TypeScript computer from Settings by its code's
// text, the computer listed under its own name, then renamed, the name
// sealed and back from the relay. Without a relay: who may add and rename,
// a computer behind the newest list said so, the names' ordering, and one
// counter file for every caller.
import 'dart:async';
import 'dart:io';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/core/client.dart' show keyText;
import 'package:pirc/core/protocol.dart';
import 'package:pirc/core/view.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/connection.dart';
import 'package:pirc/hosted/keys.dart';
import 'package:pirc/e2e/names.dart';
import 'package:pirc/hosted/names.dart';
import 'package:pirc/hosted/sessions.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/ui/hosted_devices.dart';
import 'package:pirc/ui/hosted_join_screens.dart';
import 'package:pirc/ui/look.dart';
import 'package:pirc/ui/sessions_screen.dart';
import 'package:pirc/ui/adaptive.dart';

import 'support/relay.dart';
import 'support/ts_computer.dart';

Future<v2.Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => v2.Attestation(test: [1]);

class _Devices implements HostedDevices {
  _Devices({required this.isPhone, this.behind = const {}});
  @override
  final bool isPhone;
  @override
  final Set<String> behind;
  var added = 0;
  final renamed = <(String, String)>[];
  @override
  void addDevice(BuildContext context) => added++;
  @override
  Future<String?> rename(String key, String name) async {
    renamed.add((key, name));
    return null;
  }

  final removed = <String>[];
  @override
  Future<String?> remove(String key) async {
    removed.add(key);
    return null;
  }
}

void main() {
  final ready = hasGo && hasNode;
  late Directory dir;
  late HostedRelay relay;
  late E2e e2e;

  setUpAll(() async {
    if (!ready) return;
    e2e = await E2e.load();
    dir = await Directory.systemTemp.createTemp('pirc-hosted-devices-');
    relay = await HostedRelay.start(dir);
  });
  tearDownAll(() async {
    if (!ready) return;
    relay.kill();
    await dir.delete(recursive: true);
  });

  Future<void> until(WidgetTester tester, bool Function() done, {int tries = 150}) async {
    for (var i = 0; i < tries && !done(); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  String shown(WidgetTester tester) => tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? t.textSpan?.toPlainText() ?? '').join(' | ');

  PircModel model(WidgetTester tester) => tester.widget<SessionsScreen>(find.byType(SessionsScreen, skipOffstage: false)).model;

  testWidgets('the account\'s phone adds a computer from Settings, and renames it', (tester) async {
    tester.view.physicalSize = const Size(1170, 4000);
    addTearDown(tester.view.reset);
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs();
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest));
    await tester.pump();
    await tester.tap(find.text('Sign up'));
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');

    await tester.tap(find.bySemanticsLabel('Settings'));
    await until(tester, () => find.text('Add a device').evaluate().isNotEmpty);
    expect(find.text('Add a device'), findsNWidgets(2));
    expect(find.text('COMPUTERS'), findsOneWidget, reason: shown(tester));
    expect(find.text('No computers yet.'), findsOneWidget);
    expect(find.text('This phone'), findsOneWidget);
    // Nothing of a self-hosted relay's.
    expect(find.text('Change address'), findsNothing);

    final computer = (await tester.runAsync(() => TsComputer.start(relay.origin)))!;
    addTearDown(computer.kill);
    final text = (await tester.runAsync(() => computer.until((l) => l.startsWith('PIRC1'))))!;
    await tester.tap(find.text('Add a device').first);
    await until(tester, () => find.byType(AddDeviceScreen).evaluate().isNotEmpty);
    await tester.enterText(find.byType(CupertinoTextField), text);
    await tester.tap(find.text('Use the text'));
    await until(tester, () => find.text('It is mine: add it').evaluate().isNotEmpty);
    expect(find.textContaining('A computer: you will be able to control it from here.'), findsOneWidget, reason: shown(tester));
    await tester.tap(find.text('It is mine: add it'));
    await until(tester, () => find.text('Done').evaluate().isNotEmpty);
    await tester.runAsync(() => computer.until((l) => l == 'status ready'));
    await tester.tap(find.text('Done'));
    await until(tester, () => find.text('build box').evaluate().isNotEmpty);
    // Listed under the name it gave itself, once its session was seen.
    expect(find.text('build box'), findsOneWidget, reason: shown(tester));
    // Its channel said the newest counter: confirmed, nothing said.
    await until(tester, () => find.text('Has not yet confirmed the latest change to this account').evaluate().isEmpty);
    expect(find.text('Has not yet confirmed the latest change to this account'), findsNothing, reason: shown(tester));

    // Renamed: sealed to every client, and back from the relay so.
    expect(find.bySemanticsLabel('build box: rename'), findsOneWidget);
    // The add screen's page gone first.
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.tap(find.text('build box'));
    await until(tester, () => find.text('Save').evaluate().isNotEmpty);
    expect(find.text('Save'), findsOneWidget, reason: shown(tester));
    await tester.enterText(find.byType(CupertinoTextField), 'Desk');
    // Saved from the keyboard, which covers the sheet's buttons here.
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await until(tester, () => find.text('Save').evaluate().isEmpty);
    expect(find.text('Save'), findsNothing, reason: shown(tester));
    expect(find.text('Desk'), findsOneWidget, reason: shown(tester));
    // The session, too, shows under it.
    await until(tester, () => model(tester).sessions.any((s) => s.hostLabel == 'Desk'));
    expect(model(tester).sessions.map((s) => '${s.name} on ${s.hostLabel}'), ['fix the build on Desk']);

    // A second phone added afterwards: the names are sealed again, to it too.
    final joining = (await tester.runAsync(() async {
      final e2e = await E2e.load();
      return JoiningPhone.start(e2e: e2e, store: MemoryKeyStore(), values: MemoryPrefs(), origin: relay.origin, attest: testAttest, protect: false);
    }))!;
    for (var i = 0; i < 10; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    await tester.tap(find.text('Add a device').first);
    await until(tester, () => find.byType(AddDeviceScreen).evaluate().isNotEmpty);
    await tester.enterText(find.byType(CupertinoTextField), joining.text);
    await tester.tap(find.text('Use the text'));
    await until(tester, () => find.text('It is mine: add it').evaluate().isNotEmpty);
    await tester.tap(find.text('It is mine: add it'));
    await until(tester, () => find.text('Done').evaluate().isNotEmpty);
    final second = (await tester.runAsync(() => joining.done))!;
    addTearDown(second.dispose);
    final names = (await tester.runAsync(() async {
      final e2e = await E2e.load();
      final run = HostedRun(e2e: e2e, open: second, toClient: (_) {}, relayState: (_) {});
      run.start();
      try {
        for (var i = 0; i < 100 && run.sessions.names.isEmpty; i++) {
          if (run.conn.current is HostedReady) run.sessions.fromClient(Frame(watchKeys: WatchKeys()));
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        return run.sessions.names;
      } finally {
        run.conn.stop();
        run.sessions.dispose();
      }
    }))!;
    expect(names.values, contains('Desk'));

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !ready);

  group('the list', () {
    Future<PircModel> listed(WidgetTester tester, HostedDevices devices) async {
      final m = PircModel(send: (_) => true);
      m.client.onState(const RelayView(state: 'ready'));
      m.client.onFrame(Frame(
        keys: Keys(keys: [
          RegisteredKey(publicKey: Uint8List(32), role: Role.ROLE_CLIENT, online: true),
          RegisteredKey(publicKey: Uint8List(32)..[0] = 1, role: Role.ROLE_HOST, label: 'build box'),
        ]),
      ));
      await tester.pumpWidget(LookScope(
        look: Look.light,
        child: CupertinoApp(
          localizationsDelegates: appLocalizations,
          builder: (context, child) => platformControls(Look.light, Brightness.light, child!),
          home: CupertinoPageScaffold(child: ListView(children: [
            HostedDeviceList(model: m, role: 'host', devices: devices),
            HostedDeviceList(model: m, role: 'client', devices: devices),
          ])),
        ),
      ));
      return m;
    }

    testWidgets('the account\'s phone may add and rename; a computer behind says so', (tester) async {
      final key = keyText(Uint8List(32)..[0] = 1);
      final d = _Devices(isPhone: true, behind: {key});
      await listed(tester, d);
      expect(find.text('Has not yet confirmed the latest change to this account'), findsOneWidget);
      await tester.tap(find.text('Add a device').first);
      expect(d.added, 1);
      await tester.tap(find.text('Add a device').last);
      expect(d.added, 2);
      await tester.tap(find.text('build box'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(CupertinoTextField), 'Desk');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(d.renamed.single, (key, 'Desk'));
    });

    testWidgets('another phone only sees them', (tester) async {
      final d = _Devices(isPhone: false);
      await listed(tester, d);
      expect(find.text('Add a device'), findsNothing);
      await tester.tap(find.text('build box'));
      await tester.pumpAndSettle();
      expect(find.text('Save'), findsNothing);
      expect(find.text('Has not yet confirmed the latest change to this account'), findsNothing);
    });
  });

  test('the names and orderings kept go with the account', () async {
    final prefs = MemoryPrefs();
    for (final k in [namesKey, namesSeenKey, 'hosted.names.ordering']) {
      await prefs.set(k, '1');
    }
    await forgetNames(prefs);
    for (final k in [namesKey, namesSeenKey, 'hosted.names.ordering']) {
      expect(await prefs.get(k), isNull, reason: k);
    }
  });

  test('one counter file for every caller, also while the folder is asked', () async {
    final d = Directory.systemTemp.createTempSync('pirc-folder-counter-');
    addTearDown(() => d.deleteSync(recursive: true));
    final folder = Completer<String>();
    final c = FolderCounter(() => folder.future);
    final a = c.next(Int64(2));
    final b = c.next(Int64(2));
    folder.complete(d.path);
    expect({await a, await b}, {Int64(2), Int64(3)});
  });

  group('names', () {
    test('only the account\'s phone gives them, its ordering past what it saw and kept', () async {
      if (!ready) return;
      final prefs = MemoryPrefs();
      final store = MemoryKeyStore();
      final open = await signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false);
      final run = HostedRun(e2e: e2e, open: open, toClient: (_) {}, relayState: (_) {}, values: prefs);
      addTearDown(run.dispose);
      run.start();
      for (var i = 0; i < 100 && run.conn.current is! HostedReady; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      // An ordering kept ahead of the clock: the next is one past it.
      final ahead = DateTime.now().millisecondsSinceEpoch + 100000;
      await prefs.set('hosted.names.ordering', '$ahead');
      await publishNames(e2e: e2e, open: open, sessions: run.sessions, values: prefs, names: {for (final d in open.account.newest.body.devices) _hex(d.signingKey): 'Pixel 9'});
      final kept = Int64.parseInt((await prefs.get('hosted.names.ordering'))!);
      expect(kept, Int64(ahead + 1));
      // Back from the relay with Devices, under the ordering made.
      run.sessions.fromClient(Frame(watchKeys: WatchKeys()));
      for (var i = 0; i < 100 && run.sessions.names.isEmpty; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      expect(run.sessions.names.values.single, 'Pixel 9');
      expect(run.sessions.namesOrdering, kept);

      // An older copy of the phone's own, as the relay could give back,
      // after a restart too: refused, the highest seen being kept.
      final old = e2e.makeNames(
        accountId: open.account.accountId,
        list: open.account.newest.body,
        phone: open.main.signing,
        phoneBoxSecretKey: open.main.box.secretKey,
        ordering: kept - 1,
        names: [DeviceName(open.account.self.signingKey, 'old')],
      ).copies.single.sealed;
      run.sessions.onFrame(v2.Frame(devices: v2.Devices(names: old)));
      final sentAgain = <v2.Frame>[];
      final again = HostedSessions(e2e: e2e, account: open.account, main: open.main, sendRelay: (f) {
        sentAgain.add(f);
        return true;
      }, toClient: (_) {}, relayState: (_) {}, values: prefs);
      addTearDown(again.dispose);
      again.onState(HostedReady(v2.Welcome(maxFrameBytes: 1 << 20, listCounter: open.account.newest.counter)));
      again.onFrame(v2.Frame(devices: v2.Devices(names: old)));
      await Future<void>.delayed(const Duration(milliseconds: 100));
      expect(again.names, isEmpty);
      expect(run.sessions.names.values.single, 'Pixel 9');
      // From there, given nothing by the relay, the phone still publishes
      // the names it keeps.
      final publishing = publishNames(e2e: e2e, open: open, sessions: again, values: prefs, names: {});
      await Future<void>.delayed(const Duration(milliseconds: 50));
      final pub = sentAgain.lastWhere((f) => f.hasPublishNames()).publishNames;
      again.onFrame(v2.Frame(done: v2.Done(requestId: pub.requestId)));
      await publishing;
      final mine = pub.copies.singleWhere((c) => _hex(c.recipientKey) == _hex(open.account.self.boxKey));
      final opened = e2e.openNames(
        sealed: mine.sealed,
        accountId: open.account.accountId,
        list: open.account.newest.body,
        phoneKey: open.account.phoneKey,
        recipientSecretKey: open.main.box.secretKey.extractBytes(),
        now: Int64(DateTime.now().millisecondsSinceEpoch),
      );
      expect(opened.names.map((n) => n.name), ['Pixel 9']);
      // Names wiped by the relay: the phone publishes from what it keeps.
      run.sessions.onFrame(v2.Frame(devices: v2.Devices()));

      // Names given later keep those given before.
      await publishNames(e2e: e2e, open: open, sessions: run.sessions, values: prefs, names: {});
      for (var i = 0; i < 100 && run.sessions.namesOrdering == kept; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      expect(run.sessions.namesOrdering, greaterThan(kept));
      expect(run.sessions.names.values.single, 'Pixel 9');

      // Another phone of the account gives none.
      final otherMain = MainKeys.fromSeed(e2e.sodium, e2e.sodium.randombytes.buf(32));
      final otherRead = ReadKeys.fromSeed(e2e.sodium, e2e.sodium.randombytes.buf(32));
      final other = phoneDevice(otherMain, otherRead);
      final a = open.account;
      final v2list = e2e.makeList(phone: open.main.signing, devices: [a.self, other], previousBody: Uint8List.sublistView(a.first, signatureBytes), accountId: a.accountId, counter: Int64(2));
      final theirs = await HostedAccount.create(e2e, MemoryPrefs(), origin: a.origin, accountId: a.accountId, phoneKey: a.phoneKey, self: other, first: a.first, newest: v2list);
      final openOther = OpenAccount(theirs, otherMain, otherRead, Uint8List(32));
      addTearDown(openOther.dispose);
      await expectLater(publishNames(e2e: e2e, open: openOther, sessions: run.sessions, values: MemoryPrefs(), names: {_hex(other.signingKey): 'mine'}), throwsStateError);
    });
  });
}

String _hex(List<int> b) => b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
