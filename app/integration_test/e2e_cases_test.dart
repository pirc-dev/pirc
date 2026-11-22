// cases/e2e/ framed.json, list.json, sealed.json, names.json and
// channel.json, and cases/noise/'s vectors, against the app's Dart
// (lib/e2e), on a phone or simulator, where sodium is the native library the
// app ships. A device cannot read the tree, so the test fetches the files from
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
import '../test/support/noise_cases.dart' show runChannel, runVectors;

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

  testWidgets('framed.json, list.json, sealed.json and names.json', (_) async {
    final framedJson = await fetch('framed.json');
    final listJson = await fetch('list.json');
    final sealedJson = await fetch('sealed.json');
    final namesJson = await fetch('names.json');
    final e2e = await E2e.load();
    final sodium = await SodiumSumoInit.init();
    final framed = runFramed(framedJson);
    final list = runList(listJson, e2e, sodium);
    final sealed = runSealed(sealedJson, e2e);
    final names = runNames(namesJson, e2e, sodium);
    final failures = [for (final o in [...framed, ...list.outcomes, ...sealed.outcomes, ...names.outcomes]) if (o.failure != null) '${o.about}: ${o.failure}'];
    // ignore: avoid_print
    print('E2E_CASES libsodium ${sodium.version}: ${framed.length} framed, ${list.outcomes.length} list, ${sealed.outcomes.length} sealed, ${names.outcomes.length} names, ${failures.length} failed');
    expect(failures, isEmpty);
    expect(framed.length, ((jsonDecode(framedJson) as Map)['cases'] as List).length);
    expect(list.outcomes.length, ((jsonDecode(listJson) as Map)['cases'] as List).length);
    expect(list.left, 0);
    // Only the sealing, a computer's, is left out of sealed.json.
    final sealedCases = ((jsonDecode(sealedJson) as Map)['cases'] as List).cast<Map>();
    expect(sealed.outcomes.length, sealedCases.where((c) => c['check'] == 'open').length);
    expect(sealed.left, sealedCases.where((c) => c['check'] == 'seal').length);
    expect(names.outcomes.length, ((jsonDecode(namesJson) as Map)['cases'] as List).length);
    expect(names.left, 0);
  });

  testWidgets('cases/noise/ and channel.json', (_) async {
    final channelJson = await fetch('channel.json');
    final vectorFiles = {for (final name in ['cacophony.json', 'snow.json']) name: await fetch('noise/$name')};
    await E2e.load();
    final sodium = await SodiumSumoInit.init();
    final vectors = [for (final MapEntry(:key, :value) in vectorFiles.entries) ...runVectors(key, value, sodium)];
    final channel = runChannel(channelJson, sodium);
    final failures = [for (final o in [...vectors, ...channel.outcomes]) if (o.failure != null) '${o.about}: ${o.failure}'];
    final roles = [for (final MapEntry(:key, :value) in channel.roles.entries) '$value $key'].join(', ');
    // ignore: avoid_print
    print('NOISE_CASES libsodium ${sodium.version}: ${vectors.length} vectors, ${channel.outcomes.length} channel ($roles), ${failures.length} failed');
    expect(failures, isEmpty);
    expect(vectors.length, [for (final f in vectorFiles.values) ((jsonDecode(f) as Map)['vectors'] as List).length].reduce((a, b) => a + b));
    expect(channel.outcomes.length, ((jsonDecode(channelJson) as Map)['cases'] as List).length);
    expect(channel.left, 0);
  });
}
