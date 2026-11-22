// Serves cases/e2e/ on 127.0.0.1, for integration_test/e2e_cases_test.dart
// on a simulator or emulator, which cannot read the tree:
//   dart run integration_test/serve_e2e_cases.dart &
//   adb reverse tcp:47815 tcp:47815              on an Android emulator
//   flutter test integration_test/e2e_cases_test.dart -d <device>
// It serves only the .json files there, and stops when killed.
import 'dart:io';

Future<void> main(List<String> args) async {
  final port = args.isEmpty ? 47815 : int.parse(args.single);
  final dir = Directory('../cases/e2e');
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
  stdout.writeln('serving ${dir.path} on http://127.0.0.1:$port/');
  await for (final req in server) {
    final name = req.uri.pathSegments.length == 1 ? req.uri.pathSegments.single : '';
    final file = File('${dir.path}/$name');
    if (RegExp(r'^[a-z]+\.json$').hasMatch(name) && file.existsSync()) {
      req.response.headers.contentType = ContentType.json;
      await req.response.addStream(file.openRead());
    } else {
      req.response.statusCode = HttpStatus.notFound;
    }
    await req.response.close();
  }
}
