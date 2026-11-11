// Joining from the join screen with the phone's own key store and prefs, as
// a person pasting a link would, against a relay of one's own (app/demo.ts
// prints a link): flutter test integration_test/join_test.dart -d <device>
// --dart-define=JOIN_LINK='pirc://join?…'. A protected main key asks for
// Face ID or the passcode, so this joins with the lock off.
import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc/app/app.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/ui/sessions_screen.dart';

const link = String.fromEnvironment('JOIN_LINK');
// On a phone with no passcode: joining with the lock on says to set one.
// Not on the iOS simulator, whose Keychain locks a key without one.
const noPasscode = bool.fromEnvironment('NO_PASSCODE');

// What the screen says, for a failure's message.
String shown(WidgetTester tester) => tester.widgetList<Text>(find.byType(Text)).map((t) => t.data ?? t.textSpan?.toPlainText() ?? '').join(' | ');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('with no passcode, joining with the lock says to set one', (tester) async {
    if (link.isEmpty || !noPasscode) {
      markTestSkipped('needs JOIN_LINK and NO_PASSCODE');
      return;
    }
    await tester.pumpWidget(PircApp(store: ChannelKeyStore(), prefs: ChannelPrefs()));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(CupertinoTextField), link);
    await tester.tap(find.text('Join with the link'));
    for (var i = 0; i < 50 && find.textContaining('passcode').evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
    }
    expect(find.textContaining('passcode'), findsOneWidget, reason: shown(tester));
  });

  testWidgets('joins the relay and lists its sessions', (tester) async {
    if (link.isEmpty) {
      markTestSkipped('no JOIN_LINK given');
      return;
    }
    final prefs = ChannelPrefs();
    await tester.pumpWidget(PircApp(store: ChannelKeyStore(), prefs: prefs, protect: false));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(CupertinoTextField), link);
    await tester.tap(find.text('Join with the link'));
    for (var i = 0; i < 100 && find.byType(SessionsScreen).evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
    }
    expect(find.byType(SessionsScreen), findsOneWidget, reason: shown(tester));
    expect(await prefs.relay(), isNotNull);
    for (var i = 0; i < 100 && find.text('SERVER').evaluate().isEmpty; i++) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 100)));
      await tester.pump();
    }
    expect(find.text('LAPTOP'), findsOneWidget);
    expect(find.text('SERVER'), findsOneWidget);
  });
}
