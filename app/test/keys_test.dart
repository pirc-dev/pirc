// The key store's channel, and the holder's unlocking and forgetting.
import 'package:fake_async/fake_async.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/keys/key_holder.dart';
import 'package:pirc/keys/key_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const relay = 'wss://relay.example/v1alpha1';

  test('the channel carries the relay, the kind and the seed, and a dismissed prompt reads as cancelled', () async {
    const channel = MethodChannel('dev.pirc.app/keys');
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (c) async {
      calls.add(c);
      if (c.method == 'load' && c.arguments['kind'] == 'main') throw PlatformException(code: 'cancelled', message: 'Face ID dismissed');
      if (c.method == 'load') return Uint8List.fromList([7, 7]);
      return null;
    });
    final store = ChannelKeyStore();
    await store.store(relay, KeyKind.read, Uint8List.fromList([1, 2]), protect: false);
    expect(await store.load(relay, KeyKind.read), [7, 7]);
    await expectLater(store.load(relay, KeyKind.main, reason: 'Unlock'), throwsA(isA<KeyUnavailable>().having((e) => e.cancelled, 'cancelled', true)));
    await store.delete(relay);
    expect([for (final c in calls) '${c.method} ${c.arguments}'], [
      'store {relay: $relay, kind: read, seed: [1, 2], protect: false}',
      'load {relay: $relay, kind: read, reason: }',
      'load {relay: $relay, kind: main, reason: Unlock}',
      'delete {relay: $relay}',
    ]);
  });

  test('joining makes two keys; only the main one asks for the person', () async {
    final store = MemoryKeyStore();
    final keys = await KeyHolder.create(store, relay);
    expect(keys.main.publicKey, isNot(keys.read.publicKey));
    expect((await store.load(relay, KeyKind.read))!, keys.read.seed);
    expect(store.asked, 0);
    expect((await KeyHolder(store, relay).unlock())!.publicKey, keys.main.publicKey);
    expect(store.asked, 1);
  });

  test('an unlocked key is held while in use and forgotten after the time; declining unlocks nothing', () {
    fakeAsync((async) {
      final store = MemoryKeyStore();
      late KeyHolder holder;
      KeyHolder.create(store, relay).then((_) => holder = KeyHolder(store, relay, holdFor: const Duration(minutes: 30)));
      async.flushMicrotasks();
      holder.unlock();
      async.flushMicrotasks();
      expect(store.asked, 1);
      async.elapse(const Duration(minutes: 20));
      holder.unlock(); // in use: held for another 30 minutes
      async.flushMicrotasks();
      async.elapse(const Duration(minutes: 20));
      expect(holder.held, isTrue);
      expect(store.asked, 1);
      async.elapse(const Duration(minutes: 11));
      expect(holder.held, isFalse);
      store.decline = true;
      Object? error;
      holder.unlock().then((_) {}, onError: (Object e) { error = e; });
      async.flushMicrotasks();
      expect(error, isA<KeyUnavailable>());
      expect(holder.held, isFalse);
    });
  });

  test('with the lock off, the main key is kept unprotected and never asks', () async {
    final store = MemoryKeyStore();
    await KeyHolder.create(store, relay, protect: false);
    await KeyHolder(store, relay).unlock();
    expect(store.asked, 0);
  });
}
