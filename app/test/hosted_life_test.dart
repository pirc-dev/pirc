// A hosted account's life (ui/hosted_account_screens.dart and the app's
// part of it): who pays and until when, a purchase offered only when none
// carries the account on, the other platform's store never named for
// nothing, the locked account's screen, the China mainland storefront
// (no hosted relay offered), the purchase before a sign-up, and, against
// the Go relay, a renewal taken and the account deleted from Settings.
import 'dart:async';
import 'dart:io';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/hosted_devices.dart' show AppHostedAccount;
import 'package:pirc/app/model.dart';
import 'package:pirc/app/store.dart';
import 'package:pirc/core/view.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/connection.dart';
import 'package:pirc/hosted/keys.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/sessions.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/ui/hosted_account_screens.dart';
import 'package:pirc/ui/hosted_start_screen.dart';
import 'package:pirc/ui/join_screen.dart';
import 'package:pirc/ui/look.dart';
import 'package:pirc/ui/sessions_screen.dart';

import 'support/relay.dart';
import 'support/ts_computer.dart';

Future<v2.Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => v2.Attestation(test: [1]);

Timestamp _at(DateTime d) => Timestamp(seconds: Int64(d.millisecondsSinceEpoch ~/ 1000));

class _Controls implements HostedAccountControls {
  _Controls({this.subscriptions = const [], this.isPhone = true});
  @override
  final List<v2.AccountSubscription> subscriptions;
  @override
  final bool isPhone;
  @override
  String? get storeName => 'the App Store';
  var renewed = 0;
  var deleted = 0;
  @override
  Future<String?> renew() async {
    renewed++;
    return null;
  }

  @override
  Future<String?> deleteAccount() async {
    deleted++;
    return null;
  }
}

// A store whose purchase answers as set.
class _Store implements Store {
  _Store(this.bought);
  Bought bought;
  var buys = 0;
  @override
  Stream<void> get changed => const Stream.empty();
  @override
  Future<StoreStatus> status() async => const StoreStatus(Access.never);
  @override
  Future<StoreProduct?> product() async => null;
  @override
  Future<Bought> buy() async {
    buys++;
    return bought;
  }

  @override
  Future<void> restore() async {}
  @override
  Future<void> manage() async {}
}

Widget _page(Widget child) => LookScope(look: Look.light, child: CupertinoApp(home: CupertinoPageScaffold(child: child)));

String _all(WidgetTester tester) => tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? t.textSpan?.toPlainText() ?? '').join(' | ');

