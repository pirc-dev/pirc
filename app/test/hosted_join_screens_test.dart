// The join's screens (lib/ui/hosted_join_screens.dart) with a fake join:
// what the phone says of each role before anything is added, that nothing
// is added until the person confirms, that leaving declines, and a joining
// phone's code and outcome.
import 'dart:async';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart' show DefaultMaterialLocalizations;
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/ui/hosted_join_screens.dart';
import 'package:pirc/ui/look.dart';

class FakeAdder implements DeviceAdder {
  FakeAdder(this.offered);
  final FutureOr<Offered> Function() offered;
  final calls = <String>[];
  @override
  Future<Offered> start(String text) async {
    calls.add('start $text');
    return offered();
  }

  @override
  Future<void> confirm() async => calls.add('confirm');
  @override
  void cancel() => calls.add('cancel');
}

Widget frame(Widget child) => LookScope(
      look: Look.light,
      child: CupertinoApp(
        localizationsDelegates: const [DefaultMaterialLocalizations.delegate, DefaultCupertinoLocalizations.delegate, DefaultWidgetsLocalizations.delegate],
        home: child,
      ),
    );

final k = Uint8List(32);
final computer = Offered(Device(role: roleComputer, signingKey: k, channelKey: k, boxKey: k));
final browser = Offered(Device(role: roleClient, signingKey: k, channelKey: k, boxKey: k));
final phone = Offered(Device(role: roleClient, signingKey: k, channelKey: k, boxKey: k, readOnlyKey: k, notificationKey: k));

void main() {
  test('what each role is said to be able to do', () {
    expect(offeredText(computer, 3), 'A computer: you will be able to control it from here.');
    expect(offeredText(browser, 4), 'A new browser or app: it will have full control of all 4 of your computers.');
    expect(offeredText(browser, 1), 'A new browser or app: it will have full control of your computer.');
    expect(offeredText(phone, 0), 'Another phone: it will have full control of every computer you add to this account.');
  });

  testWidgets('a computer: said before anything is added, added only once confirmed', (tester) async {
    final a = FakeAdder(() => computer);
    await tester.pumpWidget(frame(AddDeviceScreen(adder: () => a, computers: 2)));
    await tester.enterText(find.byType(CupertinoTextField), 'PIRC1CODE');
    await tester.tap(find.text('Use the text'));
    await tester.pumpAndSettle();
    expect(find.text('A computer: you will be able to control it from here.'), findsOneWidget);
    expect(a.calls, ['start PIRC1CODE']);
    await tester.tap(find.text('It is mine: add it'));
    await tester.pumpAndSettle();
    expect(a.calls, ['start PIRC1CODE', 'confirm']);
    expect(find.text('Added'), findsOneWidget);
  });

  testWidgets('a code refused: its reason shown, and another can be tried', (tester) async {
    var n = 0;
    final adders = <FakeAdder>[];
    await tester.pumpWidget(frame(AddDeviceScreen(
      adder: () {
        final a = FakeAdder(() => n++ == 0 ? throw const JoinFailed('that is not a PiRC join code') : browser);
        adders.add(a);
        return a;
      },
      computers: 4,
    )));
    await tester.enterText(find.byType(CupertinoTextField), 'nonsense');
    await tester.tap(find.text('Use the text'));
    await tester.pumpAndSettle();
    expect(find.text('that is not a PiRC join code'), findsOneWidget);
    await tester.tap(find.text('Use the text'));
    await tester.pumpAndSettle();
    expect(find.text('A new browser or app: it will have full control of all 4 of your computers.'), findsOneWidget);
    expect(adders.length, 2);
  });

  testWidgets('cancelled, or the screen left, at the question: the join ends, nothing is added', (tester) async {
    final a = FakeAdder(() => phone);
    await tester.pumpWidget(frame(AddDeviceScreen(adder: () => a, computers: 1)));
    await tester.enterText(find.byType(CupertinoTextField), 'PIRC1CODE');
    await tester.tap(find.text('Use the text'));
    await tester.pumpAndSettle();
    expect(find.text('Another phone: it will have full control of your computer.'), findsOneWidget);
    await tester.pumpWidget(frame(const SizedBox()));
    expect(a.calls, ['start PIRC1CODE', 'cancel']);
  });

  testWidgets('a joining phone: its code and text, then who approved it', (tester) async {
    final done = Completer<Joined>();
    var cancelled = 0;
    await tester.pumpWidget(frame(ShowCodeScreen(text: 'PIRC1VTPVXVT2000G40R40M30E209185GR38E1W8124GK2GAHC5RR34D1P70X3RFG', done: done.future, cancel: () => cancelled++)));
    expect(find.text('PIRC1VTPVXVT2000G40R40M30E209185GR38E1W8124GK2GAHC5RR34D1P70X3RFG'), findsOneWidget);
    expect(find.textContaining('It works once, for ten minutes.'), findsOneWidget);
    done.complete(Joined(accountId: k, phoneKey: k, first: k, list: k, counter: Int64(2), phoneName: 'Pixel 9'));
    await tester.pumpAndSettle();
    expect(find.text("Approved by 'Pixel 9'."), findsOneWidget);
    await tester.pumpWidget(frame(const SizedBox()));
    expect(cancelled, 0);
  });

  testWidgets('a joining phone left while waiting: the join is cancelled; a failure is said', (tester) async {
    var cancelled = 0;
    await tester.pumpWidget(frame(ShowCodeScreen(text: 'PIRC1X', done: Completer<Joined>().future, cancel: () => cancelled++)));
    await tester.pumpWidget(frame(const SizedBox()));
    expect(cancelled, 1);
    final failed = Completer<Joined>();
    await tester.pumpWidget(frame(ShowCodeScreen(text: 'PIRC1X', done: failed.future, cancel: () => cancelled++)));
    failed.completeError(const JoinFailed('the code did not match: start the join again'));
    await tester.pumpAndSettle();
    expect(find.text('the code did not match: start the join again'), findsOneWidget);
  });
}
