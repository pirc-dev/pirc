// A hosted account's sessions in the app (lib/hosted/sessions.dart) against
// the Go relay in its hosted mode, with a real computer on the other end:
// the extension's Hosted, joined by `/pirc join`'s code
// (extension/test/hosted-computer.ts). The phone signs up, adds the
// computer, and the app's Client sees its session from the sealed copy and
// then over a channel; a request is answered; a newer list reaches the
// computer through a channel; a removal ends the session.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/core/client.dart';
import 'package:pirc/core/protocol.dart' as v1;
import 'package:pirc/core/view.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart';
import 'package:pirc/hosted/account.dart';
import 'package:pirc/hosted/connection.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/keys.dart';
import 'package:pirc/hosted/link.dart';
import 'package:pirc/hosted/sessions.dart';

import 'support/relay.dart';

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

Uint8List _seed() => Uint8List.fromList(List.generate(32, (i) => (i * 7 + DateTime.now().microsecond) & 0xff));

void main() {
  if (!hasGo || !hasNode) {
    test('hosted sessions against the relay', () {}, skip: 'needs go and node on PATH');
    return;
  }
  late E2e e2e;
  late SodiumSumo sodium;
  late HostedRelay relay;
  late Directory dir;
  late MainKeys main;
  late ReadKeys read;
  late HostedAccount account;
  late TsComputer computer;
  final counter = MemoryCounter();

  setUpAll(() async {
    e2e = await E2e.load();
    sodium = e2e.sodium;
    dir = Directory.systemTemp.createTempSync('pirc-hosted-sessions-');
    relay = await HostedRelay.start(dir);
    main = MainKeys.fromSeed(sodium, _seed());
    read = ReadKeys.fromSeed(sodium, Uint8List.fromList(_seed().reversed.toList()));
    final self = phoneDevice(main, read);
    final v1List = e2e.makeList(phone: main.signing, devices: [self], counter: Int64.ONE);
    final signup = await HostedLink.connect(origin: relay.origin, publicKey: main.signing.publicKey, sign: (m) async => main.sign(m));
    signup.send(Frame(signUp: SignUp(requestId: 's', attestation: Attestation(test: [1]), list: v1List)));
    final up = await signup.frames.firstWhere((f) => f.hasSignedUp() || f.hasError()).timeout(const Duration(seconds: 10));
    expect(up.hasSignedUp(), isTrue, reason: up.error.message);
    await signup.close();
    account = await HostedAccount.create(e2e, MemoryValues(),
        origin: relay.origin, accountId: Uint8List.fromList(up.signedUp.accountId), phoneKey: main.signing.publicKey, self: self, first: v1List, newest: v1List);

    // The computer joins: its code added by this phone, as part 7's screen does.
    computer = await TsComputer.start(relay.origin);
    final text = await computer.until((l) => l.startsWith('PIRC1'));
    final link = await HostedLink.connect(origin: relay.origin, publicKey: main.signing.publicKey, sign: (m) async => main.sign(m), accountId: account.accountId);
    final frames = link.frames.asBroadcastStream();
    final phone = PhoneAccount(
      accountId: account.accountId,
      phone: self,
      signing: main.signing,
      channel: main.channel.secretKey,
      first: account.first,
      newest: account.newest.bytes,
      name: 'Pixel 9',
      counter: counter.next,
    );
    for (var i = 0;; i++) {
      final a = AddDevice(e2e: e2e, account: phone, frames: frames, send: link.send);
      try {
        await a.start(text);
        expect(await account.take(await a.confirm()), isA<TakenNewer>());
        break;
      } on JoinFailed catch (e) {
        if (!e.message.startsWith('no device shows') || i > 20) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
    }
    await link.close();
    await computer.until((l) => l == 'status ready');
  });

  tearDownAll(() {
    computer.kill();
    relay.kill();
    dir.deleteSync(recursive: true);
  });

  // The app's Client over the account's sessions and a live connection.
  // With publish false, the phone gives the relay no version of the list.
  ({Client client, HostedSessions sessions, HostedConnection conn, List<ViewEvent> events}) connect({bool publish = true}) {
    final events = <ViewEvent>[];
    late final Client client;
    late final HostedSessions sessions;
    final conn = HostedConnection(
      origin: account.origin,
      accountId: account.accountId,
      publicKey: main.signing.publicKey,
      sign: (m) async => main.sign(m),
      listCounter: () => account.newest.counter,
      onFrame: (f) => sessions.onFrame(f),
      onState: (s) => sessions.onState(s),
      minBackoff: const Duration(milliseconds: 50),
    );
    sessions = HostedSessions(e2e: e2e, account: account, main: main, sendRelay: (f) => (publish || !f.hasPublishList()) && conn.send(f), toClient: (f) => client.onFrame(f), relayState: (r) => client.onState(r));
    client = Client(send: sessions.fromClient, onEvent: events.add, publicKey: main.signing.publicKey);
    conn.start();
    return (client: client, sessions: sessions, conn: conn, events: events);
  }

  Future<T> until<T>(String what, T? Function() find, {Duration timeout = const Duration(seconds: 15)}) async {
    final deadline = DateTime.now().add(timeout);
    for (;;) {
      final v = find();
      if (v != null) return v;
      if (DateTime.now().isAfter(deadline)) throw TimeoutException('waiting for $what');
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
  }

  test('the session is seen, sealed then whole, a request is answered, and events come', () async {
    final c = connect();
    addTearDown(() {
      c.sessions.dispose();
      c.conn.stop();
    });
    final s = await until('the session', () => c.client.snapshot().sessions.where((s) => s.name == 'fix the build').firstOrNull);
    expect(s.hostLabel, 'build box');
    expect(s.cwd, '/work');
    // The whole announcement, over the channel: the sealed one has no hostname.
    final whole = await until('the whole announcement', () => c.client.snapshot().sessions.where((s) => s.hostname == 'build-box').firstOrNull);
    expect(whole.working, isTrue);
    expect(whole.model?.name, 'Model One');

    final reply = await c.client.ask(whole.id, v1.SessionMessage(listPastSessions: v1.ListPastSessions(requestId: 'r1')));
    expect(reply.error.message, 'echo listPastSessions');
    await computer.until((l) => l == 'request listPastSessions 0190aaaa-0000-7000-8000-000000000001');

    // A live event, over every channel.
    computer.say('progress compiling');
    await until('the event', () => c.events.whereType<ToolProgressChanged>().where((e) => e.id == whole.id && e.text == 'compiling').firstOrNull);

    computer.say('name fix the tests');
    await until('the new name', () => c.client.snapshot().sessions.where((s) => s.name == 'fix the tests').firstOrNull);

    // The devices: this phone and the computer, from the list.
    final devices = await until('the devices', () => c.client.snapshot().devices.length == 2 ? c.client.snapshot().devices : null);
    expect(devices.where((d) => d.self).single.role, 'client');
    expect(devices.where((d) => d.role == 'host').single.online, isTrue);
  });

  test('a newer list this phone has reaches the computer through a channel, and the relay from it', () async {
    // A version the relay does not have: this phone takes it, and tells
    // only the computer, by its next channel.
    final other = sodium.crypto.sign.keyPair();
    final extra = Device(
      role: roleClient,
      signingKey: other.publicKey,
      channelKey: sodium.crypto.box.keyPair().publicKey,
      boxKey: sodium.crypto.box.keyPair().publicKey,
    );
    final body = Uint8List.sublistView(account.newest.bytes, signatureBytes);
    final next = e2e.makeList(
      phone: main.signing,
      devices: [...account.newest.body.devices, extra],
      previousBody: body,
      accountId: account.accountId,
      counter: await counter.next(account.newest.counter + 1),
    );
    expect(await account.take(next), isA<TakenNewer>());
    final want = account.newest.counter;

    // The phone tells the relay nothing: only a channel can give the
    // computer the version, as its first frame, and the computer then
    // gives it to the relay.
    final c = connect(publish: false);
    addTearDown(() {
      c.sessions.dispose();
      c.conn.stop();
    });
    await computer.until((l) => l == 'list $want');
    await until('the computer at the newest', () => c.sessions.hostCounters.values.contains(want) ? true : null);
    final l = await HostedLink.connect(origin: relay.origin, publicKey: main.signing.publicKey, sign: (m) async => main.sign(m), accountId: account.accountId);
    await l.close();
    expect(l.welcome.listCounter, want);
  });

  test('the computer removed: its session ends', () async {
    final c = connect();
    addTearDown(() {
      c.sessions.dispose();
      c.conn.stop();
    });
    await until('the session', () => c.client.snapshot().sessions.isNotEmpty ? true : null);
    final body = Uint8List.sublistView(account.newest.bytes, signatureBytes);
    final next = e2e.makeList(
      phone: main.signing,
      devices: [for (final d in account.newest.body.devices) if (d.role != roleComputer) d],
      previousBody: body,
      accountId: account.accountId,
      counter: await counter.next(account.newest.counter + 1),
    );
    final link = await HostedLink.connect(origin: relay.origin, publicKey: main.signing.publicKey, sign: (m) async => main.sign(m), accountId: account.accountId);
    link.send(Frame(publishList: PublishList(requestId: 'rm', list: next)));
    await link.frames.firstWhere((f) => f.hasDone()).timeout(const Duration(seconds: 10));
    await link.close();
    await until('the session gone', () => c.client.snapshot().sessions.isEmpty ? true : null);
    expect(account.newest.counter, ListBody.fromBuffer(Uint8List.sublistView(next, signatureBytes)).counter);
    await computer.until((l) => l == 'status removed');
  });
}
