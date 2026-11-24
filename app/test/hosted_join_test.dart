// Joins against the Go relay in its hosted mode (lib/hosted/join.dart): the
// app as the account's phone adding a computer and a browser that run the
// TypeScript of relay-client/join.ts (extension/test/join-device.ts), so
// that the two languages meet over a real relay; and adding a second phone
// that runs the app's own side. Then what each side refuses.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/bytes.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';
import 'package:pirc/gen/pirc/v1alpha2/relay.pb.dart';
import 'package:pirc/hosted/join.dart';
import 'package:pirc/hosted/link.dart';

import 'support/relay.dart';

final hasNode = Process.runSync('sh', ['-c', 'command -v node']).exitCode == 0;

// A phone's keys, all five, made here.
class Keys {
  Keys(SodiumSumo sodium)
      : signing = sodium.crypto.sign.keyPair(),
        readOnly = sodium.crypto.sign.keyPair(),
        channel = sodium.crypto.box.keyPair(),
        box = sodium.crypto.box.keyPair(),
        notification = sodium.crypto.box.keyPair();
  final KeyPair signing, readOnly, channel, box, notification;

  Device get device => Device(
        role: roleClient,
        signingKey: signing.publicKey,
        channelKey: channel.publicKey,
        boxKey: box.publicKey,
        readOnlyKey: readOnly.publicKey,
        notificationKey: notification.publicKey,
      );
}

// A new device in TypeScript: its code's text, then how its join ended.
class TsDevice {
  TsDevice._(this._proc, this._lines);
  final Process _proc;
  final StreamIterator<String> _lines;

  static Future<TsDevice> start(String origin, String role) async {
    final proc = await Process.start('node', ['--experimental-transform-types', '--no-warnings', '../extension/test/join-device.ts', origin, role]);
    proc.stderr.transform(utf8.decoder).listen((s) => stderr.write(s));
    return TsDevice._(proc, StreamIterator(proc.stdout.transform(utf8.decoder).transform(const LineSplitter())));
  }

  Future<String> line() async {
    if (!await _lines.moveNext().timeout(const Duration(seconds: 30))) throw StateError('join-device.ts ended');
    return _lines.current;
  }

  void kill() => _proc.kill();
}

