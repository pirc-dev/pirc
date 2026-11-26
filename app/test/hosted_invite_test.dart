// Sign-ups by invite (relay/internal/hosted/invites.go): the app asks the
// relay's mode and the code's state before anything is bought
// (hosted/setup.dart, checkInvite), and signs up with the code.
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import 'package:pirc/app/app.dart' show MemoryPrefs;
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart' as v2;
import 'package:pirc/hosted/setup.dart';
import 'package:pirc/keys/key_store.dart';

import 'support/relay.dart';

Future<v2.Attestation> testAttest(String origin, Uint8List nonce, Uint8List key) async => v2.Attestation(test: [1]);

void main() {
  late Directory dir;
  late HostedRelay relay;
  late E2e e2e;
  setUpAll(() async {
    if (!hasGo) return;
    e2e = await E2e.load();
    dir = await Directory.systemTemp.createTemp('pirc-hosted-invite-');
    relay = await HostedRelay.start(dir);
  });
  tearDownAll(() async {
    if (!hasGo) return;
    relay.kill();
    await dir.delete(recursive: true);
  });

  Future<OpenAccount> up(String code) => signUp(e2e: e2e, store: MemoryKeyStore(), values: MemoryPrefs(), origin: relay.origin, attest: testAttest, protect: false, inviteCode: code);

  test('by invite: the mode and the code asked first, then a sign-up that uses it', () async {
    expect((await checkInvite(e2e: e2e, origin: relay.origin)).mode, v2.SignUpMode.SIGN_UP_MODE_OPEN);
    relay.cmd('signups-hosted', ['invite']);
    expect((await checkInvite(e2e: e2e, origin: relay.origin)).mode, v2.SignUpMode.SIGN_UP_MODE_INVITE);
    await expectLater(up(''), throwsA(isA<SignUpFailed>().having((e) => e.message, 'message', contains('need an invite code'))));

    final code = relay.cmd('invite-hosted', ['--uses', '1']);
    final ok = await checkInvite(e2e: e2e, origin: relay.origin, code: code.toLowerCase());
    expect((ok.mode, ok.valid, ok.review), (v2.SignUpMode.SIGN_UP_MODE_INVITE, true, false));
    (await up(code)).dispose();
    expect((await checkInvite(e2e: e2e, origin: relay.origin, code: code)).valid, isFalse);
    await expectLater(up(code), throwsA(isA<SignUpFailed>().having((e) => e.message, 'message', contains('not valid'))));

    final review = relay.cmd('invite-hosted', ['--review', '--uses', '2', '--note', 'App Review']);
    final r = await checkInvite(e2e: e2e, origin: relay.origin, code: review);
    expect((r.valid, r.review), (true, true));
    final open = await up(review);
    addTearDown(open.dispose);
    expect(relay.cmd('invites-hosted'), contains('review  1 left'));

    relay.cmd('signups-hosted', ['closed']);
    expect((await checkInvite(e2e: e2e, origin: relay.origin)).mode, v2.SignUpMode.SIGN_UP_MODE_CLOSED);
    await expectLater(up(review), throwsA(isA<SignUpFailed>().having((e) => e.message, 'message', contains('closed'))));
    relay.cmd('signups-hosted', ['open']);
  }, skip: !hasGo);
}
