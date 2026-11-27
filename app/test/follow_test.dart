// The app following its relay to a new port from Settings, and leaving it,
// against the Go relay (skipped, saying so, without go): the phone joins,
// the relay moves, and the new address is kept, with the keys under it,
// only once the relay answers there; another relay's address keeps the old.
// Leaving takes the phone off the relay's list, or, the relay out of reach
// and the person agreeing, leaves this phone only; a join link to another
// relay offers leaving first.
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/links.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/join.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/ui/join_screen.dart';
import 'package:pirc/ui/relay_address.dart';
import 'package:pirc/ui/sessions_screen.dart';

import 'support/relay.dart';

void main() {
  late Directory dir;
  late Relay relay;
  setUpAll(() async {
    if (!hasGo) return;
    dir = await Directory.systemTemp.createTemp('pirc-app-follow-');
    relay = await Relay.start(dir);
  });
  tearDownAll(() async {
    if (!hasGo) return;
    relay.kill();
    await dir.delete(recursive: true);
  });

  // Pumps, letting the sockets work and pages move, until done or about
  // 10 seconds.
  Future<void> until(WidgetTester tester, bool Function() done) async {
    for (var i = 0; i < 100 && !done(); i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump(const Duration(milliseconds: 100));
    }
  }

  // What the screen says, for a failure's message.
  String shown(WidgetTester tester) => tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? t.textSpan?.toPlainText() ?? '').join(' | ');

  PircModel model(WidgetTester tester) => tester.widget<SessionsScreen>(find.byType(SessionsScreen)).model;

  // A phone's screen: the test's own window is as wide as a tablet's.
  void phone(WidgetTester tester) {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
  }

  Future<void> changeTo(WidgetTester tester, String to) async {
    await tester.tap(find.bySemanticsLabel('Settings'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Change address'), 200);
    await tester.tap(find.text('Change address'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(CupertinoTextField), to);
    await tester.tap(find.text('Connect'));
    await tester.pump();
  }

  testWidgets('the relay moved to another port: changed in Settings, the phone follows it there, keeping its keys', (tester) async {
    phone(tester);
    final store = MemoryKeyStore();
    final old = relay.url;
    await tester.runAsync(() => join(JoinLink(old, relay.cmd('add-client', ['--label', 'phone'])), store, protect: false));
    final prefs = MemoryPrefs(old);
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false));
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
    expect(model(tester).relay.state, 'ready');
    final main = await tester.runAsync(() => store.load(old, KeyKind.main));

    await tester.runAsync(() async => relay = await relay.moved());
    await changeTo(tester, relay.url);
    await until(tester, () => find.byType(RelayAddressScreen).evaluate().isEmpty && model(tester).relay.state == 'ready');
    expect(find.byType(RelayAddressScreen), findsNothing, reason: shown(tester));
    expect(model(tester).relay.state, 'ready');
    expect(await tester.runAsync(prefs.relay), relay.url);
    expect(await tester.runAsync(() => store.load(relay.url, KeyKind.main)), main);
    expect(await tester.runAsync(() => store.load(old, KeyKind.main)), isNull, reason: 'the old address keeps nothing');

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !hasGo);

  testWidgets("another relay's address: it says why, and the phone stays on its own", (tester) async {
    phone(tester);
    final store = MemoryKeyStore();
    final own = relay.url;
    await tester.runAsync(() => join(JoinLink(own, relay.cmd('add-client', ['--label', 'phone'])), store, protect: false));
    final prefs = MemoryPrefs(own);
    final otherDir = (await tester.runAsync(() => Directory.systemTemp.createTemp('pirc-app-other-')))!;
    final other = (await tester.runAsync(() => Relay.start(otherDir)))!;
    addTearDown(() async {
      other.kill();
      await otherDir.delete(recursive: true);
    });
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false));
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');

    await changeTo(tester, other.url);
    await until(tester, () => find.textContaining("doesn't know this phone").evaluate().isNotEmpty);
    expect(find.textContaining("doesn't know this phone"), findsOneWidget);
    expect(await tester.runAsync(prefs.relay), own);
    expect(await tester.runAsync(() => store.load(other.url, KeyKind.main)), isNull);
    // Back to Settings, then to the list.
    Navigator.of(tester.element(find.byType(RelayAddressScreen)))
      ..pop()
      ..pop();
    await tester.pumpAndSettle();
    await until(tester, () => model(tester).relay.state == 'ready');
    expect(model(tester).relay.state, 'ready', reason: 'connected to its own address again');

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !hasGo);

  Future<void> leaveFromSettings(WidgetTester tester) async {
    await tester.tap(find.bySemanticsLabel('Settings'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('Leave this relay'), 200);
    await tester.tap(find.text('Leave this relay'));
    await tester.pumpAndSettle();
  }

  // Joined and connected, as a phone labelled label.
  Future<(MemoryKeyStore, MemoryPrefs)> joined(WidgetTester tester, String label, {LinkPlatform? links}) async {
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final store = MemoryKeyStore();
    await tester.runAsync(() => join(JoinLink(relay.url, relay.cmd('add-client', ['--label', label])), store, protect: false));
    final prefs = MemoryPrefs(relay.url);
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, links: links, protect: false));
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
    expect(model(tester).relay.state, 'ready');
    return (store, prefs);
  }

  testWidgets("leaving from Settings: told it is the relay's only app, the relay takes it off its list, and the phone is back to joining", (tester) async {
    // The relay's only client: the earlier tests' phones go first.
    for (final line in relay.cmd('list', []).split('\n').where((l) => l.contains('client'))) {
      final key = RegExp(r'[A-Za-z0-9_-]{43}').firstMatch(line)?.group(0);
      if (key != null) relay.cmd('remove', ['--', key.substring(0, 20)]);
    }
    final (store, prefs) = await joined(tester, 'leaver');
    final url = relay.url;
    await leaveFromSettings(tester);
    expect(find.textContaining("This phone is the relay's only app"), findsOneWidget);
    await tester.tap(find.text('Leave'));
    await tester.pump();
    await until(tester, () => find.byType(JoinScreen).evaluate().isNotEmpty);
    expect(find.byType(JoinScreen), findsOneWidget, reason: shown(tester));
    expect(await tester.runAsync(prefs.relay), isNull);
    expect(await tester.runAsync(() => store.load(url, KeyKind.main)), isNull);
    expect(await tester.runAsync(() => store.load(url, KeyKind.read)), isNull);
    expect(relay.cmd('list', []), isNot(contains('leaver')));

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !hasGo);

  testWidgets('leaving with the relay out of reach: asked again, this phone alone leaves, its entry staying on the list', (tester) async {
    final (store, prefs) = await joined(tester, 'stranded');
    final old = relay.url;
    await tester.runAsync(() async => relay = await relay.moved());
    await until(tester, () => model(tester).relay.state != 'ready');
    await leaveFromSettings(tester);
    await tester.tap(find.text('Leave'));
    await tester.pumpAndSettle();
    expect(find.text('Leave this phone only?'), findsOneWidget, reason: shown(tester));
    expect(find.textContaining("keeps it on its list"), findsOneWidget);
    await tester.tap(find.text('Leave this phone only'));
    await tester.pump();
    await until(tester, () => find.byType(JoinScreen).evaluate().isNotEmpty);
    expect(find.byType(JoinScreen), findsOneWidget, reason: shown(tester));
    expect(await tester.runAsync(prefs.relay), isNull);
    expect(await tester.runAsync(() => store.load(old, KeyKind.main)), isNull);
    expect(relay.cmd('list', []), contains('stranded'), reason: 'the relay was not asked');

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !hasGo);

  testWidgets("a join link to another relay: leaving this one is offered, then the link waits on the join screen for a tap", (tester) async {
    const channel = MethodChannel('dev.pirc.app/links');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => null);
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
    final (store, prefs) = await joined(tester, 'switcher', links: LinkPlatform());
    final own = relay.url;
    final link = 'pirc://join?relay=${Uri.encodeComponent('ws://127.0.0.1:9')}&token=t';
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(channel.name, channel.codec.encodeMethodCall(MethodCall('opened', link)), (_) {});
    await tester.pumpAndSettle();
    expect(find.text('Leave ${own.substring(5)} and join this one?'), findsOneWidget, reason: shown(tester));
    await tester.tap(find.text('Leave and join'));
    await tester.pump();
    await until(tester, () => find.byType(JoinScreen).evaluate().isNotEmpty);
    expect(find.byType(JoinScreen), findsOneWidget, reason: shown(tester));
    await tester.pump();
    expect(tester.widget<CupertinoTextField>(find.byType(CupertinoTextField)).controller!.text, link, reason: 'filled in, not joined');
    expect(await tester.runAsync(prefs.relay), isNull);
    expect(await tester.runAsync(() => store.load(own, KeyKind.main)), isNull);
    expect(relay.cmd('list', []), isNot(contains('switcher')));

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !hasGo);
}