void main() {
  if (!hasGo || !hasNode) {
    test('joins against the hosted relay', () {}, skip: 'needs go and node on PATH');
    return;
  }
  late E2e e2e;
  late SodiumSumo sodium;
  late HostedRelay relay;
  late Directory dir;
  late Keys phone;
  late HostedLink link;
  late Stream<Frame> frames;
  late PhoneAccount account;
  final cleanup = <void Function()>[];

  Future<Uint8List> sign(KeyPair k, Uint8List m) async => sodium.crypto.sign.detached(message: m, secretKey: k.secretKey);

  setUpAll(() async {
    e2e = await E2e.load();
    sodium = e2e.sodium;
    dir = Directory.systemTemp.createTempSync('pirc-hosted-join-');
    relay = await HostedRelay.start(dir);
    phone = Keys(sodium);
    final v1 = e2e.makeList(phone: phone.signing, devices: [phone.device], counter: Int64.ONE);
    final signup = await HostedLink.connect(origin: relay.origin, publicKey: phone.signing.publicKey, sign: (m) => sign(phone.signing, m));
    signup.send(Frame(signUp: SignUp(requestId: 's', attestation: Attestation(test: [1]), list: v1)));
    final up = await signup.frames.firstWhere((f) => f.hasSignedUp() || f.hasError()).timeout(const Duration(seconds: 10));
    expect(up.hasSignedUp(), isTrue, reason: up.error.message);
    await signup.close();
    final accountId = e2e.sha256(Uint8List.sublistView(v1, signatureBytes));
    link = await HostedLink.connect(origin: relay.origin, publicKey: phone.signing.publicKey, sign: (m) => sign(phone.signing, m), accountId: accountId);
    frames = link.frames.asBroadcastStream();
    account = PhoneAccount(accountId: accountId, phone: phone.device, signing: phone.signing, channel: phone.channel.secretKey, first: v1, newest: v1, name: 'Pixel 9');
  });

  tearDownAll(() async {
    for (final c in cleanup) {
      c();
    }
    await link.close();
    relay.kill();
    dir.deleteSync(recursive: true);
  });

  // The code looked up until the new device's wait has reached the relay.
  Future<(AddDevice, Offered)> add(String text, {Device Function(Device)? listedAs}) async {
    for (var i = 0;; i++) {
      final a = AddDevice(e2e: e2e, account: account, frames: frames, send: link.send, listedAs: listedAs);
      try {
        return (a, await a.start(text));
      } on JoinFailed catch (e) {
        if (!e.message.startsWith('no device shows') || i > 20) rethrow;
        await Future<void>.delayed(const Duration(milliseconds: 150));
      }
    }
  }

  Future<void> confirmed(AddDevice a) async {
    final list = await a.confirm();
    account = PhoneAccount(accountId: account.accountId, phone: account.phone, signing: account.signing, channel: account.channel, first: account.first, newest: list, name: account.name);
  }

  Future<TsDevice> ts(String role) async {
    final d = await TsDevice.start(relay.origin, role);
    cleanup.add(d.kill);
    return d;
  }

  test('the phone adds a computer that runs the TypeScript: it offers itself as a computer, and joins once confirmed', () async {
    final d = await ts('computer');
    final (a, offered) = await add(await d.line());
    expect(offered.isComputer, isTrue);
    await confirmed(a);
    final ended = await d.line();
    expect(ended, 'joined ${hexOf(account.accountId)} 2 Pixel 9');
    final body = ListBody.fromBuffer(Uint8List.sublistView(account.newest, signatureBytes));
    expect(body.devices.map((x) => x.role), [roleClient, roleComputer]);
  });

  test('the phone adds a browser: a client without a read-only key, not a phone', () async {
    final d = await ts('browser');
    final (a, offered) = await add(await d.line());
    expect(offered.isComputer, isFalse);
    expect(offered.isPhone, isFalse);
    await confirmed(a);
    expect(await d.line(), 'joined ${hexOf(account.accountId)} 3 Pixel 9');
  });

  test('declined at the phone: nothing published, and the device says the phone ended it', () async {
    final d = await ts('computer');
    final before = account.newest;
    final (a, offered) = await add(await d.line());
    expect(offered.isComputer, isTrue);
    a.cancel();
    expect(await d.line(), 'failed: the phone ended the join');
    expect(account.newest, before);
  });

  test('a code with its secret changed: the device refuses it at the third step, and the phone learns', () async {
    final d = await ts('computer');
    final text = await d.line();
    final wrong = '${text.substring(0, 13)}${text[13] == '0' ? '1' : '0'}${text.substring(14)}';
    await expectLater(add(wrong), throwsA(isA<JoinFailed>().having((e) => e.message, 'message', startsWith('the device ended the join'))));
    expect(await d.line(), startsWith('failed: the code did not match'));
  });

  test('not a code, or no device waiting under it', () async {
    final a = AddDevice(e2e: e2e, account: account, frames: frames, send: link.send);
    await expectLater(a.start('hello'), throwsA(isA<JoinFailed>().having((e) => e.message, 'message', 'that is not a PiRC join code')));
    final b = AddDevice(e2e: e2e, account: account, frames: frames, send: link.send);
    await expectLater(b.start('PIRC1VTPVXVT2000G40R40M30E209185GR38E1W8124GK2GAHC5RR34D1P70X3RFG'), throwsA(isA<JoinFailed>().having((e) => e.message, 'message', startsWith('no device shows'))));
  });

  test('a second phone joins as a client with all five keys, and logs in to the account', () async {
    final second = Keys(sodium);
    final waiting = await HostedLink.connect(origin: relay.origin, publicKey: second.signing.publicKey, sign: (m) => sign(second.signing, m));
    final j = PhoneJoin(
      e2e: e2e,
      self: second.device,
      channel: second.channel.secretKey,
      frames: waiting.frames,
      send: waiting.send,
      random: (n) => sodium.randombytes.buf(n),
      sign: (m) => sodium.crypto.sign.detached(message: m, secretKey: second.signing.secretKey),
      attestation: Attestation(test: [1]),
    );
    final done = j.done();
    final (a, offered) = await add(j.text);
    expect(offered.isPhone, isTrue);
    expect(bytesEqual(offered.device.readOnlyKey, second.readOnly.publicKey), isTrue);
    await confirmed(a);
    final joined = await done;
    await waiting.close();
    expect(joined.accountId, account.accountId);
    expect(joined.phoneKey, phone.signing.publicKey);
    expect(joined.counter, Int64(4));
    expect(joined.phoneName, 'Pixel 9');
    final in_ = await HostedLink.connect(origin: relay.origin, publicKey: second.signing.publicKey, sign: (m) => sign(second.signing, m), accountId: joined.accountId, listCounter: joined.counter);
    await in_.close();

    // The same phone again: refused at the account's phone, before anything is signed.
    final again = await HostedLink.connect(origin: relay.origin, publicKey: second.signing.publicKey, sign: (m) => sign(second.signing, m));
    final j2 = PhoneJoin(
      e2e: e2e,
      self: second.device,
      channel: second.channel.secretKey,
      frames: again.frames,
      send: again.send,
      random: (n) => sodium.randombytes.buf(n),
      sign: (m) => sodium.crypto.sign.detached(message: m, secretKey: second.signing.secretKey),
      attestation: Attestation(test: [1]),
    );
    final ended = expectLater(j2.done(), throwsA(isA<JoinFailed>().having((e) => e.message, 'message', 'the phone ended the join')));
    final before = account.newest;
    await expectLater(add(j2.text), throwsA(isA<JoinFailed>().having((e) => e.message, 'message', 'that device is on the list already')));
    await ended;
    expect(account.newest, before);
    await again.close();
  });

  test('a second phone refuses a list that holds it with another key, and a code past its ten minutes', () async {
    final second = Keys(sodium);
    final waiting = await HostedLink.connect(origin: relay.origin, publicKey: second.signing.publicKey, sign: (m) => sign(second.signing, m));
    // The phone lists it with another box key than the one it offered.
    final other = Keys(sodium);
    final j = PhoneJoin(
      e2e: e2e,
      self: second.device,
      channel: second.channel.secretKey,
      frames: waiting.frames,
      send: waiting.send,
      random: (n) => sodium.randombytes.buf(n),
      sign: (m) => sodium.crypto.sign.detached(message: m, secretKey: second.signing.secretKey),
      attestation: Attestation(test: [1]),
    );
    final done = j.done();
    final (a, _) = await add(j.text, listedAs: (d) => d.deepCopy()..boxKey = other.box.publicKey);
    await confirmed(a);
    await expectLater(done, throwsA(isA<JoinFailed>().having((e) => e.message, 'message', 'the list was refused (self)')));
    await waiting.close();

    var clock = DateTime.now();
    final late = await HostedLink.connect(origin: relay.origin, publicKey: second.signing.publicKey, sign: (m) => sign(second.signing, m));
    final k = PhoneJoin(
      e2e: e2e,
      self: second.device,
      channel: second.channel.secretKey,
      frames: late.frames,
      send: late.send,
      random: (n) => sodium.randombytes.buf(n),
      sign: (m) => sodium.crypto.sign.detached(message: m, secretKey: second.signing.secretKey),
      attestation: Attestation(test: [1]),
      now: () => clock,
    );
    final expired = k.done();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    clock = clock.add(const Duration(minutes: 10));
    final settled = expectLater(expired, throwsA(isA<JoinFailed>().having((e) => e.message, 'message', contains('expired'))));
    await expectLater(add(k.text), throwsA(isA<JoinFailed>()));
    await settled;
    await late.close();
  });
}
