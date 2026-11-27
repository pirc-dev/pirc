// The connection's line across the top of every screen (ui/connection.dart):
// when it shows, what it says, and that the screens under it are kept as it
// comes and goes.
import 'package:flutter/cupertino.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pirc/core/view.dart';
import 'package:pirc/ui/connection.dart';
import 'package:pirc/ui/look.dart';
import 'package:pirc/ui/adaptive.dart';

class _Relay extends ChangeNotifier {
  RelayView value = const RelayView(state: 'ready');
  void set(RelayView v) {
    value = v;
    notifyListeners();
  }
}

// The app's shape: a navigator under the line, with a page pushed on it,
// and the status bar's 47 points that the line takes.
Future<(_Relay, GlobalKey<NavigatorState>)> app(WidgetTester tester) async {
  final relay = _Relay();
  final nav = GlobalKey<NavigatorState>();
  await tester.pumpWidget(MediaQuery(
    data: const MediaQueryData(size: Size(390, 844), padding: EdgeInsets.only(top: 47)),
    child: LookScope(
      look: Look.light,
      child: CupertinoApp(
        navigatorKey: nav,
        localizationsDelegates: appLocalizations,
        builder: (context, child) => platformControls(Look.light, Brightness.light, ConnectionBanner(listenable: relay, relay: () => relay.value, child: child!)),
        home: Builder(builder: (context) => Text('home ${MediaQuery.paddingOf(context).top}')),
      ),
    ),
  ));
  nav.currentState!.push(CupertinoPageRoute<void>(builder: (context) => Text('a chat ${MediaQuery.paddingOf(context).top}')));
  await tester.pumpAndSettle();
  return (relay, nav);
}

void main() {
  testWidgets('offline shows at once with its reason; ready takes it away; the page under it stays', (tester) async {
    final (relay, nav) = await app(tester);
    expect(find.textContaining('relay'), findsNothing);
    expect(find.text('a chat 47.0'), findsOneWidget);
    relay.set(const RelayView(state: 'offline', reason: 'no network'));
    await tester.pump();
    expect(find.text('Reconnecting to the relay: no network'), findsOneWidget);
    // The line has the status bar's room; the page under it is kept, and
    // needs none.
    expect(find.text('a chat 0.0'), findsOneWidget);
    expect(nav.currentState!.canPop(), isTrue, reason: 'the chat pushed before is still there');
    relay.set(const RelayView(state: 'ready'));
    await tester.pump();
    expect(find.textContaining('Reconnecting'), findsNothing);
    expect(find.text('a chat 47.0'), findsOneWidget);
    expect(nav.currentState!.canPop(), isTrue);
  });

  testWidgets('connecting shows only once it has taken a moment', (tester) async {
    final (relay, _) = await app(tester);
    relay.set(const RelayView(state: 'connecting'));
    await tester.pump(connectingShownAfter - const Duration(milliseconds: 100));
    expect(find.text('Connecting to the relay…'), findsNothing, reason: 'coming back to the app reconnects: no flash');
    relay.set(const RelayView(state: 'ready'));
    await tester.pump(const Duration(seconds: 2));
    expect(find.text('Connecting to the relay…'), findsNothing, reason: 'ready in time: never shown');
    relay.set(const RelayView(state: 'connecting'));
    await tester.pump(connectingShownAfter + const Duration(milliseconds: 100));
    expect(find.text('Connecting to the relay…'), findsOneWidget);
    relay.set(const RelayView(state: 'ready'));
    await tester.pump();
  });

  testWidgets('once shown, it stays through the retries until the connection is up', (tester) async {
    final (relay, _) = await app(tester);
    relay.set(const RelayView(state: 'offline', reason: 'no network'));
    await tester.pump();
    // A retry: connecting again, at once shown as such, not hidden for a
    // moment.
    relay.set(const RelayView(state: 'connecting'));
    await tester.pump();
    expect(find.text('Connecting to the relay…'), findsOneWidget);
    relay.set(const RelayView(state: 'offline', reason: 'no network'));
    await tester.pump();
    expect(find.text('Reconnecting to the relay: no network'), findsOneWidget);
    relay.set(const RelayView(state: 'ready'));
    await tester.pump();
    expect(find.textContaining('relay'), findsNothing);
  });

  testWidgets('screen readers read it, over a page pushed on the navigator', (tester) async {
    final semantics = tester.ensureSemantics();
    final (relay, _) = await app(tester);
    relay.set(const RelayView(state: 'offline', reason: 'no network'));
    await tester.pump();
    // A page route's barrier blocks what is painted before it in its
    // semantics container: the line is outside the screens' own.
    expect(find.bySemanticsLabel('Reconnecting to the relay: no network'), findsOneWidget);
    relay.set(const RelayView(state: 'ready'));
    await tester.pump();
    semantics.dispose();
  });

  testWidgets('refused says why; stopped by the app says nothing', (tester) async {
    final (relay, _) = await app(tester);
    relay.set(const RelayView(state: 'refused', reason: 'this key is not on the list'));
    await tester.pump();
    expect(find.text('The relay refused this phone: this key is not on the list'), findsOneWidget);
    relay.set(const RelayView(state: 'stopped'));
    await tester.pump();
    expect(find.textContaining('relay'), findsNothing);
  });
}
