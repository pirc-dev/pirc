// A hosted account made, joined and opened (lib/hosted/setup.dart), and
// the app on it, against the Go relay in its hosted mode: signing up from
// the first screen, the app opened again on the kept account, a computer's
// session in its list (extension/test/hosted-computer.ts), and a second
// phone joining. A failed sign-up or join keeps no key.
import 'dart:async';
import 'dart:io';

import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/links.dart';
import 'package:pirc/app/model.dart';
import 'package:pirc/app/store.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha1/common.pb.dart' as common;
import 'package:pirc/gen/pirc/v1alpha1/common.pbenum.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart';
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/ui/hosted_join_screens.dart' show ShowCodeScreen;
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
    await tester.tap(find.text('Back'));
    await tester.pumpAndSettle();
    expect(find.byType(HostedStartScreen), findsOneWidget);
  });

  // Signed up in the app, connected; with links from outside when given.
  Future<(MemoryKeyStore, MemoryPrefs)> signedUp(WidgetTester tester, {LinkPlatform? links, Duration? hold, bool protect = false}) async {
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs();
    if (hold != null) await tester.runAsync(() => prefs.setHold(hold));
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: protect, hosted: relay.origin, attest: testAttest, links: links));
    await tester.pump();
    await tester.tap(find.text('Sign up'));
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
    expect(model(tester).relay.state, 'ready', reason: shown(tester));
    return (store, prefs);
  }

  testWidgets('a join link while on a hosted account: said already added, and the account kept', (tester) async {
    const channel = MethodChannel('dev.pirc.app/links');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => null);
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
    final (store, prefs) = await signedUp(tester, links: LinkPlatform());
    final link = 'pirc://join?relay=${Uri.encodeComponent('ws://127.0.0.1:9')}&token=t';
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(channel.name, channel.codec.encodeMethodCall(MethodCall('opened', link)), (_) {});
    await tester.pumpAndSettle();
    expect(find.text('This phone is already added'), findsOneWidget, reason: shown(tester));
    expect(find.textContaining('Leave'), findsNothing);
    await tester.tap(find.text('OK'));
    await tester.pumpAndSettle();
    final relayKey = hostedRelayKey(relay.origin);
    expect(await tester.runAsync(() => store.load(relayKey, KeyKind.main)), isNotNull);
    expect(await tester.runAsync(() => HostedAccount.load(e2e, prefs)), isNotNull);
    // Nor does Settings offer to leave, or to move, a relay.
    await tester.tap(find.bySemanticsLabel('Settings'));
    await tester.pumpAndSettle();
    expect(find.text('Leave this relay'), findsNothing);
    expect(find.text('Change address'), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !ready);

  testWidgets('a join link opened at the hosted first screen: the join screen of a relay of one\'s own, with it filled in', (tester) async {
    const channel = MethodChannel('dev.pirc.app/links');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => null);
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false, hosted: 'ws://127.0.0.1:1', attest: testAttest, links: LinkPlatform()));
    await tester.pumpAndSettle();
    expect(find.byType(HostedStartScreen), findsOneWidget);
    final link = 'pirc://join?relay=${Uri.encodeComponent('ws://127.0.0.1:9')}&token=t';
    await tester.binding.defaultBinaryMessenger.handlePlatformMessage(channel.name, channel.codec.encodeMethodCall(MethodCall('opened', link)), (_) {});
    await tester.pumpAndSettle();
    expect(find.byType(JoinScreen), findsOneWidget);
    expect(tester.widget<CupertinoTextField>(find.byType(CupertinoTextField)).controller!.text, link);
  });

  testWidgets('locked again after time away: the account opened and connected anew', (tester) async {
    // The lock on, as on a phone: the main seed asked for again.
    final (store, _) = await signedUp(tester, hold: Duration.zero, protect: true);
    final before = model(tester);
    final asked = store.asked;
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && !identical(model(tester), before) && model(tester).relay.state == 'ready');
    expect(identical(model(tester), before), isFalse);
    expect(store.asked, greaterThan(asked));
    expect(model(tester).relay.state, 'ready');

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !ready);

  testWidgets('in the background the connection stops; back in front it connects again', (tester) async {
    await signedUp(tester);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await until(tester, () => model(tester).relay.state == 'stopped');
    expect(model(tester).relay.state, 'stopped');
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await until(tester, () => model(tester).relay.state == 'ready');
    expect(model(tester).relay.state, 'ready');

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !ready);

  testWidgets('a second phone joined from the first screen, then taken off the account: said, then its keys and account gone', (tester) async {
    final store1 = MemoryKeyStore();
    final prefs1 = MemoryPrefs();
    final first = (await tester.runAsync(() async {
      (await signUp(e2e: e2e, store: store1, values: prefs1, origin: relay.origin, attest: testAttest, protect: false)).dispose();
      return openAccount(e2e: e2e, store: store1, values: prefs1, relay: hostedRelayKey(relay.origin));
    }))!;
    addTearDown(first.dispose);
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs();
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest));
    await tester.pump();
    await tester.tap(find.text('My account is on another phone'));
    await until(tester, () => find.byType(ShowCodeScreen).evaluate().isNotEmpty);
    final text = tester.widget<ShowCodeScreen>(find.byType(ShowCodeScreen)).text;

    // The account's phone adds it.
    final a = first.account;
    final link = (await tester.runAsync(() => HostedLink.connect(origin: a.origin, publicKey: first.main.signing.publicKey, sign: (m) async => first.main.sign(m), accountId: a.accountId)))!;
    addTearDown(link.close);
    final frames = link.frames.asBroadcastStream();
    PhoneAccount phone() => PhoneAccount(accountId: a.accountId, phone: a.self, signing: first.main.signing, channel: first.main.channel.secretKey, first: a.first, newest: a.newest.bytes, name: 'Pixel 9', counter: MemoryCounter().next);
    // Started in real time and left running, while the app is pumped:
    // its side of the join answers in the app's own time.
    Object? addFailed;
    var added = false;
    await tester.runAsync(() async {
      unawaited(() async {
        final add = AddDevice(e2e: e2e, account: phone(), frames: frames, send: link.send);
        await add.start(text);
        await a.take(await add.confirm());
        added = true;
      }().catchError((Object e) {
        addFailed = e;
      }));
    });
    await until(tester, () => added || addFailed != null);
    expect(addFailed, isNull);
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
    expect(model(tester).relay.state, 'ready', reason: shown(tester));
    final relayKey = hostedRelayKey(relay.origin);
    expect(await tester.runAsync(() => store.load(relayKey, KeyKind.main)), isNotNull);

    // Taken off: a version of the phone alone.
    await tester.runAsync(() async {
      final body = Uint8List.sublistView(a.newest.bytes, signatureBytes);
      final next = e2e.makeList(phone: first.main.signing, devices: [a.self], previousBody: body, accountId: a.accountId, counter: a.newest.counter + 1);
      link.send(Frame(publishList: PublishList(requestId: 'rm', list: next)));
      await frames.firstWhere((f) => f.hasDone() || f.hasError()).timeout(const Duration(seconds: 10));
    });
    await until(tester, () => find.text('Removed from the account').evaluate().isNotEmpty);
    expect(find.text('Removed from the account'), findsOneWidget, reason: shown(tester));
    await tester.tap(find.text('OK'));
    await until(tester, () => find.byType(HostedStartScreen).evaluate().isNotEmpty);
    expect(find.byType(HostedStartScreen), findsOneWidget, reason: shown(tester));
    expect(await tester.runAsync(() => store.load(relayKey, KeyKind.main)), isNull);
    expect(await tester.runAsync(() => store.load(relayKey, KeyKind.read)), isNull);
    expect(await tester.runAsync(() => prefs.get(accountKey)), isNull);
    expect(await tester.runAsync(prefs.relay), isNull);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !ready);

  testWidgets('an account kept whose keys are gone: forgotten, and the phone may sign up again', (tester) async {
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs();
    (await tester.runAsync(() => signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false)))!.dispose();
    await tester.runAsync(() => prefs.setRelay(hostedRelayKey(relay.origin)));
    // As on a phone the backup was restored to: the prefs, not the keys.
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest));
    await until(tester, () => find.byType(HostedStartScreen).evaluate().isNotEmpty);
    expect(find.byType(HostedStartScreen), findsOneWidget, reason: shown(tester));
    expect(await tester.runAsync(() => prefs.get(accountKey)), isNull);
    await tester.tap(find.text('Sign up'));
    await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
    expect(model(tester).relay.state, 'ready', reason: shown(tester));

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  }, skip: !ready);

  testWidgets('an account kept that cannot be read: said, and this phone may start again', (tester) async {
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs(hostedRelayKey('ws://127.0.0.1:1'));
    await prefs.set(accountKey, '{"origin":"ws://127.0.0.1:1"}');
    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false, hosted: 'ws://127.0.0.1:1', attest: testAttest));
    await until(tester, () => find.text('Start again on this phone').evaluate().isNotEmpty, tries: 30);
    expect(find.textContaining('cannot be read'), findsOneWidget, reason: shown(tester));
    await tester.tap(find.text('Start again on this phone'));
    await tester.pumpAndSettle();
    // Asked first; cancelled, nothing goes.
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(await tester.runAsync(() => prefs.get(accountKey)), isNotNull);
    await tester.tap(find.text('Start again on this phone'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Start again'));
    await until(tester, () => find.byType(HostedStartScreen).evaluate().isNotEmpty, tries: 30);
    expect(find.byType(HostedStartScreen), findsOneWidget, reason: shown(tester));
    expect(await tester.runAsync(() => prefs.get(accountKey)), isNull);
  });

  testWidgets('a build without the hosted relay never shows its screen', (tester) async {
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false));
    await tester.pump();
    expect(find.byType(HostedStartScreen), findsNothing);
    expect(find.byType(JoinScreen), findsOneWidget);
  });

  group('setup', () {
    test('the attestation is asked for the login\'s nonce and the key that signs up or joins', () async {
      final asked = <(Uint8List, Uint8List)>[];
      Future<Attestation> recording(String o, Uint8List nonce, Uint8List key) async {
        asked.add((nonce, key));
        return Attestation(test: [1]);
      }

      final open = await signUp(e2e: e2e, store: MemoryKeyStore(), values: MemoryPrefs(), origin: relay.origin, attest: recording, protect: false);
      expect(asked.single.$1.length, 32);
      expect(asked.single.$2, open.account.phoneKey);
      open.dispose();
      final j = await JoiningPhone.start(e2e: e2e, store: MemoryKeyStore(), values: MemoryPrefs(), origin: relay.origin, attest: recording, protect: false);
      expect(asked.last.$1.length, 32);
      expect(asked.last.$1, isNot(asked.first.$1));
      expect(asked.last.$2, isNot(asked.first.$2));
      j.cancel();
      await expectLater(j.done, throwsA(isA<JoinFailed>()));
    });

    test('one account to a phone: a second sign-up or join is refused before anything is kept', () async {
      final store = MemoryKeyStore();
      final prefs = MemoryPrefs();
      (await signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false)).dispose();
      final seed = await store.load(hostedRelayKey(relay.origin), KeyKind.main);
      await expectLater(signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false), throwsA(isA<SignUpFailed>()));
      await expectLater(JoiningPhone.start(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false), throwsA(isA<JoinFailed>()));
      expect(await store.load(hostedRelayKey(relay.origin), KeyKind.main), seed);
    });

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

    test('a connection dropped during the login is tried again; a refused login is not', () async {
      var logins = 0;
      var refuse = false;
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((req) async {
        final ws = await WebSocketTransformer.upgrade(req);
        logins++;
        ws.listen((m) {
          if (refuse) {
            ws.add(Frame(error: common.Error(code: ErrorCode.ERROR_CODE_PERMISSION_DENIED, message: 'no')).writeToBuffer());
          } else {
            ws.close();
          }
        });
      });
      final origin = 'ws://127.0.0.1:${server.port}';
      await expectLater(signUp(e2e: e2e, store: MemoryKeyStore(), values: MemoryPrefs(), origin: origin, attest: testAttest, protect: false), throwsA(isA<SignUpFailed>()));
      expect(logins, signUpAttempts);
      logins = 0;
      refuse = true;
      await expectLater(
        signUp(e2e: e2e, store: MemoryKeyStore(), values: MemoryPrefs(), origin: origin, attest: testAttest, protect: false),
        throwsA(isA<SignUpFailed>().having((e) => e.message, 'message', contains('refused'))),
      );
      expect(logins, 1);
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
