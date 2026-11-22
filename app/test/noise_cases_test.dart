// cases/noise/'s published vectors and cases/e2e/channel.json against the
// app's Noise (lib/e2e/noise_core.dart), on the host, every case in both
// roles; integration_test/e2e_cases_test.dart runs the same on a phone or
// simulator.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/list.dart';

import 'support/noise_cases.dart';

String read(String path) => File('../cases/$path').readAsStringSync();

void main() {
  late SodiumSumo sodium;
  setUpAll(() async {
    await E2e.load();
    sodium = await SodiumSumoInit.init();
  });

  test('cases/noise: the published vectors', () {
    final outcomes = [for (final name in ['cacophony', 'snow']) ...runVectors('$name.json', read('noise/$name.json'), sodium)];
    expect([for (final o in outcomes) if (o.failure != null) '${o.about}: ${o.failure}'], isEmpty);
    final total = [for (final name in ['cacophony', 'snow']) ((jsonDecode(read('noise/$name.json')) as Map)['vectors'] as List).length].reduce((a, b) => a + b);
    expect(outcomes.length, total);
    // cacophony's IK and XXpsk3 with their handshake hashes, and snow's IK without.
    expect(total, 3);
  });

  test('cases/e2e/channel.json: every case, each party in its role', () {
    final text = read('e2e/channel.json');
    final r = runChannel(text, sodium);
    expect([for (final o in r.outcomes) if (o.failure != null) '${o.about}: ${o.failure}'], isEmpty);
    final cases = ((jsonDecode(text) as Map)['cases'] as List).cast<Map>();
    expect(r.left, 0, reason: 'the app runs every case: the IK responder and XXpsk3 through their test entry points');
    expect(r.outcomes.length, cases.length);
    var parties = 0;
    for (final c in cases) {
      if (c['check'] != 'prologue') parties += (c['parties'] as Map).length;
    }
    expect(r.roles.values.reduce((a, b) => a + b), parties);
    expect(r.roles.keys.toSet(), {'IK initiator', 'IK responder', 'XXpsk3 initiator', 'XXpsk3 responder'});
  });

  test('channel.json: each failure, its reason, and dead after it, at each side', () {
    final file = jsonDecode(read('e2e/channel.json')) as Map;
    final seen = <String>{};
    for (final c in (file['cases'] as List).cast<Map>()) {
      if (c['check'] == 'prologue') continue;
      for (final s in (c['steps'] as List).cast<Map>()) {
        final role = (c['parties'] as Map)[s['party']]['role'];
        if (s.containsKey('fails')) seen.add('${c['check']} $role ${s['call']} ${s['fails']}');
      }
    }
    for (final want in [
      'IK initiator write dh',
      'IK initiator read length',
      'IK initiator read decrypt',
      'IK initiator read dh',
      'IK initiator receive length',
      'IK initiator receive decrypt',
      'IK initiator write dead',
      'IK initiator read dead',
      'IK initiator send dead',
      'IK initiator receive dead',
      'IK responder read length',
      'IK responder read decrypt',
      'IK responder read dh',
      'IK responder receive length',
      'IK responder receive decrypt',
      'IK responder write dead',
      'IK responder read dead',
      'IK responder send dead',
      'IK responder receive dead',
      'XXpsk3 initiator read length',
      'XXpsk3 initiator read decrypt',
      'XXpsk3 initiator read dh',
      'XXpsk3 responder read length',
      'XXpsk3 responder read decrypt',
      'XXpsk3 responder read dh',
      'XXpsk3 responder write dh',
      'XXpsk3 initiator receive decrypt',
      'XXpsk3 responder receive decrypt',
      'XXpsk3 initiator send dead',
      'XXpsk3 responder send dead',
      'XXpsk3 initiator receive dead',
      'XXpsk3 responder receive dead',
    ]) {
      expect(seen, contains(want));
    }
  });

  test('a file of another shape fails', () {
    expect(runVectors('x.json', '{"about": "x", "vectors": []}', sodium).single.failure, isNotNull);
    expect(runChannel('{"about": "x", "cases": []}', sodium).outcomes.single.failure, isNotNull);
    // A step that is not dead after a failure.
    final file = jsonDecode(read('e2e/channel.json')) as Map<String, Object?>;
    final cases = (file['cases'] as List).cast<Map<String, Object?>>();
    final c = cases.firstWhere((c) => (c['about'] as String).startsWith('IK: message 1 cut to 95 bytes'));
    final steps = (c['steps'] as List).cast<Map<String, Object?>>();
    final dead = steps.lastWhere((s) => s['fails'] == 'dead');
    dead['fails'] = 'decrypt';
    expect(runChannel(jsonEncode({'about': 'x', 'cases': [c]}), sodium).outcomes.single.failure, contains('dead after a failure'));
    // A need the case does not show.
    final p = cases.first;
    p['needs'] = ['xxpsk3'];
    expect(runChannel(jsonEncode({'about': 'x', 'cases': [p]}), sodium).outcomes.single.failure, isNotNull);
    // A vector with an unknown key.
    final v = jsonDecode(read('noise/snow.json')) as Map<String, Object?>;
    ((v['vectors'] as List).first as Map)['extra'] = 'x';
    expect(runVectors('snow.json', jsonEncode(v), sodium).single.failure, contains('unknown key'));
  });

  test('a changed byte in a case is found', () {
    final file = jsonDecode(read('e2e/channel.json')) as Map<String, Object?>;
    final c = (file['cases'] as List).cast<Map<String, Object?>>().firstWhere((c) => (c['about'] as String).startsWith('IK: both messages'));
    final first = (c['steps'] as List).first as Map<String, Object?>;
    final b = first['bytes'] as String;
    first['bytes'] = '${b.substring(0, b.length - 1)}${b.endsWith('0') ? '1' : '0'}';
    expect(runChannel(jsonEncode({'about': 'x', 'cases': [c]}), sodium).outcomes.single.failure, isNotNull);
  });
}
