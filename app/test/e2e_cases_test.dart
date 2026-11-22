// cases/e2e/ framed.json, list.json, sealed.json and names.json against the app's Dart (lib/e2e),
// on the host; integration_test/e2e_cases_test.dart runs the same on a
// phone or simulator.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/list.dart';

import 'support/e2e_cases.dart';

String read(String name) => File('../cases/e2e/$name').readAsStringSync();

void main() {
  late E2e e2e;
  late SodiumSumo sodium;
  setUpAll(() async {
    e2e = await E2e.load();
    sodium = await SodiumSumoInit.init();
  });

  test('framed.json', () {
    final outcomes = runFramed(read('framed.json'));
    expect([for (final o in outcomes) if (o.failure != null) '${o.about}: ${o.failure}'], isEmpty);
    expect(outcomes.length, ((jsonDecode(read('framed.json')) as Map)['cases'] as List).length);
  });

  test('list.json', () {
    final r = runList(read('list.json'), e2e, sodium);
    expect([for (final o in r.outcomes) if (o.failure != null) '${o.about}: ${o.failure}'], isEmpty);
    // The app has every part list.json names: nothing is left out.
    expect(r.left, 0);
    expect(r.outcomes.length, ((jsonDecode(read('list.json')) as Map)['cases'] as List).length);
  });

  test('sealed.json', () {
    final text = read('sealed.json');
    final r = runSealed(text, e2e);
    expect([for (final o in r.outcomes) if (o.failure != null) '${o.about}: ${o.failure}'], isEmpty);
    // Only the sealing, a computer's, is left out.
    final cases = ((jsonDecode(text) as Map)['cases'] as List).cast<Map>();
    expect(r.left, cases.where((c) => c['check'] == 'seal').length);
    expect(r.outcomes.length, cases.where((c) => c['check'] == 'open').length);
  });

  test('names.json', () {
    final text = read('names.json');
    final r = runNames(text, e2e, sodium);
    expect([for (final o in r.outcomes) if (o.failure != null) '${o.about}: ${o.failure}'], isEmpty);
    expect(r.left, 0);
    expect(r.outcomes.length, ((jsonDecode(text) as Map)['cases'] as List).length);
  });

  test('a number of 2^64 or more in a file is its mistake', () {
    const file = '{"about": "x", "cases": [{"check": "number", "about": "2^64", "needs": [], "value": "18446744073709551616", "throws": true}]}';
    expect(() => runFramed(file), throwsFormatException);
  });

  test('a file of another shape fails', () {
    expect(runFramed('{"about": "x", "cases": []}').single.failure, isNotNull);
    expect(runList('{"about": "x", "cases": []}', e2e, sodium).outcomes.single.failure, isNotNull);
    expect(runSealed('{"about": "x", "cases": []}', e2e).outcomes.single.failure, isNotNull);
    expect(runNames('{"about": "x", "cases": []}', e2e, sodium).outcomes.single.failure, isNotNull);
  });
}
