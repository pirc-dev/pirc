// The Dart relay connection and client logic against the real Go relay:
// enrolling with a token, a host's session reaching the client with its
// notice, the read-only key's limits, and an unknown key refused. Skipped,
// saying so, without go on PATH.
import 'dart:async';
import 'dart:io';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/core/client.dart';
import 'package:pirc/core/protocol.dart';
import 'package:pirc/core/view.dart';
import 'package:pirc/relay/connection.dart';
import 'package:pirc/relay/keys.dart';

import 'support/relay.dart';

void main() {
  late Directory dir;
  late Relay relay;

  setUpAll(() async {
    if (!hasGo) return;
    dir = await Directory.systemTemp.createTemp('pirc-app-relay-');
    relay = await Relay.start(dir);
  });

  tearDownAll(() async {
    if (!hasGo) return;
    relay.kill();
    await dir.delete(recursive: true);
  });

  // Printed as each test's "Skip:" line.
  const skip = 'skipped: needs go on PATH';

  test('a host\'s session reaches the client, with its notice; the read-only key reads only the list', () async {
    final hostKey = await DeviceKey.generate();
    final hostStates = StreamController<ConnectionState>.broadcast();
    final host = RelayConnection(
      url: relay.url,
      key: hostKey,
      role: Role.ROLE_HOST,
      token: relay.cmd('add-host', ['--label', 'laptop']),
      onFrame: (_) {},
      onState: hostStates.add,
    );
    final hostReady = stateOf<Ready>(hostStates.stream);
    host.start();
    await hostReady;
    final ref = SessionRef(hostKey: hostKey.publicKey, sessionId: 's1', instanceId: 'i1');
    final announcement = SessionAnnouncement(
      name: 'release',
      cwd: '/src/app',
      hostname: 'laptop.local',
      notice: Notice(number: Int64(1793700000250), kind: NoticeKind.NOTICE_KIND_QUESTION, text: 'Proceed?'),
    );
    expect(host.send(Frame(sessionAnnounce: SessionAnnounce(session: ref, payload: announcement.writeToBuffer(), push: true))), isTrue);

    // The phone: its own key, enrolled with a token, and the client logic.
    final phoneKey = await DeviceKey.generate();
    final events = StreamController<ViewEvent>.broadcast();
    final frames = StreamController<Frame>.broadcast();
    final states = StreamController<ConnectionState>.broadcast();
    late final RelayConnection phone;
    final client = Client(send: (f) => phone.send(f), onEvent: events.add, publicKey: phoneKey.publicKey);
    phone = RelayConnection(
      url: relay.url,
      key: phoneKey,
      token: relay.cmd('add-client', ['--label', 'phone']),
      onFrame: (f) {
        frames.add(f);
        client.onFrame(f);
      },
      onState: (s) {
        states.add(s);
        if (s is Ready) client.onState(const RelayView(state: 'ready'));
      },
    );
    final seen = events.stream
        .where((e) => e is SessionChanged && e.session.name == 'release')
        .cast<SessionChanged>()
        .first
        .timeout(const Duration(seconds: 10));
    final ownDevice = events.stream.where((e) => e is DevicesChanged && e.devices.any((d) => d.self)).first.timeout(const Duration(seconds: 10));
    phone.start();
    final session = (await seen).session;
    expect(session.id, viewId(ref));
    expect(session.notice?.toJson(), {'number': 1793700000250, 'kind': 'question', 'text': 'Proceed?'});
    final devices = await ownDevice;
    expect((devices as DevicesChanged).devices.where((d) => d.self).single.role, 'client');

    // Its read-only key, registered under the main one.
    final readKey = await DeviceKey.generate();
    final changed = frames.stream.firstWhere((f) => f.hasKeyChanged() || f.hasError()).timeout(const Duration(seconds: 10));
    expect(phone.send(Frame(registerReadKey: RegisterReadKey(requestId: 'rk-1', publicKey: readKey.publicKey))), isTrue);
    final answer = await changed;
    expect(answer.hasKeyChanged(), isTrue, reason: answer.toString());

    final readFrames = StreamController<Frame>.broadcast();
    final readStates = StreamController<ConnectionState>.broadcast();
    final reader = RelayConnection(url: relay.url, key: readKey, onFrame: readFrames.add, onState: readStates.add);
    final readReady = stateOf<Ready>(readStates.stream);
    reader.start();
    expect((await readReady).readOnly, isTrue);
    final list = readFrames.stream.firstWhere((f) => f.hasSessionList()).timeout(const Duration(seconds: 10));
    expect(reader.send(Frame(subscribeSessions: SubscribeSessions())), isTrue);
    final entries = (await list).sessionList.sessions;
    expect(entries.single.session.sessionId, 's1');
    expect(SessionAnnouncement.fromBuffer(entries.single.payload).notice.text, 'Proceed?');

    final refused = readFrames.stream.firstWhere((f) => f.hasError()).timeout(const Duration(seconds: 10));
    expect(reader.send(Frame(watchKeys: WatchKeys())), isTrue);
    expect((await refused).error.code, ErrorCode.ERROR_CODE_PERMISSION_DENIED);
    await Future<void>.delayed(const Duration(milliseconds: 200));
    expect(reader.current, isA<Ready>(), reason: 'the connection stays open');

    reader.stop();
    phone.stop();
    host.stop();
  }, skip: hasGo ? false : skip);

  test('a key the relay does not know, with no token, is refused and not retried', () async {
    final states = StreamController<ConnectionState>.broadcast();
    final stranger = RelayConnection(url: relay.url, key: await DeviceKey.generate(), onFrame: (_) {}, onState: states.add);
    final refused = states.stream.firstWhere((s) => s is Refused).timeout(const Duration(seconds: 10));
    stranger.start();
    final r = await refused as Refused;
    expect(r.reason, isNotEmpty);
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect(stranger.current, isA<Refused>());
  }, skip: hasGo ? false : skip);
}
