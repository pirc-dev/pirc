// The app following its relay to a new port from Settings, against the Go
// relay (skipped, saying so, without go): the phone joins, the relay moves,
// and the new address is kept, with the keys under it, only once the relay
// answers there; another relay's address keeps the old.
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/join.dart';
import 'package:pirc/keys/key_store.dart';
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
}