void main() {
  final now = DateTime.utc(2027, 3, 1);

  group('who pays', () {
    test('each subscription said, live or ended, by its store', () {
      final subs = [
        v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_GOOGLE_PLAY, ends: _at(DateTime.utc(2027, 12, 12)), renews: true),
        v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_APP_STORE, ends: _at(DateTime.utc(2027, 1, 2)), lapsed: true),
        v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_APP_STORE, ends: _at(DateTime.utc(2027, 3, 5)), trial: true),
      ];
      expect(subscriptionLines(subs, now), [
        'Paid through Google Play until 12 Dec 2027, renewing',
        'Ended through the App Store on 2 Jan 2027',
        'Free trial through the App Store until 5 Mar 2027',
      ]);
    });

    test('a purchase only when none carries the account on', () {
      final renewing = v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_APP_STORE, ends: _at(DateTime.utc(2027, 3, 3)), renews: true);
      final ending = v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_APP_STORE, ends: _at(DateTime.utc(2027, 3, 3)));
      final later = v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_GOOGLE_PLAY, ends: _at(DateTime.utc(2027, 6, 1)));
      final gone = v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_APP_STORE, ends: _at(DateTime.utc(2027, 2, 1)));
      expect(offerPurchase([], now), isTrue);
      expect(offerPurchase([gone], now), isTrue);
      expect(offerPurchase([renewing], now), isFalse);
      // Within a week and not renewing: offered, so that it does not lapse.
      expect(offerPurchase([ending], now), isTrue);
      expect(offerPurchase([ending, later], now), isFalse);
      // Lapsed is over, whatever end the store gave.
      final lapsed = v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_APP_STORE, ends: _at(DateTime.utc(2027, 9, 1)), renews: true, lapsed: true);
      expect(offerPurchase([lapsed], now), isTrue);
      expect(subscriptionLines([lapsed], now), ['Ended through the App Store on 1 Sep 2027']);
    });

    testWidgets('a new account reads nothing of the other platform\'s store', (tester) async {
      await tester.pumpWidget(_page(ListView(children: [HostedAccountRows(controls: _Controls(), now: () => now)])));
      expect(_all(tester), isNot(contains('Google Play')));
      expect(find.text('Subscribe through the App Store'), findsOneWidget);
      await tester.pumpWidget(_page(LockedAccountScreen(controls: _Controls(), now: () => now)));
      expect(_all(tester), isNot(contains('Google Play')));
    });
  });

  group('the locked account', () {
    testWidgets('renewed through this phone\'s store, or deleted from the account\'s phone once confirmed', (tester) async {
      final c = _Controls(subscriptions: [v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_APP_STORE, ends: _at(DateTime.utc(2027, 2, 1)), lapsed: true)]);
      await tester.pumpWidget(_page(LockedAccountScreen(controls: c, now: () => now)));
      expect(find.text('This account is locked'), findsOneWidget);
      expect(find.text('Ended through the App Store on 1 Feb 2027'), findsOneWidget);
      await tester.tap(find.text('Renew through the App Store'));
      await tester.pumpAndSettle();
      expect(c.renewed, 1);
      await tester.tap(find.text('Delete this account'));
      await tester.pumpAndSettle();
      expect(find.textContaining('It does not cancel your subscription: cancel it in the App Store.'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(c.deleted, 0);
      await tester.tap(find.text('Delete this account'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await tester.pumpAndSettle();
      expect(c.deleted, 1);
    });

    testWidgets('another phone renews, and cannot delete', (tester) async {
      await tester.pumpWidget(_page(LockedAccountScreen(controls: _Controls(isPhone: false), now: () => now)));
      expect(find.text('Delete this account'), findsNothing);
      expect(find.text('Renew through the App Store'), findsOneWidget);
    });

    test('a locked login is said, and the sessions not asked for', () async {
      final e2e = await E2e.load();
      final main = MainKeys.fromSeed(e2e.sodium, e2e.sodium.randombytes.buf(32));
      final read = ReadKeys.fromSeed(e2e.sodium, e2e.sodium.randombytes.buf(32));
      final self = phoneDevice(main, read);
      final first = e2e.makeList(phone: main.signing, devices: [self], counter: Int64.ONE);
      final account = await HostedAccount.create(e2e, MemoryValues(),
          origin: 'wss://relay.test', accountId: e2e.sha256(first.sublist(signatureBytes)), phoneKey: main.signing.publicKey, self: self, first: first, newest: first);
      final states = <RelayView>[];
      v2.Welcome? welcomed;
      final s = HostedSessions(e2e: e2e, account: account, main: main, sendRelay: (_) => true, toClient: (_) {}, relayState: states.add, onWelcome: (w) => welcomed = w);
      addTearDown(s.dispose);
      s.onState(HostedReady(v2.Welcome(maxFrameBytes: 1 << 20, listCounter: Int64.ONE, locked: true)));
      await Future<void>.delayed(Duration.zero);
      expect(welcomed?.locked, isTrue);
      expect(states.last.state, isNot('ready'));
    });
  });

  testWidgets('the app on a locked account: only the locked screen', (tester) async {
    final e2e = (await tester.runAsync(E2e.load))!;
    // A relay that makes any account, and says it is locked at every login
    // to one.
    final server = (await tester.runAsync(() => HttpServer.bind(InternetAddress.loopbackIPv4, 0)))!;
    addTearDown(() => server.close(force: true));
    server.listen((req) async {
      final ws = await WebSocketTransformer.upgrade(req);
      var account = false;
      ws.listen((m) {
        final f = v2.Frame.fromBuffer(m as List<int>);
        if (f.hasHello()) {
          account = f.hello.accountId.isNotEmpty;
          ws.add(v2.Frame(challenge: v2.Challenge(nonce: List.filled(32, 1))).writeToBuffer());
        }
        if (f.hasAuth()) ws.add(v2.Frame(welcome: v2.Welcome(maxFrameBytes: 1 << 20, listCounter: account ? Int64.ONE : null, locked: account)).writeToBuffer());
        if (f.hasSignUp()) ws.add(v2.Frame(signedUp: v2.SignedUp(requestId: f.signUp.requestId, accountId: e2e.sha256(f.signUp.list.sublist(signatureBytes)))).writeToBuffer());
      });
    });
    final origin = 'ws://127.0.0.1:${server.port}';
    await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false, hosted: origin, attest: testAttest, storefront: () async => null));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign up'));
    for (var i = 0; i < 100 && find.byType(LockedAccountScreen).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump(const Duration(milliseconds: 50));
    }
    expect(find.byType(LockedAccountScreen), findsOneWidget, reason: _all(tester));
    expect(find.byType(SessionsScreen), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(minutes: 31));
  });

  group('China mainland', () {
    testWidgets('no hosted relay offered on its storefront, nor when the storefront does not answer', (tester) async {
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false, hosted: 'ws://127.0.0.1:1', attest: testAttest, storefront: () async => 'CHN'));
      await tester.pumpAndSettle();
      expect(find.byType(HostedStartScreen), findsNothing);
      expect(find.byType(JoinScreen), findsOneWidget);
      expect(find.text('Back'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false, hosted: 'ws://127.0.0.1:1', attest: testAttest, storefront: () => Completer<String?>().future));
      await tester.pump(const Duration(seconds: 4));
      await tester.pumpAndSettle();
      expect(find.byType(HostedStartScreen), findsNothing);
    });

    testWidgets('offered elsewhere', (tester) async {
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false, hosted: 'ws://127.0.0.1:1', attest: testAttest, storefront: () async => 'GBR'));
      await tester.pumpAndSettle();
      expect(find.byType(HostedStartScreen), findsOneWidget);
    });
  });

  group('against the relay', () {
    final ready = hasGo && hasNode;
    late Directory dir;
    late HostedRelay relay;
    late E2e e2e;
    setUpAll(() async {
      if (!ready) return;
      e2e = await E2e.load();
      dir = await Directory.systemTemp.createTemp('pirc-hosted-life-');
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

    PircModel model(WidgetTester tester) => tester.widget<SessionsScreen>(find.byType(SessionsScreen, skipOffstage: false)).model;

    Future<(MemoryKeyStore, MemoryPrefs)> signedUp(WidgetTester tester, {Store? store, Future<String?> Function()? proof}) async {
      tester.view.physicalSize = const Size(1170, 4000);
      addTearDown(tester.view.reset);
      final keys = MemoryKeyStore();
      final prefs = MemoryPrefs();
      await tester.pumpWidget(PircApp(store: keys, prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest, subscription: store, storefront: () async => null, proof: proof ?? () async => null));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign up'));
      await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
      expect(model(tester).relay.state, 'ready', reason: _all(tester));
      return (keys, prefs);
    }

    testWidgets('a sign-up starts the store\'s purchase first; given up, no account is made', (tester) async {
      final store = _Store(Bought.cancelled);
      final prefs = MemoryPrefs();
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest, subscription: store, storefront: () async => null));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign up'));
      await until(tester, () => find.textContaining('no account was made').evaluate().isNotEmpty);
      expect(find.textContaining('no account was made'), findsOneWidget, reason: _all(tester));
      expect(store.buys, 1);
      expect(await tester.runAsync(() => prefs.get(accountKey)), isNull);

      store.bought = Bought.bought;
      await tester.tap(find.text('Sign up'));
      await until(tester, () => find.byType(SessionsScreen).evaluate().isNotEmpty && model(tester).relay.state == 'ready');
      expect(store.buys, 2);
      expect(model(tester).relay.state, 'ready', reason: _all(tester));

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    }, skip: !ready);

    testWidgets('Settings says who pays, and offers no purchase while one renews', (tester) async {
      await signedUp(tester, store: _Store(Bought.bought));
      await tester.tap(find.bySemanticsLabel('Settings'));
      await tester.pumpAndSettle();
      // The test relay's own subscription, which every sign-up there has.
      expect(find.text('Paid through the test store, renewing'), findsOneWidget, reason: _all(tester));
      expect(find.text('Subscribe through the App Store'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    }, skip: !ready);

    test('renewed through the store: bought if this phone has none, then the relay takes the proof', () async {
      final keys = MemoryKeyStore();
      final prefs = MemoryPrefs();
      final open = await signUp(e2e: e2e, store: keys, values: prefs, origin: relay.origin, attest: testAttest, protect: false);
      final run = HostedRun(e2e: e2e, open: open, toClient: (_) {}, relayState: (_) {});
      addTearDown(run.dispose);
      run.start();
      for (var i = 0; i < 100 && run.conn.current is! HostedReady; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      String? had;
      final store = _Store(Bought.bought);
      final a = AppHostedAccount(run: run, store: store, storeName: 'the App Store', subscriptionsOf: () => const [], proof: () async => had, deleted: () async {});
      // None on this phone: bought, then still none to prove.
      expect(await a.renew(), contains('no subscription'));
      expect(store.buys, 1);
      had = 'a proof';
      expect(await a.renew(), isNull);
      // Had already: not bought again.
      expect(store.buys, 1);
      store.bought = Bought.cancelled;
      had = null;
      expect(await a.renew(), 'Not bought.');
    }, skip: !ready);

    testWidgets('deleted from Settings, confirmed: the relay forgets it, and this phone is back at the first screen', (tester) async {
      final (keys, prefs) = await signedUp(tester);
      final relayKey = hostedRelayKey(relay.origin);
      final open = (await tester.runAsync(() => openAccount(e2e: e2e, store: keys, values: prefs, relay: relayKey)))!;
      final signing = open.main.signing;
      final accountId = open.account.accountId;
      await tester.tap(find.bySemanticsLabel('Settings'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete this account'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await until(tester, () => find.byType(HostedStartScreen).evaluate().isNotEmpty);
      expect(find.byType(HostedStartScreen), findsOneWidget, reason: _all(tester));
      expect(await tester.runAsync(() => keys.load(relayKey, KeyKind.main)), isNull);
      expect(await tester.runAsync(() => prefs.get(accountKey)), isNull);
      // The relay no longer has it.
      Object? refused;
      await tester.runAsync(() async {
        try {
          await (await HostedLink.connect(origin: relay.origin, publicKey: signing.publicKey, sign: (m) async => e2e.sodium.crypto.sign.detached(message: m, secretKey: signing.secretKey), accountId: accountId)).close();
        } on LinkError catch (e) {
          refused = e;
        }
      });
      open.dispose();
      expect(refused, isA<LinkError>());

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    }, skip: !ready);
  });
}
