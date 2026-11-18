// Joining by a link: reading it, and joining the Go relay with it; and
// following the relay to a new address (those against the relay skipped,
// saying so, without go).
import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/join.dart';
import 'package:pirc/keys/key_holder.dart';
import 'package:pirc/keys/key_store.dart';
import 'package:pirc/relay/connection.dart';

import 'support/relay.dart';

void main() {
  test('a join link gives the relay and the token; anything else is not one', () {
    final l = parseJoinLink(' pirc://join?relay=${Uri.encodeComponent('wss://relay.example')}&token=abc%2Bdef ')!;
    expect((l.relay, l.token), ('wss://relay.example', 'abc+def'));
    for (final bad in [
      'https://relay.example',
      'pirc://join?relay=wss%3A%2F%2Frelay.example',
      'pirc://join?relay=https%3A%2F%2Frelay.example&token=t',
      'pirc://other?relay=wss%3A%2F%2Frelay.example&token=t',
      'not a link',
    ]) {
      expect(parseJoinLink(bad), isNull, reason: bad);
    }
  });

  test('a key that cannot be locked fails the join, and keeps nothing', () async {
    final store = _NoPasscode();
    await expectLater(
      join(const JoinLink('ws://127.0.0.1:9', 't'), store),
      throwsA(isA<JoinFailed>().having((e) => e.reason, 'reason', 'Set a passcode on this phone to lock PiRC')),
    );
    expect(await store.load('ws://127.0.0.1:9', KeyKind.read), isNull);
  });

  group('against the relay', () {
    late Directory dir;
    late Relay relay;
    setUpAll(() async {
      if (!hasGo) return;
      dir = await Directory.systemTemp.createTemp('pirc-app-join-');
      relay = await Relay.start(dir);
    });
    tearDownAll(() async {
      if (!hasGo) return;
      relay.kill();
      await dir.delete(recursive: true);
    });
    const skip = 'skipped: needs go on PATH';

    test('a link joins: the phone and its read-only key are registered', () async {
      final store = MemoryKeyStore();
      final link = JoinLink(relay.url, relay.cmd('add-client', ['--label', 'phone']));
      final keys = await join(link, store);
      expect(await store.load(relay.url, KeyKind.read), keys.read.seed);
      final list = relay.cmd('list', []);
      expect(list, contains('phone'));
    }, skip: hasGo ? false : skip);

    test('a link used twice fails the second time and keeps nothing', () async {
      final link = JoinLink(relay.url, relay.cmd('add-client', ['--label', 'once']));
      await join(link, MemoryKeyStore());
      final store = MemoryKeyStore();
      await expectLater(join(link, store), throwsA(isA<JoinFailed>().having((e) => e.reason, 'reason', contains('used or has expired'))));
      expect(await store.load(relay.url, KeyKind.main), isNull);
    }, skip: hasGo ? false : skip);

    test('the relay moved to another port: the phone follows it there with its keys', () async {
      final store = MemoryKeyStore();
      final keys = await join(JoinLink(relay.url, relay.cmd('add-client', ['--label', 'mover'])), store);
      final old = relay.url;
      relay = await relay.moved();
      expect(relay.url, isNot(old));
      await follow(old, relay.url, keys.main, store);
      expect(await store.load(relay.url, KeyKind.main), keys.main.seed);
      expect(await store.load(relay.url, KeyKind.read), keys.read.seed);
      expect(store.protected(relay.url), isTrue);
      // Logged in at the new port, as the app will be.
      final states = StreamController<ConnectionState>.broadcast();
      final conn = RelayConnection(url: relay.url, key: keys.main, onFrame: (_) {}, onState: states.add);
      final ready = stateOf<Ready>(states.stream);
      conn.start();
      await ready;
      conn.stop();
    }, skip: hasGo ? false : skip);

    test('an address no relay answers at, or another relay, keeps the old address and adds nothing', () async {
      final store = MemoryKeyStore();
      final keys = await join(JoinLink(relay.url, relay.cmd('add-client', ['--label', 'stayer'])), store);
      final probe = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final nowhere = 'ws://127.0.0.1:${probe.port}';
      await probe.close();
      await expectLater(
        follow(relay.url, nowhere, keys.main, store, timeout: const Duration(seconds: 3)),
        throwsA(isA<JoinFailed>().having((e) => e.reason, 'reason', startsWith('Could not reach the relay'))),
      );
      expect(await store.load(nowhere, KeyKind.main), isNull);
      final otherDir = await Directory.systemTemp.createTemp('pirc-app-other-');
      final other = await Relay.start(otherDir);
      try {
        await expectLater(
          follow(relay.url, other.url, keys.main, store),
          throwsA(isA<JoinFailed>().having((e) => e.reason, 'reason', contains("doesn't know this phone"))),
        );
        expect(await store.load(other.url, KeyKind.main), isNull);
      } finally {
        other.kill();
        await otherDir.delete(recursive: true);
      }
      expect(await store.load(relay.url, KeyKind.main), keys.main.seed);
    }, skip: hasGo ? false : skip);
  });

  test('following to a bad address, or the same, is refused before connecting', () async {
    final store = MemoryKeyStore();
    final keys = await KeyHolder.create(store, 'wss://relay.example');
    for (final (to, says) in [
      ('https://relay.example:8443', 'must start with ws:// or wss://'),
      ('relay.example', 'not a relay URL'),
      ('wss://relay.example', 'the address the phone uses now'),
    ]) {
      await expectLater(follow('wss://relay.example', to, keys.main, store), throwsA(isA<JoinFailed>().having((e) => e.reason, 'reason', contains(says))), reason: to);
    }
  });
}

// A phone with no passcode: the main key cannot be locked.
class _NoPasscode extends MemoryKeyStore {
  @override
  Future<void> store(String relay, KeyKind kind, Uint8List seed, {required bool protect}) async {
    if (protect) throw const KeyUnavailable('Set a passcode on this phone to lock PiRC');
    await super.store(relay, kind, seed, protect: protect);
  }
}
