// Removing a device from the account's phone (ui/hosted_devices.dart,
// app/hosted_devices.dart): what it does said by role and asked first, this
// phone never removable; against the Go relay, a TypeScript computer
// removed stops and its session goes from the list, and a second phone
// removed is told so.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/core/client.dart' show keyText;
import 'package:pirc/core/protocol.dart';
import 'package:pirc/core/view.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'package:pirc/app/hosted_devices.dart';
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/connection.dart';
import 'package:pirc/hosted/names.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/ui/hosted_devices.dart';
import 'package:pirc/ui/look.dart';
import 'package:pirc/ui/sessions_screen.dart';

import 'support/relay.dart';
import 'support/ts_computer.dart';

Future<v2.Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => v2.Attestation(test: [1]);

class _Devices implements HostedDevices {
  @override
  bool get isPhone => true;
  @override
  Set<String> get behind => const {};
  @override
  void addDevice(BuildContext context) {}
  @override
  Future<String?> rename(String key, String name) async => null;
  final removed = <String>[];
  @override
  Future<String?> remove(String key) async {
    removed.add(key);
    return null;
  }
}

String _all(WidgetTester tester) => tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? t.textSpan?.toPlainText() ?? '').join(' | ');

void main() {
  testWidgets('removing is said by role and asked first; this phone has no Remove', (tester) async {
    final self = Uint8List(32);
    final m = PircModel(send: (_) => true, publicKey: self);
    m.client.onState(const RelayView(state: 'ready'));
    final host = Uint8List(32)..[0] = 1;
    m.client.onFrame(Frame(keys: Keys(keys: [RegisteredKey(publicKey: self, role: Role.ROLE_CLIENT), RegisteredKey(publicKey: host, role: Role.ROLE_HOST, label: 'build box')])));
    final d = _Devices();
    await tester.pumpWidget(LookScope(
      look: Look.light,
      child: CupertinoApp(
        home: CupertinoPageScaffold(child: ListView(children: [
          HostedDeviceList(model: m, role: 'host', devices: d),
          HostedDeviceList(model: m, role: 'client', devices: d),
        ])),
      ),
    ));
    await tester.tap(find.text('build box'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove this computer'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Its sessions end here'), findsOneWidget);
    await tester.tap(find.widgetWithText(CupertinoDialogAction, 'Cancel'));
    await tester.pumpAndSettle();
    expect(d.removed, isEmpty);
    await tester.tap(find.text('Remove this computer'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(CupertinoDialogAction, 'Remove'));
    await tester.pumpAndSettle();
    expect(d.removed, [keyText(host)]);
    expect(removalText(const DeviceView(key: 'k', role: 'client', label: '', addedAt: 0, online: false, self: false, push: false)), contains('loses every computer'));
    // This phone's sheet: no Remove.
    await tester.tap(find.text('This phone'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Remove this'), findsNothing);
  });

  group('against the relay', () {
    final ready = hasGo && hasNode;
    late Directory dir;
    late HostedRelay relay;
    late E2e e2e;
    setUpAll(() async {
      if (!ready) return;
      e2e = await E2e.load();
      dir = await Directory.systemTemp.createTemp('pirc-hosted-removal-');
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

    // A sheet's or page's animation done.
    Future<void> settle(WidgetTester tester) async {
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    PircModel model(WidgetTester tester) => tester.widget<SessionsScreen>(find.byType(SessionsScreen, skipOffstage: false)).model;

    // The account's phone adds a device by its code, from its keys kept.
    Future<void> add(KeyStore store, MemoryPrefs prefs, String text) async {
      final open = (await openAccount(e2e: e2e, store: store, values: prefs, relay: hostedRelayKey(relay.origin)))!;
      final a = open.account;
      final link = await HostedLink.connect(origin: a.origin, publicKey: open.main.signing.publicKey, sign: (m) async => open.main.sign(m), accountId: a.accountId);
      final frames = link.frames.asBroadcastStream();
      try {
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
            return;
          } on JoinFailed catch (e) {
            if (!e.message.startsWith('no device shows') || i > 20) rethrow;
            await Future<void>.delayed(const Duration(milliseconds: 150));
          }
        }
      } finally {
        await link.close();
        open.dispose();
      }
    }

    test('two removals at once: each built on the one before, both hold; the names sealed again without them', () async {
      final store = MemoryKeyStore();
      final prefs = MemoryPrefs();
      final open = await signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false);
      await prefs.setRelay(hostedRelayKey(relay.origin));
      final computer = await TsComputer.start(relay.origin);
      addTearDown(computer.kill);
      await add(store, prefs, await computer.until((l) => l.startsWith('PIRC1')));
      await computer.until((l) => l == 'status ready');
      final joining = await JoiningPhone.start(e2e: e2e, store: MemoryKeyStore(), values: MemoryPrefs(), origin: relay.origin, attest: testAttest, protect: false);
      await add(store, prefs, joining.text);
      final second = await joining.done;
      addTearDown(second.dispose);
      // The account as this phone runs it, the versions above taken.
      final again = (await openAccount(e2e: e2e, store: store, values: prefs, relay: hostedRelayKey(relay.origin)))!;
      open.dispose();
      final run = HostedRun(e2e: e2e, open: again, toClient: (_) {}, relayState: (_) {}, values: prefs);
      addTearDown(run.dispose);
      run.start();
      for (var i = 0; i < 100 && run.conn.current is! HostedReady; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      final devices = AppHostedDevices(e2e: e2e, run: run, values: prefs, counter: MemoryCounter());
      final a = again.account;
      final pc = a.newest.body.devices.singleWhere((d) => d.role == roleComputer);
      final phone2 = second.account.self;
      expect(await devices.rename(keyText(phone2.signingKey), 'Old phone'), isNull);
      final before = a.newest.counter;
      final both = await Future.wait([devices.remove(keyText(pc.signingKey)), devices.remove(keyText(phone2.signingKey))]);
      expect(both, [null, null]);
      expect(a.newest.counter, before + 2);
      expect(a.newest.body.devices.map((d) => d.role), [roleClient]);
      // As the relay has it too.
      final link = await HostedLink.connect(origin: a.origin, publicKey: again.main.signing.publicKey, sign: (m) async => again.main.sign(m), accountId: a.accountId);
      await link.close();
      expect(link.welcome.listCounter, a.newest.counter);
      await computer.until((l) => l == 'status removed');
      // No name kept for a device gone.
      expect(await keptNames(prefs), isEmpty);
    }, skip: !ready);

    testWidgets('a computer removed stops and its session goes; a second phone removed is told so', (tester) async {
      tester.view.physicalSize = const Size(1170, 7000);
      addTearDown(tester.view.reset);
      final store = MemoryKeyStore();
      final prefs = MemoryPrefs();
      await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest, storefront: () async => null));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign up'));
      await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');

      // A computer and a second phone, added by the account's phone.
      final computer = (await tester.runAsync(() => TsComputer.start(relay.origin)))!;
      addTearDown(computer.kill);
      final text = (await tester.runAsync(() => computer.until((l) => l.startsWith('PIRC1'))))!;
      await tester.runAsync(() => add(store, prefs, text));
      await tester.runAsync(() => computer.until((l) => l == 'status ready'));
      final joining = (await tester.runAsync(() => JoiningPhone.start(e2e: e2e, store: MemoryKeyStore(), values: MemoryPrefs(), origin: relay.origin, attest: testAttest, protect: false)))!;
      await tester.runAsync(() => add(store, prefs, joining.text));
      final second = (await tester.runAsync(() => joining.done))!;
      var secondRemoved = false;
      final secondRun = HostedRun(e2e: e2e, open: second, toClient: (_) {}, relayState: (_) {}, onRemoved: () => secondRemoved = true);
      addTearDown(secondRun.dispose);
      await tester.runAsync(() async => secondRun.start());
      await until(tester, () => model(tester).sessions.any((s) => s.name == 'fix the build'));

      // The computer, from Settings.
      await tester.tap(find.bySemanticsLabel('Settings'));
      await until(tester, () => find.text('build box').evaluate().isNotEmpty);
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      await tester.tap(find.text('build box'));
      await until(tester, () => find.text('Remove this computer').evaluate().isNotEmpty);
      await settle(tester);
      await tester.tap(find.text('Remove this computer'));
      await until(tester, () => find.widgetWithText(CupertinoDialogAction, 'Remove').evaluate().isNotEmpty);
      await tester.tap(find.widgetWithText(CupertinoDialogAction, 'Remove'));
      await until(tester, () => find.text('build box').evaluate().isEmpty);
      expect(find.text('build box'), findsNothing, reason: _all(tester));
      await tester.runAsync(() => computer.until((l) => l == 'status removed'));
      await until(tester, () => model(tester).sessions.isEmpty);
      expect(model(tester).sessions, isEmpty);

      // The second phone, likewise.
      await tester.tap(find.text('A phone or browser'));
      await until(tester, () => find.text('Remove this phone or browser').evaluate().isNotEmpty);
      await settle(tester);
      await tester.tap(find.text('Remove this phone or browser'));
      await until(tester, () => find.widgetWithText(CupertinoDialogAction, 'Remove').evaluate().isNotEmpty);
      await tester.tap(find.widgetWithText(CupertinoDialogAction, 'Remove'));
      await until(tester, () => secondRemoved && find.text('A phone or browser').evaluate().isEmpty);
      expect(secondRemoved, isTrue);
      expect(find.text('A phone or browser'), findsNothing, reason: _all(tester));

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    }, skip: !ready);
  });
}
