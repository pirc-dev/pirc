// The Go relay for the app's integration tests, built from the tree and
// started on a free port, as test/harness.ts does for the others.
import 'dart:async';
import 'dart:io';

import 'package:pirc/relay/connection.dart';

final hasGo = Process.runSync('sh', ['-c', 'command -v go']).exitCode == 0;

class Relay {
  Relay._(this.bin, this.data, this.url, this._proc);

  final String bin;
  final String data;
  final String url;
  final Process _proc;

  static Future<Relay> start(Directory dir) async {
    final bin = '${dir.path}/pirc-relay';
    final built = await Process.run('go', ['build', '-o', bin, './cmd/pirc-relay'], workingDirectory: '../relay');
    if (built.exitCode != 0) throw StateError('go build: ${built.stderr}');
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    final data = '${dir.path}/relay';
    final proc = await Process.start(bin, ['serve', '--plaintext', '--listen', '127.0.0.1:$port', '--data-dir', data]);
    proc.stdout.drain<void>();
    proc.stderr.drain<void>();
    for (var i = 0;; i++) {
      try {
        (await Socket.connect('127.0.0.1', port)).destroy();
        break;
      } catch (_) {
        if (i > 100) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    }
    return Relay._(bin, data, 'ws://127.0.0.1:$port', proc);
  }

  String cmd(String name, List<String> args) {
    final r = Process.runSync(bin, [name, '--data-dir', data, ...args]);
    if (r.exitCode != 0) throw StateError('$name: ${r.stderr}');
    return (r.stdout as String).trim();
  }

  void kill() => _proc.kill();
}

// The first state of T, or the refusal that came first.
Future<T> stateOf<T extends ConnectionState>(Stream<ConnectionState> states) =>
    states.firstWhere((s) => s is T || s is Refused).timeout(const Duration(seconds: 10)).then((s) {
      if (s is! T) throw StateError('expected $T, got $s${s is Refused ? ': ${s.reason}' : ''}');
      return s;
    });
