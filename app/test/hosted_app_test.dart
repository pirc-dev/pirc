// A hosted account made, joined and opened (lib/hosted/setup.dart), and
// the app on it, against the Go relay in its hosted mode: signing up from
// the first screen, the app opened again on the kept account, a computer's
// session in its list (extension/test/hosted-computer.ts), and a second
// phone joining. A failed sign-up or join keeps no key.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/app/store.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart';
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/ui/hosted_start_screen.dart';
import 'package:pirc/ui/join_screen.dart';
import 'package:pirc/ui/sessions_screen.dart';

import 'support/relay.dart';
import 'support/ts_computer.dart';

// A store with no subscription on it.
class _NoSubscription implements Store {
  @override
  Stream<void> get changed => const Stream.empty();
  @override
  Future<StoreStatus> status() async => const StoreStatus(Access.never);
  @override
  Future<StoreProduct?> product() async => null;
  @override
  Future<Bought> buy() async => Bought.cancelled;
  @override
  Future<void> restore() async {}
  @override
  Future<void> manage() async {}
}

Future<Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => Attestation(test: [1]);

void main() {
  late Directory dir;
  late HostedRelay relay;
  late E2e e2e;
  final ready = hasGo && hasNode;

  setUpAll(() async {
    if (!ready) return;
    e2e = await E2e.load();
    dir = await Directory.systemTemp.createTemp('pirc-hosted-app-');
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

  PircModel model(WidgetTester tester) => tester.widget<SessionsScreen>(find.byType(SessionsScreen)).model;

  // Adds the computer to the account, as the account's phone, from its
  // keys kept in store.
  Future<void> addComputer(KeyStore store, MemoryPrefs prefs, TsComputer computer) async {
    final text = await computer.until((l) => l.startsWith('PIRC1'));
    final relayKey = (await prefs.relay())!;
    final open = (await openAccount(e2e: e2e, store: store, values: prefs, relay: relayKey))!;
    final a = open.account;
    final link = await HostedLink.connect(origin: a.origin, publicKey: open.main.signing.publicKey, sign: (m) async => open.main.sign(m), accountId: a.accountId);
    final frames = link.frames.asBroadcastStream();
    final phone = PhoneAccount(
      accountId: a.accountId,
      phone: a.self,
      signing: open.main.signing,
      channel: open.main.channel.secretKey,
      first: a.first,
      newest: a.newest.bytes,
      name: 'Pixel 9',
      counter: MemoryCounter().next,
    );
    try {
      for (var i = 0;; i++) {
        final add = AddDevice(e2e: e2e, account: phone, frames: frames, send: link.send);
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

  testWidgets('signed up from the first screen, opened again on the kept account, a computer\'s session listed', (tester) async {
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs();
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest));
    await tester.pump();
    expect(find.byType(HostedStartScreen), findsOneWidget);
    await tester.tap(find.text('Sign up'));
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
    expect(model(tester).relay.state, 'ready', reason: shown(tester));
    final relayKey = (await tester.runAsync(prefs.relay))!;
    expect(relayKey, hostedRelayKey(relay.origin));
    expect(await tester.runAsync(() => store.load(relayKey, KeyKind.main)), isNotNull);

    // Closed and opened again: the kept account, unlocked, connected; the
    // phone's own store, which has no subscription, gates nothing on it.
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest, subscription: _NoSubscription()));
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
    expect(find.byType(HostedStartScreen), findsNothing);
    expect(model(tester).relay.state, 'ready', reason: shown(tester));

    // A computer added: its session in the list, as its own name says.
    final computer = (await tester.runAsync(() => TsComputer.start(relay.origin)))!;
    addTearDown(computer.kill);
    await tester.runAsync(() => addComputer(store, prefs, computer));
    await tester.runAsync(() => computer.until((l) => l == 'status ready'));
    await until(tester, () => model(tester).sessions.any((s) => s.name == 'fix the build'));
    expect(model(tester).sessions.map((s) => s.name), contains('fix the build'), reason: shown(tester));

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !ready);

  testWidgets('a relay of one\'s own from the first screen, and back', (tester) async {
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false, hosted: 'ws://127.0.0.1:1', attest: testAttest));
    await tester.pump();
    await tester.tap(find.text('I run my own relay'));
    await tester.pumpAndSettle();
    expect(find.byType(JoinScreen), findsOneWidget);
    expect(find.byType(HostedStartScreen), findsNothing);
  });

  testWidgets('a build without the hosted relay never shows its screen', (tester) async {
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false));
    await tester.pump();
    expect(find.byType(HostedStartScreen), findsNothing);
    expect(find.byType(JoinScreen), findsOneWidget);
  });

  group('setup', () {
    test('a refused sign-up keeps no key and no account', () async {
      final store = MemoryKeyStore();
      final prefs = MemoryPrefs();
      await expectLater(
        signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: (o, n, k) async => Attestation(), protect: false),
        throwsA(isA<SignUpFailed>()),
      );
      expect(await store.load(hostedRelayKey(relay.origin), KeyKind.main), isNull);
      expect(await store.load(hostedRelayKey(relay.origin), KeyKind.read), isNull);
      expect(await HostedAccount.load(e2e, prefs), isNull);
    });

    test('a sign-up answered with another account is refused, and keeps nothing', () async {
      // A relay that logs anyone in and answers every sign-up with an
      // account of its own choosing.
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((req) async {
        final ws = await WebSocketTransformer.upgrade(req);
        ws.listen((m) {
          final f = Frame.fromBuffer(m as List<int>);
          if (f.hasHello()) ws.add(Frame(challenge: Challenge(nonce: List.filled(32, 1))).writeToBuffer());
          if (f.hasAuth()) ws.add(Frame(welcome: Welcome(maxFrameBytes: 1 << 20)).writeToBuffer());
          if (f.hasSignUp()) ws.add(Frame(signedUp: SignedUp(requestId: f.signUp.requestId, accountId: List.filled(32, 9))).writeToBuffer());
        });
      });
      final origin = 'ws://127.0.0.1:${server.port}';
      final store = MemoryKeyStore();
      final prefs = MemoryPrefs();
      await expectLater(
        signUp(e2e: e2e, store: store, values: prefs, origin: origin, attest: testAttest, protect: false),
        throwsA(isA<SignUpFailed>().having((e) => e.message, 'message', contains('another account'))),
      );
      expect(await store.load(hostedRelayKey(origin), KeyKind.main), isNull);
      expect(await HostedAccount.load(e2e, prefs), isNull);
    });

    test('an account opened only with its own keys', () async {
      final store = MemoryKeyStore();
      final prefs = MemoryPrefs();
      final open = await signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: true);
      open.dispose();
      final relayKey = hostedRelayKey(relay.origin);
      final again = (await openAccount(e2e: e2e, store: store, values: prefs, relay: relayKey))!;
      expect(again.account.isPhone, isTrue);
      expect(store.protected(relayKey), isTrue);
      again.dispose();
      // Another seed under the key: refused, not taken for the account.
      await store.store(relayKey, KeyKind.main, Uint8List(32), protect: false);
      await expectLater(openAccount(e2e: e2e, store: store, values: prefs, relay: relayKey), throwsA(isA<AccountUnreadable>()));
      // No seed at all: no account to open.
      await store.delete(relayKey);
      expect(await openAccount(e2e: e2e, store: store, values: prefs, relay: relayKey), isNull);
    });

    test('a second phone joins by its code, and keeps the account as a client', () async {
      final store1 = MemoryKeyStore();
      final prefs1 = MemoryPrefs();
      (await signUp(e2e: e2e, store: store1, values: prefs1, origin: relay.origin, attest: testAttest, protect: false)).dispose();
      await prefs1.setRelay(hostedRelayKey(relay.origin));
      final first = (await openAccount(e2e: e2e, store: store1, values: prefs1, relay: hostedRelayKey(relay.origin)))!;

      final store2 = MemoryKeyStore();
      final prefs2 = MemoryPrefs();
      final j = await JoiningPhone.start(e2e: e2e, store: store2, values: prefs2, origin: relay.origin, attest: testAttest, protect: false);
      // Nothing kept before the join ends.
      expect(await store2.load(hostedRelayKey(relay.origin), KeyKind.main), isNull);

      final a = first.account;
      final link = await HostedLink.connect(origin: a.origin, publicKey: first.main.signing.publicKey, sign: (m) async => first.main.sign(m), accountId: a.accountId);
      final add = AddDevice(
        e2e: e2e,
        account: PhoneAccount(accountId: a.accountId, phone: a.self, signing: first.main.signing, channel: first.main.channel.secretKey, first: a.first, newest: a.newest.bytes, name: 'Pixel 9', counter: MemoryCounter().next),
        frames: link.frames.asBroadcastStream(),
        send: link.send,
      );
      Offered? offered;
      for (var i = 0; offered == null; i++) {
        try {
          offered = await add.start(j.text);
        } on JoinFailed catch (e) {
          if (!e.message.startsWith('no device shows') || i > 20) rethrow;
          await Future<void>.delayed(const Duration(milliseconds: 150));
        }
      }
      expect(offered.isPhone, isTrue);
      await add.confirm();
      final second = await j.done;
      expect((await j.joined).phoneName, 'Pixel 9');
      expect(second.account.isPhone, isFalse);
      expect(second.account.listed, isTrue);
      expect(second.account.accountId, a.accountId);
      expect(await store2.load(hostedRelayKey(relay.origin), KeyKind.main), isNotNull);
      second.dispose();
      first.dispose();
      await link.close();
    });

    test('a join cancelled keeps no key', () async {
      final store = MemoryKeyStore();
      final j = await JoiningPhone.start(e2e: e2e, store: store, values: MemoryPrefs(), origin: relay.origin, attest: testAttest, protect: false);
      j.cancel();
      await expectLater(j.done, throwsA(isA<JoinFailed>()));
      expect(await store.load(hostedRelayKey(relay.origin), KeyKind.main), isNull);
    });
  }, skip: !ready);
}
