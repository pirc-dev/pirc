// A relay restored from an older copy lost versions of the list it had
// taken. It takes a version built on one it never held, so the devices
// that hold newer versions bring it back by giving theirs at login: the
// phone its newest (hosted/sessions.dart), a computer its own
// (extension/src/hosted.ts), even a version the phone signed and never
// heard taken.
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart' show MemoryPrefs;
import 'package:pirc/app/hosted_devices.dart';
import 'package:pirc/e2e/bytes.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';

import 'support/relay.dart';
import 'support/ts_computer.dart';

Future<v2.Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => v2.Attestation(test: [1]);

void main() {
  final ready = hasGo && hasNode;
  late E2e e2e;
  setUpAll(() async {
    if (!ready) return;
    e2e = await E2e.load();
  });

  Future<void> waitFor(bool Function() done, {required String what}) async {
    for (var i = 0; i < 200 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    if (!done()) fail('waited for $what');
  }

  // A hosted relay of its own, stopped and its folder deleted at the end:
  // each test joins two computers, and the relay caps join lookups.
  Future<HostedRelay> relayOfItsOwn() async {
    final dir = await Directory.systemTemp.createTemp('pirc-hosted-behind-');
    final relay = await HostedRelay.start(dir);
    addTearDown(() async {
      relay.kill();
      await dir.delete(recursive: true);
    });
    return relay;
  }

  // The account's phone adds a computer by its code, from its keys kept.
  Future<void> add(HostedRelay relay, KeyStore store, MemoryPrefs prefs, String text) async {
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

  // Signs up, keeps a copy of the relay's store at version 1, and joins
  // two computers: versions 2 and 3.
  Future<(HostedRelay, MemoryKeyStore, MemoryPrefs, Directory, TsComputer, TsComputer)> threeVersions() async {
    final relay = await relayOfItsOwn();
    final store = MemoryKeyStore();
    final prefs = MemoryPrefs();
    final open = await signUp(e2e: e2e, store: store, values: prefs, origin: relay.origin, attest: testAttest, protect: false);
    open.dispose();
    await prefs.setRelay(hostedRelayKey(relay.origin));
    final backup = Directory('${relay.data.parent.path}/backup');
    await relay.restart(() async {
      final r = await Process.run('cp', ['-R', relay.data.path, backup.path]);
      if (r.exitCode != 0) throw StateError('cp: ${r.stderr}');
    });
    final one = await TsComputer.start(relay.origin);
    addTearDown(one.kill);
    await add(relay, store, prefs, await one.until((l) => l.startsWith('PIRC1')));
    await one.until((l) => l == 'status ready');
    final two = await TsComputer.start(relay.origin);
    addTearDown(two.kill);
    await add(relay, store, prefs, await two.until((l) => l.startsWith('PIRC1')));
    await two.until((l) => l == 'status ready');
    return (relay, store, prefs, backup, one, two);
  }

  Future<void> restore(HostedRelay relay, Directory backup) => relay.restart(() async {
        await relay.data.delete(recursive: true);
        final r = await Process.run('cp', ['-R', backup.path, relay.data.path]);
        if (r.exitCode != 0) throw StateError('cp: ${r.stderr}');
      });

  // The phone's app on the account, as it runs: its newest given to the
  // relay at login when the relay is behind, newer ones taken.
  Future<HostedAccount> run(HostedRelay relay, MemoryKeyStore store, MemoryPrefs prefs) async {
    final open = (await openAccount(e2e: e2e, store: store, values: prefs, relay: hostedRelayKey(relay.origin)))!;
    final run = HostedRun(e2e: e2e, open: open, toClient: (_) {}, relayState: (_) {}, values: prefs);
    addTearDown(run.dispose);
    AppHostedDevices(e2e: e2e, run: run, values: prefs, counter: MemoryCounter());
    run.start();
    return open.account;
  }

  // The counter of the relay's newest, as a login's Welcome gives it.
  Future<Int64> relayCounter(OpenAccount open) async {
    final a = open.account;
    final link = await HostedLink.connect(origin: a.origin, publicKey: open.main.signing.publicKey, sign: (m) async => open.main.sign(m), accountId: a.accountId);
    await link.close();
    return link.welcome.listCounter;
  }

  test('a relay that lost versions the phone holds takes the phone\'s newest as it is', () async {
    final (relay, store, prefs, backup, one, two) = await threeVersions();
    final marks = [one.lines.length, two.lines.length];
    await restore(relay, backup);

    final a = await run(relay, store, prefs);
    expect(a.newest.counter, Int64(3));
    final newest = a.newest.bytes;
    final keys = (await openAccount(e2e: e2e, store: store, values: prefs, relay: hostedRelayKey(relay.origin)))!;
    addTearDown(keys.dispose);
    for (var i = 0; i < 100 && await relayCounter(keys) < Int64(3); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    expect(await relayCounter(keys), Int64(3));
    // Taken as signed: no version signed again.
    expect(a.newest.counter, Int64(3));
    expect(a.newest.bytes, newest);
    for (final (i, c) in [one, two].indexed) {
      await waitFor(() => c.lines.skip(marks[i]).contains('status ready'), what: 'computer ${i + 1} ready again: ${c.lines.skip(marks[i]).join(' / ')}');
      expect(c.lines.skip(marks[i]), isNot(contains('status removed')));
    }
  }, skip: !ready);

  test('a removal the relay took and then lost comes back from a computer that holds it', () async {
    final (relay, store, prefs, backup, one, two) = await threeVersions();
    // The phone removes computer two, and the relay takes version 4, but
    // the phone never hears it taken: its newest stays version 3.
    final open = (await openAccount(e2e: e2e, store: store, values: prefs, relay: hostedRelayKey(relay.origin)))!;
    addTearDown(open.dispose);
    final a = open.account;
    final v3 = a.newest;
    final twoKey = v3.body.devices.last.signingKey;
    final kept = v3.body.devices.where((d) => !bytesEqual(d.signingKey, twoKey)).toList();
    expect(kept, hasLength(v3.body.devices.length - 1));
    final v4 = e2e.makeList(phone: open.main.signing, devices: kept, previousBody: Uint8List.sublistView(v3.bytes, signatureBytes), accountId: a.accountId, counter: Int64(4));
    final link = await HostedLink.connect(origin: a.origin, publicKey: open.main.signing.publicKey, sign: (m) async => open.main.sign(m), accountId: a.accountId);
    final done = link.frames.firstWhere((f) => f.hasDone() && f.done.requestId == 'r4');
    link.send(v2.Frame(publishList: v2.PublishList(requestId: 'r4', list: v4)));
    await done.timeout(const Duration(seconds: 10));
    await link.close();
    await two.until((l) => l == 'status removed');
    final mark = one.lines.length;

    // The relay back at version 1, and the phone's app started with
    // version 3 as its newest.
    await restore(relay, backup);
    final running = await run(relay, store, prefs);
    expect(running.newest.counter, Int64(3));
    for (var i = 0; i < 100 && running.newest.counter < Int64(4); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    // Version 4 everywhere, computer two not on it.
    expect(running.newest.counter, Int64(4));
    expect(running.newest.bytes, v4);
    expect(await relayCounter(open), Int64(4));
    await waitFor(() => one.lines.skip(mark).contains('status ready'), what: 'computer one ready again: ${one.lines.skip(mark).join(' / ')}');
    expect(one.lines.skip(mark), isNot(anyOf(contains('status removed'), contains(startsWith('status conflict')))));
  }, skip: !ready);
}
