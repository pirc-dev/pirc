// The platform's halves of the key store (packages/pirc_platform), on a
// phone or simulator:
//   flutter test integration_test -d <device>
// A protected main key asks for the person, so it is left out here; on a
// phone without a passcode (--dart-define=NO_PASSCODE=true), storing one
// says so.
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:pirc/keys/key_store.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  final store = ChannelKeyStore();
  const relay = 'wss://relay.test/v1alpha1';
  final main = Uint8List.fromList(List.generate(32, (i) => i));
  final read = Uint8List.fromList(List.generate(32, (i) => 255 - i));

  tearDown(() => store.delete(relay));

  testWidgets('keeps, gives back and forgets both keys', (_) async {
    expect(await store.load(relay, KeyKind.main), isNull);
    await store.store(relay, KeyKind.main, main, protect: false);
    await store.store(relay, KeyKind.read, read, protect: false);
    expect(await store.load(relay, KeyKind.main), main);
    expect(await store.load(relay, KeyKind.read), read);
    expect(await store.load('wss://other.test', KeyKind.read), isNull);
    await store.delete(relay);
    expect(await store.load(relay, KeyKind.main), isNull);
    expect(await store.load(relay, KeyKind.read), isNull);
  });

  testWidgets('a key stored again replaces the one before', (_) async {
    await store.store(relay, KeyKind.read, main, protect: false);
    await store.store(relay, KeyKind.read, read, protect: false);
    expect(await store.load(relay, KeyKind.read), read);
  });

  testWidgets('a protected key needs a passcode on the phone', (_) async {
    if (!const bool.fromEnvironment('NO_PASSCODE')) {
      markTestSkipped('only with NO_PASSCODE, on a phone without one');
      return;
    }
    await expectLater(store.store(relay, KeyKind.main, main, protect: true), throwsA(isA<KeyUnavailable>()));
  });
}
