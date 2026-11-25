// End to end on a hosted account: a real pi in tmux with the extension
// (extension/test/hosted-pi.ts), joined by `/pirc join` typed at its
// terminal, the Go relay, and the app's Dart as the account's phone. The
// phone signs up, adds pi's computer by the code pi shows, sees its
// session over a channel, prompts it and gets the model's reply, is woken
// with the turn's notice through its read-only key, then takes the
// computer off the account, and pi says it was removed.
//
// Needs go, node, tmux and pi on PATH; skipped, saying so, without them.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart';
import 'package:pirc/app/hosted_devices.dart';
import 'package:pirc/core/client.dart';
import 'package:pirc/core/protocol.dart' as v1;
import 'package:pirc/core/view.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart';
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/notices.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';

import 'support/relay.dart';
import 'support/ts_computer.dart';

final hasPi = Process.runSync('sh', ['-c', 'command -v pi && command -v tmux']).exitCode == 0;

Future<Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => Attestation(test: [1]);

void main() {
  final ready = hasGo && hasNode && hasPi;

  test('a real pi: joined, seen, prompted, its notice fetched, removed', () async {
    final e2e = await E2e.load();
    final dir = await Directory.systemTemp.createTemp('pirc-hosted-pi-');
    addTearDown(() => dir.delete(recursive: true));
    final relay = await HostedRelay.start(dir);
    addTearDown(relay.kill);
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs();
    final open = await signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false);
    addTearDown(open.dispose);
    final relayKey = hostedRelayKey(relay.origin);
    await prefs.setRelay(relayKey);
    final a = open.account;

    // pi shows the code; the phone adds it.
    final pi = await TsComputer.start(relay.origin, script: 'hosted-pi.ts');
    // Ended by stdin closing, or by a signal, it ends pi and its tmux
    // server first.
    addTearDown(() async {
      await pi.close();
      await pi.exited.timeout(const Duration(seconds: 15), onTimeout: () {
        pi.kill();
        return pi.exited;
      });
    });
    final text = await pi.until((l) => l.startsWith('PIRC1') || l.startsWith('failed'), timeout: const Duration(seconds: 60));
    expect(text, startsWith('PIRC1'));
    final link = await HostedLink.connect(origin: a.origin, publicKey: open.main.signing.publicKey, sign: (m) async => open.main.sign(m), accountId: a.accountId);
    final frames = link.frames.asBroadcastStream();
    for (var i = 0;; i++) {
      final add = AddDevice(
        e2e: e2e,
        account: PhoneAccount(accountId: a.accountId, phone: a.self, signing: open.main.signing, channel: open.main.channel.secretKey, first: a.first, newest: a.newest.bytes, name: 'Pixel 9', counter: MemoryCounter().next),
        frames: frames,
        send: link.send,
      );
      try {
        final offered = await add.start(text);
        expect(offered.isComputer, isTrue);
        await a.take(await add.confirm());
        break;
      } on JoinFailed catch (e) {
        if (!e.message.startsWith('no device shows') || i > 40) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
    }
    await pi.until((l) => l == 'joined', timeout: const Duration(seconds: 120));

    await link.close();

    // The phone's sessions, as the app runs them: pi's, over a channel.
    final events = <ViewEvent>[];
    late final Client client;
    final run = HostedRun(e2e: e2e, open: open, toClient: (f) => client.onFrame(f), relayState: (r) => client.onState(r), values: prefs);
    client = Client(send: run.send, onEvent: events.add, publicKey: open.main.signing.publicKey);
    run.start();
    addTearDown(() {
      run.sessions.dispose();
      run.conn.stop();
    });
    final devices = AppHostedDevices(e2e: e2e, run: run, values: prefs, counter: MemoryCounter());
    Future<T> until<T>(String what, T? Function() find, {Duration timeout = const Duration(seconds: 30)}) async {
      final deadline = DateTime.now().add(timeout);
      for (;;) {
        final v = find();
        if (v != null) return v;
        if (DateTime.now().isAfter(deadline)) throw StateError('waiting for $what');
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
    }

    // The whole announcement: pi's version, from the channel.
    final s = await until('pi\'s session', () => client.snapshot().sessions.where((s) => s.piVersion.isNotEmpty).firstOrNull);
    final since = DateTime.now().millisecondsSinceEpoch - 1;

    // Prompted: the model's reply comes back as chat items.
    final reply = await client.ask(s.id, v1.SessionMessage(prompt: v1.Prompt(requestId: client.id(), text: 'hello')));
    expect(reply.hasError(), isFalse, reason: reply.error.message);
    await until('the reply', () => client.chat(s.id)?.items.whereType<AssistantItem>().where((i) => !i.streaming && i.blocks.isNotEmpty).firstOrNull);

    // Woken: the turn's notice, sealed to this phone's notification key.
    List<HostedNote> notes = [];
    for (var i = 0; i < 100 && notes.isEmpty; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 200));
      notes = await hostedNotes(e2e: e2e, values: prefs, store: store, relay: relayKey, now: DateTime.now().millisecondsSinceEpoch, since: since);
    }
    expect(notes, hasLength(1));

    // Removed, as Settings removes it: its session ends here, and pi says so.
    final computer = a.newest.body.devices.singleWhere((d) => d.role == roleComputer);
    expect(await devices.remove(keyText(computer.signingKey)), isNull);
    expect(a.newest.body.devices.map((d) => d.role), [roleClient]);
    await until('the session gone', () => client.snapshot().sessions.isEmpty ? true : null);
    pi.say('status');
    await Future<void>.delayed(const Duration(seconds: 1));
    pi.say('screen');
    await pi.until((l) => l == 'end');
    expect(pi.lines.where((l) => l.startsWith('| ')).join('\n'), contains('removed from the account'));
  }, skip: ready ? false : 'needs go, node, tmux and pi on PATH', timeout: const Timeout(Duration(minutes: 5)));
}
