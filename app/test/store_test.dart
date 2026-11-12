// The subscription's Dart half (lib/app/store.dart): what the plugin's
// answers mean, over a mocked channel. The plugin itself is tested against
// StoreKit's test store (ios/RunnerTests/StoreTests.swift).
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/store.dart';

const channel = MethodChannel('test/store');

ChannelStore answering(Object? Function(MethodCall) answer) {
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async => answer(call));
  addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
  return ChannelStore(channel);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final ends = DateTime.utc(2026, 11, 22);
  final grace = DateTime.utc(2026, 12, 8);

  test('a build from source, as the tests are, has no subscription', () {
    expect(storeBuild, isFalse);
    expect(subscriptionFor(TargetPlatform.iOS), isNull);
    expect(subscriptionFor(TargetPlatform.android), isNull);
  });

  test("a store build has the App Store's or Google Play's, and none elsewhere", () {
    expect(subscriptionFor(TargetPlatform.iOS, store: true), isA<ChannelStore>());
    expect(subscriptionFor(TargetPlatform.android, store: true), isA<ChannelStore>());
    expect(subscriptionFor(TargetPlatform.macOS, store: true), isNull);
  });

  test('the free trial is allowed', () async {
    final store = answering((_) => {'state': 'allowed', 'trial': true, 'ends': ends.millisecondsSinceEpoch, 'renews': true});
    final s = await store.status();
    expect(s.access, Access.allowed);
    expect(s.trial, isTrue);
    expect(s.renews, isTrue);
    expect(s.ends, ends);
  });

  test('in grace, with when it ends', () async {
    final s = await answering((_) => {'state': 'allowed', 'graceEnds': grace.millisecondsSinceEpoch}).status();
    expect(s.access, Access.allowed);
    expect(s.trial, isFalse);
    expect(s.ends, isNull);
    expect(s.graceEnds, grace);
  });

  test('offline, renewal is unknown', () async {
    final store = answering((_) => {'state': 'allowed', 'ends': ends.millisecondsSinceEpoch});
    expect((await store.status()).renews, isNull);
  });

  test('not allowed: a payment problem, ended or never', () async {
    for (final (state, access) in [('payment', Access.payment), ('ended', Access.ended), ('never', Access.never)]) {
      final s = await answering((_) => {'state': state, 'ends': ends.millisecondsSinceEpoch}).status();
      expect(s.access, access);
    }
  });

  test('the product with the trial this account can still have, or without', () async {
    final offered = await answering((_) => {'price': '£19.99', 'trial': {'count': 2, 'unit': 'week'}}).product();
    expect(offered!.price, '£19.99');
    expect(offered.trial, (count: 2, unit: 'week'));
    final had = await answering((_) => {'price': '£19.99'}).product();
    expect(had!.trial, isNull);
    expect(await answering((_) => null).product(), isNull);
  });

  test('buying: bought, waiting for approval, or cancelled', () async {
    for (final (answer, bought) in [('bought', Bought.bought), ('pending', Bought.pending), ('cancelled', Bought.cancelled)]) {
      expect(await answering((_) => answer).buy(), bought);
    }
  });

  test('a change outside a purchase is told', () async {
    final store = answering((_) => null);
    final told = expectLater(store.changed, emits(null));
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.handlePlatformMessage(channel.name, channel.codec.encodeMethodCall(const MethodCall('changed')), (_) {});
    await told;
  });
}
