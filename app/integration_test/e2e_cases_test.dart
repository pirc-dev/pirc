// cases/e2e/framed.json and list.json against the app's Dart (lib/e2e), on
// a phone or simulator, where sodium is the native library the app ships.
// A device cannot read the tree, so the test fetches the two files from
// serve_e2e_cases.dart, run on the same machine (it says how):
//   dart run integration_test/serve_e2e_cases.dart &
//   flutter test integration_test/e2e_cases_test.dart -d <device>
// Another address: --dart-define=PIRC_E2E_CASES=http://host:port
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/list.dart';

import '../test/support/e2e_cases.dart';

const casesUrl = String.fromEnvironment('PIRC_E2E_CASES', defaultValue: 'http://127.0.0.1:47815');

Future<String> fetch(String name) async {
  final client = HttpClient();
  try {
    final res = await (await client.getUrl(Uri.parse('$casesUrl/$name'))).close();
    if (res.statusCode != HttpStatus.ok) throw StateError('$casesUrl/$name: ${res.statusCode}');
    return await res.transform(utf8.decoder).join();
  } finally {
    client.close();
  }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('framed.json and list.json', (_) async {
    final framedJson = await fetch('framed.json');
    final listJson = await fetch('list.json');
    final e2e = await E2e.load();
    final sodium = await SodiumSumoInit.init();
    final framed = runFramed(framedJson);
    final list = runList(listJson, e2e, sodium);
    final failures = [for (final o in [...framed, ...list.outcomes]) if (o.failure != null) '${o.about}: ${o.failure}'];
    // ignore: avoid_print
    print('E2E_CASES libsodium ${sodium.version}: ${framed.length} framed, ${list.outcomes.length} list, ${list.left} left out, ${failures.length} failed');
    expect(failures, isEmpty);
    expect(framed.length, ((jsonDecode(framedJson) as Map)['cases'] as List).length);
    expect(list.outcomes.length, ((jsonDecode(listJson) as Map)['cases'] as List).length);
    expect(list.left, 0);
  });
}
