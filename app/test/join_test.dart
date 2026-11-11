// Joining by a link: reading it, and joining the Go relay with it (skipped,
// saying so, without go).
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/join.dart';
import 'package:pirc/keys/key_store.dart';

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
