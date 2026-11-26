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
import 'package:pirc/app/hosted_devices.dart' show AppHostedAccount, deletingKey;
import 'package:pirc/gen/pirc/v1alpha1/common.pb.dart' as common;
import 'package:pirc/gen/pirc/v1alpha1/common.pbenum.dart';
import 'package:pirc/hosted/attest.dart' show unknownStorefront;
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
  var bought = 0;
  var deleted = 0;
  Object? throws;
  @override
  Future<String?> renew({bool buy = false}) async {
    renewed++;
    if (buy) bought++;
    if (throws != null) throw throws!;
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

    test('review access: until when, and ended once a subscription carried the account on', () {
      final review = v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_REVIEW, ends: _at(DateTime.utc(2027, 3, 20)));
      final ended = v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_REVIEW, ends: _at(DateTime.utc(2027, 2, 20)), lapsed: true);
      expect(subscriptionLines([review], now), ["Review access until 20 Mar 2027, for the stores' reviewers: the account is deleted then, unless a subscription carries it on"]);
      expect(subscriptionLines([ended], now), ['Review access ended on 20 Feb 2027']);
      expect(storesOf([review], now), isEmpty);
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
      // Its one subscription has lapsed: no store to cancel in.
      expect(find.textContaining('This cannot be undone.'), findsOneWidget);
      expect(find.textContaining('keep the deleted account for up to ten weeks'), findsOneWidget);
      expect(find.textContaining('cancel it in'), findsNothing);
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

  group('with a stand-in relay', () {
    late E2e e2e;
    setUpAll(() async => e2e = await E2e.load());

    Future<void> until(WidgetTester tester, bool Function() done, {int tries = 200}) async {
      for (var i = 0; i < tries && !done(); i++) {
        await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
        await tester.pump(const Duration(milliseconds: 50));
      }
    }

    Future<(_StandIn, MemoryKeyStore, MemoryPrefs)> signedUp(WidgetTester tester, {bool locked = false}) async {
      tester.view.physicalSize = const Size(1170, 4000);
      addTearDown(tester.view.reset);
      final relay = (await tester.runAsync(() => _StandIn.start(e2e)))!;
      addTearDown(relay.stop);
      relay.locked = locked;
      final keys = MemoryKeyStore();
      final prefs = MemoryPrefs();
      await tester.pumpWidget(PircApp(store: keys, prefs: prefs, protect: false, hosted: relay.origin, attest: testAttest, storefront: () async => null, subscription: _Store(Bought.bought), proof: () async => 'a proof'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Sign up'));
      await until(tester, () => find.byType(LockedAccountScreen).evaluate().isNotEmpty || (find.byType(SessionsScreen).evaluate().isNotEmpty && find.textContaining('Connecting').evaluate().isEmpty));
      return (relay, keys, prefs);
    }

    testWidgets('locked: only its screen; renewed, the relay closes, and the phone logs in again unlocked', (tester) async {
      final (relay, _, _) = await signedUp(tester, locked: true);
      expect(find.byType(LockedAccountScreen), findsOneWidget, reason: _all(tester));
      expect(find.byType(SessionsScreen), findsNothing);
      await tester.tap(find.text('Renew through Google Play'));
      await until(tester, () => find.byType(LockedAccountScreen).evaluate().isEmpty);
      expect(find.byType(LockedAccountScreen), findsNothing, reason: _all(tester));
      expect(find.byType(SessionsScreen), findsOneWidget);
      expect(relay.renewals, ['a proof']);

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    });

    testWidgets('locked while Settings is open: the locked screen comes over it', (tester) async {
      final (relay, _, _) = await signedUp(tester);
      await tester.tap(find.bySemanticsLabel('Settings'));
      await tester.pumpAndSettle();
      relay.locked = true;
      relay.dropAll();
      await until(tester, () => find.byType(LockedAccountScreen).evaluate().isNotEmpty);
      // Settings' page gone, its animation done.
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(find.byType(LockedAccountScreen), findsOneWidget, reason: _all(tester));
      expect(find.text('ACCOUNT'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    });

    testWidgets('deleted, and the answer lost: recorded, and finished once the relay refuses the login', (tester) async {
      final (relay, keys, prefs) = await signedUp(tester);
      relay.answerDelete = false;
      await tester.tap(find.bySemanticsLabel('Settings'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete this account'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Delete'));
      await until(tester, () => find.byType(HostedStartScreen).evaluate().isNotEmpty);
      expect(find.byType(HostedStartScreen), findsOneWidget, reason: _all(tester));
      final relayKey = hostedRelayKey(relay.origin);
      expect(await tester.runAsync(() => keys.load(relayKey, KeyKind.main)), isNull);
      expect(await tester.runAsync(() => prefs.get(accountKey)), isNull);
      expect(await tester.runAsync(() => prefs.get(deletingKey)), isNull);

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(minutes: 31));
    });
  });

  testWidgets('a renewal that fails says so and can be tried again', (tester) async {
    final c = _Controls()..throws = PlatformException(code: 'network');
    await tester.pumpWidget(_page(LockedAccountScreen(controls: c, now: () => now)));
    await tester.tap(find.text('Renew through the App Store'));
    await tester.pumpAndSettle();
    expect(find.textContaining('network'), findsOneWidget);
    expect(find.byType(CupertinoActivityIndicator), findsNothing);
    expect(find.text('Renew through the App Store'), findsOneWidget);
  });

  testWidgets('deleting names the stores of the account\'s own subscriptions, none else', (tester) async {
    final play = v2.AccountSubscription(store: v2.SubscriptionStore.SUBSCRIPTION_STORE_GOOGLE_PLAY, ends: _at(DateTime.utc(2027, 12, 1)), renews: true);
    await tester.pumpWidget(_page(ListView(children: [HostedAccountRows(controls: _Controls(subscriptions: [play]), now: () => now)])));
    await tester.tap(find.text('Delete this account'));
    await tester.pumpAndSettle();
    expect(find.textContaining('cancel it in Google Play.'), findsOneWidget);
    expect(find.textContaining('App Store'), findsNothing);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(_page(ListView(children: [HostedAccountRows(controls: _Controls(), now: () => now)])));
    await tester.tap(find.text('Delete this account'));
    await tester.pumpAndSettle();
    expect(find.textContaining('cancel it in'), findsNothing);
  });

  testWidgets('Subscribe in Settings always buys', (tester) async {
    final c = _Controls();
    await tester.pumpWidget(_page(ListView(children: [HostedAccountRows(controls: c, now: () => now)])));
    await tester.tap(find.text('Subscribe through the App Store'));
    await tester.pumpAndSettle();
    expect(c.bought, 1);
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

    testWidgets('nor when the storefront is unknown', (tester) async {
      await tester.pumpWidget(PircApp(store: MemoryKeyStore(), prefs: MemoryPrefs(), protect: false, hosted: 'ws://127.0.0.1:1', attest: testAttest, storefront: () async => unknownStorefront));
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
      expect(find.textContaining('Subscribe through'), findsNothing);
      // Nothing of the other platform's store, nor of either as a choice.
      expect(_all(tester), isNot(contains('either store')));

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
      final a = AppHostedAccount(run: run, store: store, storeName: 'the App Store', subscriptionsOf: () => const [], proof: () async => had, deleted: () async {}, values: MemoryPrefs());
      // None on this phone: bought, then still none to prove.
      expect(await a.renew(), contains('no subscription'));
      expect(store.buys, 1);
      Future<void> readyAgain() async {
        await Future<void>.delayed(const Duration(milliseconds: 50));
        for (var i = 0; i < 100 && run.conn.current is! HostedReady; i++) {
          await Future<void>.delayed(const Duration(milliseconds: 50));
        }
      }

      had = 'a proof';
      expect(await a.renew(), isNull);
      // Logged in again, to be told the subscriptions.
      await readyAgain();
      // Had already: not bought again, but when a purchase is what was asked.
      expect(store.buys, 1);
      expect(await a.renew(buy: true), isNull);
      expect(store.buys, 2);
      await readyAgain();
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

// A relay that makes any account and plays its life: locked or not, a
// renewal that unlocks it (Done, then the close "renewed"), a deletion
// answered or not, and every login refused once the account is deleted.
class _StandIn {
  _StandIn._(this._server, this.e2e);
  final HttpServer _server;
  final E2e e2e;
  var locked = false;
  var deleted = false;
  var answerDelete = true;
  final renewals = <String>[];
  final _sockets = <WebSocket>[];

  String get origin => 'ws://127.0.0.1:${_server.port}';

  static Future<_StandIn> start(E2e e2e) async {
    final r = _StandIn._(await HttpServer.bind(InternetAddress.loopbackIPv4, 0), e2e);
    r._server.listen(r._serve);
    return r;
  }

  void _send(WebSocket ws, v2.Frame f) => ws.add(f.writeToBuffer());

  Future<void> _serve(HttpRequest req) async {
    final ws = await WebSocketTransformer.upgrade(req);
    _sockets.add(ws);
    var account = false;
    ws.listen((m) {
      final f = v2.Frame.fromBuffer(m as List<int>);
      if (f.hasHello()) {
        account = f.hello.accountId.isNotEmpty;
        _send(ws, v2.Frame(challenge: v2.Challenge(nonce: List.filled(32, 1))));
      } else if (f.hasAuth()) {
        if (account && deleted) {
          _send(ws, v2.Frame(error: common.Error(code: ErrorCode.ERROR_CODE_UNAUTHENTICATED, message: 'key not a member of the account')));
          ws.close();
          return;
        }
        _send(ws, v2.Frame(welcome: v2.Welcome(maxFrameBytes: 1 << 20, listCounter: account ? Int64.ONE : null, locked: account && locked)));
      } else if (f.hasCheckInvite()) {
        _send(ws, v2.Frame(inviteChecked: v2.InviteChecked(requestId: f.checkInvite.requestId, mode: v2.SignUpMode.SIGN_UP_MODE_OPEN)));
      } else if (f.hasSignUp()) {
        _send(ws, v2.Frame(signedUp: v2.SignedUp(requestId: f.signUp.requestId, accountId: e2e.sha256(f.signUp.list.sublist(signatureBytes)))));
      } else if (f.hasRenewSubscription()) {
        final r = f.renewSubscription;
        renewals.add(r.hasGooglePlayToken() ? r.googlePlayToken : r.appStoreTransaction);
        _send(ws, v2.Frame(done: v2.Done(requestId: r.requestId)));
        if (locked) {
          locked = false;
          ws.close(1000, 'renewed');
        }
      } else if (f.hasDeleteAccount()) {
        deleted = true;
        if (answerDelete) _send(ws, v2.Frame(done: v2.Done(requestId: f.deleteAccount.requestId)));
        ws.close(1000, 'deleted');
      }
    });
  }

  /// Every connection closed, as the relay going away.
  void dropAll() {
    for (final ws in _sockets) {
      ws.close();
    }
    _sockets.clear();
  }

  Future<void> stop() async {
    dropAll();
    await _server.close(force: true);
  }
}
