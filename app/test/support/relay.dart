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
    return _serve(bin, '${dir.path}/relay');
  }

  // The same relay, its registry and all, stopped and started on another
  // port, as when its operator moves it.
  Future<Relay> moved() async {
    kill();
    await _proc.exitCode;
    return _serve(bin, data);
  }

  static Future<Relay> _serve(String bin, String data) async {
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
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

// The Go relay in its hosted mode (built with the tag hosted), with the
// test attestation, as test/harness.ts's startHostedRelay starts it.
class HostedRelay {
  HostedRelay._(this.origin, this._proc);

  final String origin;
  final Process _proc;

  static Future<HostedRelay> start(Directory dir) async {
    final bin = '${dir.path}/pirc-relay-hosted';
    final built = await Process.run('go', ['build', '-tags', 'hosted', '-o', bin, './cmd/pirc-relay'], workingDirectory: '../relay');
    if (built.exitCode != 0) throw StateError('go build: ${built.stderr}');
    final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = probe.port;
    await probe.close();
    final origin = 'ws://127.0.0.1:$port';
    final proc = await Process.start(bin, ['serve-hosted', '--plaintext', '--listen', '127.0.0.1:$port', '--origin', origin, '--test-attestation', '--data-dir', '${dir.path}/hosted']);
    proc.stdout.drain<void>();
    final listening = Completer<void>();
    final log = StringBuffer();
    proc.stderr.transform(const SystemEncoding().decoder).listen((s) {
      log.write(s);
      if (!listening.isCompleted && log.toString().contains('msg=listening')) listening.complete();
    });
    await listening.future.timeout(const Duration(seconds: 20), onTimeout: () => throw StateError('the hosted relay did not start:\n$log'));
    return HostedRelay._(origin, proc);
  }

  void kill() => _proc.kill();
}
