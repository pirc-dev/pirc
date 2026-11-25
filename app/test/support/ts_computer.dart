// A computer in a hosted account, in TypeScript: the extension's Hosted
// after `/pirc join`, with one stand-in session
// (extension/test/hosted-computer.ts), for the app's tests.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

final hasNode = Process.runSync('sh', ['-c', 'command -v node']).exitCode == 0;

// The computer: its output's lines, and stdin for its commands.
class TsComputer {
  TsComputer._(this._proc) {
    _proc.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((l) {
      lines.add(l);
      _wake();
    });
    _proc.stderr.transform(utf8.decoder).listen((s) => stderr.write(s));
  }

  final Process _proc;
  final lines = <String>[];
  Completer<void>? _waiting;

  static Future<TsComputer> start(String origin) async =>
      TsComputer._(await Process.start('node', ['--experimental-transform-types', '--no-warnings', '../extension/test/hosted-computer.ts', origin]));

  void _wake() {
    final w = _waiting;
    _waiting = null;
    w?.complete();
  }

  Future<String> until(bool Function(String l) ok, {Duration timeout = const Duration(seconds: 20)}) async {
    final deadline = DateTime.now().add(timeout);
    for (;;) {
      for (final l in lines) {
        if (ok(l)) return l;
      }
      final left = deadline.difference(DateTime.now());
      if (left.isNegative) throw TimeoutException('the computer said none of it; it said:\n${lines.join('\n')}');
      await (_waiting = Completer<void>()).future.timeout(left, onTimeout: () {});
    }
  }

  void say(String line) => _proc.stdin.writeln(line);
  void kill() => _proc.kill();
}

