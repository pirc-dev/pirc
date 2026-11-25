// A hosted account on a phone or simulator, with its own key store and
// prefs: signing up from the first screen against a relay with a test
// verifier, the account kept under its relay key, opened again, and the
// read-only wake. The relay's origin is given:
//
//   flutter test integration_test/hosted_test.dart -d <device> \
//     --dart-define=PIRC_HOSTED=true --dart-define=PIRC_TEST_ATTEST=true \
//     --dart-define=HOSTED_ORIGIN=ws://127.0.0.1:<port>
//
// with `pirc-relay serve-hosted --plaintext --test-attestation` on that
// port (the simulator reaches the Mac's loopback).
import 'dart:typed_data';

import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc/app/app.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart';
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/notices.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/ui/sessions_screen.dart';

const origin = String.fromEnvironment('HOSTED_ORIGIN');

Future<Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => Attestation(test: [1]);

String shown(WidgetTester tester) => tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? t.textSpan?.toPlainText() ?? '').join(' | ');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('signed up with the phone\'s own stores, opened again, woken with its read-only key', (tester) async {
    if (origin.isEmpty) {
      markTestSkipped('no HOSTED_ORIGIN given');
      return;
    }
    final store = ChannelKeyStore();
    final prefs = ChannelPrefs();
    final relayKey = hostedRelayKey(origin);
    // From a clean phone.
    await store.delete(relayKey);
    await prefs.set(accountKey, null);
    await prefs.setRelay(null);

    await tester.pumpWidget(PircApp(store: store, prefs: prefs, protect: false, hosted: origin, attest: testAttest, storefront: () async => null));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign up'));
    for (var i = 0; i < 150 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
    }
    expect(find.byType(SessionsScreen), findsOneWidget, reason: shown(tester));
    expect(await prefs.relay(), relayKey);
    expect(await store.load(relayKey, KeyKind.read), isNotNull);

    // The account, as the notification extension reads it from the shared
    // prefs, opens with the keys kept.
    final e2e = await E2e.load();
    final open = await openAccount(e2e: e2e, store: store, values: prefs, relay: relayKey);
    expect(open, isNotNull);
    open!.dispose();
    // A wake: nothing to show, and nothing refused.
    expect(await hostedNotes(e2e: e2e, values: prefs, store: store, relay: relayKey, now: DateTime.now().millisecondsSinceEpoch), isEmpty);

    // Left clean.
    await tester.pumpWidget(const SizedBox());
    await store.delete(relayKey);
    await prefs.set(accountKey, null);
    await prefs.setRelay(null);
  });
}
