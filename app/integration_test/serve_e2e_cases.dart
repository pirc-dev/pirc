// Serves cases/e2e/ and cases/noise/ on 127.0.0.1, for
// integration_test/e2e_cases_test.dart on a simulator or emulator, which
// cannot read the tree:
//   dart run integration_test/serve_e2e_cases.dart &
//   adb reverse tcp:47815 tcp:47815              on an Android emulator
//   flutter test integration_test/e2e_cases_test.dart -d <device>
// /<name>.json is cases/e2e/<name>.json and /noise/<name>.json is
// cases/noise/<name>.json. It serves only the .json files there, and stops
// when killed.
import 'dart:io';

/// The directory each first path segment names; a single segment is cases/e2e/'s.
const _dirs = {'': '../cases/e2e', 'noise': '../cases/noise'};

Future<void> main(List<String> args) async {
  final port = args.isEmpty ? 47815 : int.parse(args.single);
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
  stdout.writeln('serving ${_dirs.values.join(' and ')} on http://127.0.0.1:$port/');
  await for (final req in server) {
    final segments = req.uri.pathSegments;
    final dir = switch (segments.length) {
      1 => _dirs[''],
      2 => segments.first == 'noise' ? _dirs['noise'] : null,
      _ => null,
    };
    final name = segments.isEmpty ? '' : segments.last;
    final file = File('$dir/$name');
    if (dir != null && RegExp(r'^[a-z]+\.json$').hasMatch(name) && file.existsSync()) {
      req.response.headers.contentType = ContentType.json;
      await req.response.addStream(file.openRead());
    } else {
      req.response.statusCode = HttpStatus.notFound;
    }
    await req.response.close();
  }
}
