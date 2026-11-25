// The relay takes only a version of the list built on the one it holds.
// A relay that lost versions it had taken (its store restored from an
// older copy) refuses the phone's newest at the next login, and the
// account's phone signs the newest's devices again on top of the relay's
// version (app/hosted_devices.dart, hosted/sessions.dart).
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart' show MemoryPrefs;
import 'package:pirc/app/hosted_devices.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/connection.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';

import 'support/relay.dart';
import 'support/ts_computer.dart';

Future<v2.Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => v2.Attestation(test: [1]);

void main() {
  final ready = hasGo && hasNode;
  late Directory dir;
  late HostedRelay relay;
  late E2e e2e;
  setUpAll(() async {
    if (!ready) return;
    e2e = await E2e.load();
    dir = await Directory.systemTemp.createTemp('pirc-hosted-behind-');
    relay = await HostedRelay.start(dir);
  });
  tearDownAll(() async {
    if (!ready) return;
    relay.kill();
    await dir.delete(recursive: true);
  });

  Future<void> waitFor(bool Function() done, {required String what}) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    if (!done()) fail('waited for $what');
  }

  // The account's phone adds a computer by its code, from its keys kept.
  Future<void> add(KeyStore store, MemoryPrefs prefs, String text) async {
    final open = (await openAccount(e2e: e2e, store: store, values: prefs, relay: hostedRelayKey(relay.origin)))!;
    final a = open.account;
    final link = await HostedLink.connect(origin: a.origin, publicKey: open.main.signing.publicKey, sign: (m) async => open.main.sign(m), accountId: a.accountId);
    final frames = link.frames.asBroadcastStream();
    try {
      for (var i = 0;; i++) {
        final add = AddDevice(
          e2e: e2e,
          account: PhoneAccount(accountId: a.accountId, phone: a.self, signing: open.main.signing, channel: open.main.channel.secretKey, first: a.first, newest: a.newest.bytes, name: 'Mac', counter: MemoryCounter().next),
          frames: frames,
          send: link.send,
        );
        try {
          await add.start(text);
          await a.take(await add.confirm());
          return;
        } on JoinFailed catch (e) {
          if (!e.message.startsWith('no device shows') || i > 20) rethrow;
          await Future<void>.delayed(const Duration(milliseconds: 150));
        }
      }
    } finally {
      await link.close();
      open.dispose();
    }
  }

  test('a relay that lost versions: the phone signs its devices again on top of the relay\'s', () async {
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs();
    final open = await signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false);
    open.dispose();
    await prefs.setRelay(hostedRelayKey(relay.origin));
    // The relay's store as it is at version 1.
    final backup = Directory('${dir.path}/backup');
    await relay.restart(() async {
      final r = await Process.run('cp', ['-R', relay.data.path, backup.path]);
      if (r.exitCode != 0) throw StateError('cp: ${r.stderr}');
    });

    // Two computers: versions 2 and 3, the newest built on 2.
    final one = await TsComputer.start(relay.origin);
    addTearDown(one.kill);
    await add(store, prefs, await one.until((l) => l.startsWith('PIRC1')));
    await one.until((l) => l == 'status ready');
    final two = await TsComputer.start(relay.origin);
    addTearDown(two.kill);
    await add(store, prefs, await two.until((l) => l.startsWith('PIRC1')));
    await two.until((l) => l == 'status ready');

    // The relay back at version 1.
    final marks = [one.lines.length, two.lines.length];
    await relay.restart(() async {
      await relay.data.delete(recursive: true);
      final r = await Process.run('cp', ['-R', backup.path, relay.data.path]);
      if (r.exitCode != 0) throw StateError('cp: ${r.stderr}');
    });

    final again = (await openAccount(e2e: e2e, store: store, values: prefs, relay: hostedRelayKey(relay.origin)))!;
    final a = again.account;
    expect(a.newest.counter, Int64(3));
    final devices = a.newest.body.devices.map((d) => d.signingKey).toList();
    final run = HostedRun(e2e: e2e, open: again, toClient: (_) {}, relayState: (_) {}, values: prefs);
    addTearDown(run.dispose);
    AppHostedDevices(e2e: e2e, run: run, values: prefs, counter: MemoryCounter());
    run.start();
    for (var i = 0; i < 100 && a.newest.counter < Int64(4); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    expect(run.conn.current, isA<HostedReady>());
    // Version 4: version 3's devices, on top of the relay's version 1.
    expect(a.newest.counter, Int64(4));
    expect(a.newest.body.devices.map((d) => d.signingKey).toList(), devices);
    expect(a.newest.body.previousHash, e2e.sha256(Uint8List.sublistView(a.first, signatureBytes)));
    final link = await HostedLink.connect(origin: a.origin, publicKey: again.main.signing.publicKey, sign: (m) async => again.main.sign(m), accountId: a.accountId);
    await link.close();
    expect(link.welcome.listCounter, Int64(4));
    // Both computers back on the account, never told they were removed.
    for (final (i, c) in [one, two].indexed) {
      await waitFor(() => c.lines.skip(marks[i]).contains('status ready'), what: 'computer ${i + 1} ready again: ${c.lines.skip(marks[i]).join(' / ')}');
      expect(c.lines.skip(marks[i]), isNot(contains('status removed')));
    }
  }, skip: !ready);
}
