// The app's Noise (lib/e2e/noise.dart over noise_core.dart): what the shared
// cases' bytes cannot show, as e2e/test/noise.test.ts has it for
// TypeScript. noise_cases_test.dart runs the files.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:typed_data';

import 'package:ffi/ffi.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium.ffi.dart' show LibSodiumFFI;
// ignore: implementation_imports
import 'package:sodium/src/ffi/bindings/libsodium.ffi.dart' show crypto_auth_hmacsha512_state;
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/list.dart';
import 'package:pirc/e2e/noise.dart';
import 'package:pirc/e2e/noise_core.dart';

import 'support/noise_cases.dart' show hex, unhex;

const _ffi = LibSodiumFFI();

late SodiumSumo sodium;
late Noise noise;

Uint8List secret(String name) => sodium.crypto.genericHash(message: Uint8List.fromList(utf8.encode('noise test $name')), outLen: 32);
SecureKey keyOf(Uint8List s) => sodium.secureCopy(s);

Uint8List publicOf(Uint8List s) => using((a) {
      final q = a<UnsignedChar>(32);
      final n = a<UnsignedChar>(32);
      n.cast<Uint8>().asTypedList(32).setAll(0, s);
      expect(_ffi.crypto_scalarmult_base(q, n), 0);
      return Uint8List.fromList(q.cast<Uint8>().asTypedList(32));
    });

/// ChaCha20-Poly1305 IETF straight from libsodium, with no associated data.
Uint8List aead(Uint8List m, Uint8List nonce, Uint8List k) => using((a) {
      final mp = a<UnsignedChar>(m.length + 1);
      final c = a<UnsignedChar>(m.length + 16);
      final np = a<UnsignedChar>(12);
      final kp = a<UnsignedChar>(32);
      mp.cast<Uint8>().asTypedList(m.length).setAll(0, m);
      np.cast<Uint8>().asTypedList(12).setAll(0, nonce);
      kp.cast<Uint8>().asTypedList(32).setAll(0, k);
      expect(_ffi.crypto_aead_chacha20poly1305_ietf_encrypt(c, nullptr, mp, m.length, nullptr, 0, nullptr, np, kp), 0);
      return Uint8List.fromList(c.cast<Uint8>().asTypedList(m.length + 16));
    });

bool isZero(List<int> b) => b.every((x) => x == 0);
Uint8List b(List<int> x) => Uint8List.fromList(x);

late Uint8List account;
late Uint8List clientSecret;
late Uint8List computerSecret;
late Uint8List clientPublic;
late Uint8List computerPublic;
late Uint8List psk;
final prologue = Uint8List.fromList(utf8.encode('a test prologue'));
final low = unhex('e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800');

/// A core handshake for a side, with the tests' keys; any part replaced.
Handshake core(
  NoisePattern pattern,
  bool initiator, {
  SecureKey? staticKey,
  Uint8List? remoteStatic,
  Uint8List? prologueBytes,
  Uint8List? pskBytes,
  Uint8List? ephemeral,
  bool payloads = false,
  NoiseNatives natives = const NoiseNatives(),
}) {
  final isIk = identical(pattern, ik);
  final key = staticKey ?? keyOf(initiator ? clientSecret : computerSecret);
  try {
    return Handshake(
      pattern: pattern,
      initiator: initiator,
      staticKey: key,
      remoteStatic: isIk && initiator ? (remoteStatic ?? computerPublic) : remoteStatic,
      prologue: prologueBytes ?? (isIk ? channelPrologue(account) : prologue),
      psk: isIk ? pskBytes : (pskBytes ?? Uint8List.fromList(psk)),
      ephemeral: ephemeral,
      payloads: payloads,
      natives: natives,
    );
  } finally {
    if (staticKey == null) key.dispose();
  }
}

/// A handshake to its end between two cores: the transports, the initiator's first.
(Transport, Transport) pair(NoisePattern pattern, [Handshake? i, Handshake? r]) {
  i ??= core(pattern, true);
  r ??= core(pattern, false);
  Transport? ti;
  Transport? tr;
  for (var n = 0; n < pattern.messages.length; n++) {
    final (w, rd) = n.isEven ? (i, r) : (r, i);
    final m = w.writeMessage();
    expect(m.ok, isTrue);
    final got = rd.readMessage(m.message!);
    expect(got.ok, isTrue, reason: '${got.reason}');
    for (final (h, t) in [(w, m.transport), (rd, got.transport)]) {
      if (t != null) identical(h, i) ? ti = t : tr = t;
    }
  }
  return (ti!, tr!);
}

/// A public IK handshake to its end: message 1, and both transports.
({Uint8List m1, NoiseTransport ti, NoiseTransport tr}) publicIk() {
  final ck = keyOf(clientSecret);
  final sk = keyOf(computerSecret);
  final i = noise.ikInitiator(staticKey: ck, responderKey: computerPublic, accountId: account);
  final r = noise.ikResponder(staticKey: sk, accountId: account);
  ck.dispose();
  sk.dispose();
  final m1 = i.writeMessage();
  expect(m1.ok && m1.message!.length == 96 && m1.transport == null, isTrue);
  expect(r.readMessage(m1.message!).ok, isTrue);
  final m2 = r.writeMessage();
  expect(m2.ok && m2.message!.length == 48 && m2.transport != null, isTrue);
  final done = i.readMessage(m2.message!);
  expect(done.ok && done.transport != null, isTrue);
  return (m1: m1.message!, ti: done.transport!, tr: m2.transport!);
}

Uint8List flip(Uint8List x) => Uint8List.fromList(x)..[x.length - 1] ^= 1;

void expectReason(Object r, NoiseReason want, [String? about]) {
  final reason = switch (r) {
    HandshakeResult r => r.reason,
    TransportResult r => r.reason,
    NoiseHandshakeResult r => r.reason,
    NoiseSendResult r => r.reason,
    NoiseReceiveResult r => r.reason,
    _ => throw ArgumentError('not a result'),
  };
  expect(reason, want, reason: about);
}

/// The DH stood in for: what it gives, by its return code and output.
class FakeDh extends NoiseNatives {
  FakeDh(this.rc, this.out);
  final int rc;
  final Uint8List? out;
  @override
  int scalarmult(Pointer<UnsignedChar> q, Pointer<UnsignedChar> n, Pointer<UnsignedChar> p) {
    final o = out;
    if (o == null) return super.scalarmult(q, n, p);
    q.cast<Uint8>().asTypedList(32).setAll(0, o);
    return rc;
  }
}

/// Encryption failing, as libsodium would on running out of memory.
class FailingEncrypt extends NoiseNatives {
  FailingEncrypt({this.after = 0});
  int after;
  @override
  int encrypt(Pointer<UnsignedChar> c, Pointer<UnsignedChar> m, int mlen, Pointer<UnsignedChar> ad, int adlen, Pointer<UnsignedChar> nonce, Pointer<UnsignedChar> k) {
    if (after-- > 0) return super.encrypt(c, m, mlen, ad, adlen, nonce, k);
    return -1;
  }
}

/// Every native buffer wiped while [f] runs: whether each was zero.
List<bool> wipesDuring(void Function() f) {
  final seen = <bool>[];
  noiseOnWipe = (v) => seen.add(isZero(v));
  try {
    f();
  } finally {
    noiseOnWipe = null;
  }
  return seen;
}

void main() {
  setUpAll(() async {
    final e2e = await E2e.load();
    sodium = await SodiumSumoInit.init();
    noise = e2e.noise;
    account = secret('account');
    clientSecret = secret('client');
    computerSecret = secret('computer');
    clientPublic = publicOf(clientSecret);
    computerPublic = publicOf(computerSecret);
    psk = secret('psk');
  });

  test('the HMAC state struct is libsodium\'s size, and a block holds it rounded up to 16 bytes', () {
    expect(sizeOf<crypto_auth_hmacsha512_state>(), _ffi.crypto_auth_hmacsha512_statebytes());
    expect(hmacStateBytes(416, 416), 416);
    expect(hmacStateBytes(417, 417), 432);
    expect(() => hmacStateBytes(416, 432), throwsStateError);
  });

  test('a static key that throws when read: the throw passed on, and the block made for it freed', () {
    final live = noiseLiveBlocks;
    final wipes = wipesDuring(() => expect(() => core(ik, true, staticKey: _ThrowingKey()), throwsA(isA<_Gone>())));
    expect(noiseLiveBlocks, live);
    expect(wipes.isNotEmpty && wipes.every((z) => z), isTrue);
  });

  test('the core copies the responder\'s key it is given', () {
    final given = Uint8List.fromList(computerPublic);
    final i = core(ik, true, remoteStatic: given);
    given.fillRange(0, 32, 0);
    expect(i.remoteStatic, computerPublic);
    final r = core(ik, false);
    expect(r.readMessage(i.writeMessage().message!).ok, isTrue);
    final done = i.readMessage(r.writeMessage().message!);
    expect(done.transport!.remoteStatic, computerPublic);
  });

  test('the counter: 255, 256, 2^32, 2^53+1 and 2^63-2 give libsodium\'s bytes with the nonce typed out', () {
    final byHand = <(int, String)>[
      (255, '00000000ff00000000000000'),
      (256, '000000000001000000000000'),
      (1 << 32, '000000000000000001000000'),
      ((1 << 53) + 1, '000000000100000000002000'),
      (0x7ffffffffffffffe, '00000000feffffffffffff7f'),
    ];
    expect(BigInt.from(0x7ffffffffffffffe), BigInt.two.pow(63) - BigInt.two);
    for (final (n, nonce) in byHand) {
      expect(hex(nonceBytes(n)), nonce, reason: '$n');
      final (ti, tr) = pair(ik);
      final key = ti.sendCipher.key!;
      ti.sendCipher.n = n;
      tr.receiveCipher.n = n;
      final plaintext = b([1, 2, 3]);
      final sent = ti.send(plaintext);
      expect(sent.ok, isTrue);
      expect(hex(sent.bytes!), hex(aead(plaintext, unhex(nonce), key)), reason: '$n');
      final got = tr.receive(sent.bytes!);
      expect(got.bytes, plaintext);
      expect(ti.sendCipher.n, n + 1);
      expect(tr.receiveCipher.n, n + 1);
    }
  });

  test('the counter\'s cap: 2^63-2 is the last used; a call that would use 2^63-1 throws and kills the transport', () {
    expect(BigInt.from(nonceCap), BigInt.two.pow(63) - BigInt.one);
    {
      final (ti, _) = pair(ik);
      ti.sendCipher.n = nonceCap - 1;
      expect(ti.send(Uint8List(1)).ok, isTrue);
      expect(ti.sendCipher.n, nonceCap);
      final wipes = wipesDuring(() => expect(() => ti.send(Uint8List(1)), throwsRangeError));
      expect(wipes, [true], reason: 'the transport\'s keys zeroed');
      expectReason(ti.send(Uint8List(1)), NoiseReason.dead);
      expectReason(ti.receive(Uint8List(16)), NoiseReason.dead);
      expect(ti.sendCipher.key, isNull);
    }
    {
      final (ti, tr) = pair(ik);
      final m = ti.send(Uint8List(1));
      tr.receiveCipher.n = nonceCap;
      expect(() => tr.receive(m.bytes!), throwsRangeError);
      expectReason(tr.send(Uint8List(1)), NoiseReason.dead);
      expectReason(tr.receive(m.bytes!), NoiseReason.dead);
    }
    {
      // A receive at 2^63-2 is the last.
      final (ti, tr) = pair(ik);
      ti.sendCipher.n = nonceCap - 1;
      tr.receiveCipher.n = nonceCap - 1;
      final m = ti.send(Uint8List(1));
      expect(tr.receive(m.bytes!).ok, isTrue);
      expect(tr.receiveCipher.n, nonceCap);
    }
  });

  test('a receive that fails leaves the counter, and one that decrypts moves it', () {
    final (ti, tr) = pair(ik);
    final m = ti.send(b([1]));
    expect(tr.receive(m.bytes!).ok, isTrue);
    expect(tr.receiveCipher.n, 1);
    final (ti2, tr2) = pair(ik);
    expect(tr2.receive(flip(ti2.send(b([1])).bytes!)).ok, isFalse);
    expect(tr2.receiveCipher.n, 0);
  });

  test('close() zeroes both keys, and every later call gives dead', () {
    final (ti, _) = pair(xxpsk3);
    expect(isZero(ti.sendCipher.key!) || isZero(ti.receiveCipher.key!), isFalse);
    final live = noiseLiveBlocks;
    final wipes = wipesDuring(ti.close);
    expect(wipes, [true]);
    expect(noiseLiveBlocks, live - 1);
    expect(ti.sendCipher.key, isNull);
    expectReason(ti.send(Uint8List(1)), NoiseReason.dead);
    expectReason(ti.receive(Uint8List(17)), NoiseReason.dead);
    expect(wipesDuring(ti.close), isEmpty, reason: 'closed once');
  });

  test('the two directions: each side\'s send key is the other\'s receive key, and neither its own', () {
    for (final p in [ik, xxpsk3]) {
      final (ti, tr) = pair(p);
      expect(ti.sendCipher.key, tr.receiveCipher.key);
      expect(ti.receiveCipher.key, tr.sendCipher.key);
      expect(hex(ti.sendCipher.key!) == hex(ti.receiveCipher.key!), isFalse);
    }
  });

  test('confirmed: the IK responder and the XXpsk3 initiator only once a message from the other side decrypts; the IK initiator and the XXpsk3 responder at once', () {
    final i = core(ik, true);
    final r = core(ik, false);
    final m1 = i.writeMessage();
    expect(r.remoteStatic, isNull);
    expect(r.readMessage(m1.message!).ok, isTrue);
    expect(r.remoteStatic, clientPublic, reason: 'the initiator\'s key, unconfirmed, after message 1');
    final m2 = r.writeMessage();
    final tr = m2.transport!;
    expect(tr.confirmed, isFalse);
    final got = i.readMessage(m2.message!);
    expect(got.transport!.confirmed, isTrue);
    // A message that does not decrypt confirms nothing.
    final r2 = core(ik, false);
    expect(r2.readMessage(m1.message!).ok, isTrue);
    final m2b = r2.writeMessage();
    final sent = got.transport!.send(b([7]));
    expectReason(m2b.transport!.receive(sent.bytes!), NoiseReason.decrypt);
    expect(m2b.transport!.confirmed, isFalse);
    expect(tr.receive(sent.bytes!).bytes, b([7]));
    expect(tr.confirmed, isTrue);
    expect(tr.send(b([8])).ok, isTrue, reason: 'confirmed, it sends');

    final (xi, xr) = pair(xxpsk3);
    expect(xi.confirmed, isFalse);
    expect(xr.confirmed, isTrue);
    final early = xi.send(b([1]));
    expect(early.ok, isTrue, reason: 'the XXpsk3 initiator sends unconfirmed');
    expect(xi.confirmed, isFalse);
    expect(xr.receive(early.bytes!).bytes, b([1]));
    final back = xr.send(b([2]));
    expectReason(xi.receive(flip(back.bytes!)), NoiseReason.decrypt);
    expect(xi.confirmed, isFalse);
    final (xi2, xr2) = pair(xxpsk3);
    expect(xi2.receive(xr2.send(b([3])).bytes!).bytes, b([3]));
    expect(xi2.confirmed, isTrue);
  });

  test('the IK responder\'s send throws before confirmation, and the transport is then dead', () {
    final (ti, tr) = pair(ik);
    expect(() => tr.send(b([1])), throwsA(isA<NoiseCallError>()));
    final m = ti.send(b([1]));
    expectReason(tr.receive(m.bytes!), NoiseReason.dead);
    expectReason(tr.send(b([1])), NoiseReason.dead);
    // Only the IK responder waits.
    final (xi, _) = pair(xxpsk3);
    expect(xi.send(b([1])).ok, isTrue);
    final (ti2, _) = pair(ik);
    expect(ti2.send(b([1])).ok, isTrue);
  });

  test('the DH order: an initiator\'s static key meets a remote key only after an ephemeral DH with it', () {
    String local(Token t, bool initiator) => t.name[initiator ? 0 : 1];
    String remote(Token t, bool initiator) => t.name[initiator ? 1 : 0];
    for (final (pattern, sides) in [
      (ik, [true]),
      (xxpsk3, [true, false]),
    ]) {
      for (final initiator in sides) {
        final before = <String>{};
        for (final t in pattern.messages.expand((m) => m)) {
          if (t.name.length != 2 || t == Token.psk) continue;
          if (local(t, initiator) == 's') expect(before, contains(remote(t, initiator)), reason: '${pattern.name}: $t');
          if (local(t, initiator) == 'e') before.add(remote(t, initiator));
        }
      }
    }
    // In a run: a low-order computer key fails at es, before ss.
    final calls = <String>[];
    final i = core(ik, true, remoteStatic: low, natives: _Spy(calls));
    expectReason(i.writeMessage(), NoiseReason.dh);
    expect(calls, ['e'], reason: 'only es, with the ephemeral key');
  });

  test('no input bytes make a handshake or a transport throw', () {
    const lengths = [0, 1, 15, 16, 17, 31, 32, 47, 48, 49, 63, 64, 65, 95, 96, 97, 200, 65535, 65536];
    final inputs = [
      for (final n in lengths) ...[Uint8List(n), sodium.randombytes.buf(n), Uint8List(n)..fillRange(0, n, 0xff)],
    ];
    for (final bytes in inputs) {
      final readers = [core(ik, false), core(xxpsk3, false)];
      final i = core(ik, true);
      expect(i.writeMessage().ok, isTrue);
      final x = core(xxpsk3, true);
      expect(x.writeMessage().ok, isTrue);
      readers.addAll([i, x]);
      for (final h in readers) {
        final r = h.readMessage(bytes);
        expect(r.ok, isFalse, reason: '${bytes.length} bytes');
      }
      final (ti, tr) = pair(ik);
      for (final t in [ti, tr]) {
        expect(t.receive(bytes).ok, isFalse, reason: '${bytes.length} bytes');
      }
    }
  });

  test('a caller\'s mistakes throw, and kill the state', () {
    final throwsCall = throwsA(isA<NoiseCallError>());
    final ck = keyOf(clientSecret);
    final sk = keyOf(computerSecret);
    addTearDown(() {
      ck.dispose();
      sk.dispose();
    });
    expect(() => noise.ikInitiator(staticKey: ck, responderKey: computerPublic, accountId: Uint8List(31)), throwsCall);
    expect(() => noise.ikInitiator(staticKey: ck, responderKey: computerPublic, accountId: Uint8List(33)), throwsCall);
    expect(() => noise.ikInitiator(staticKey: ck, responderKey: Uint8List(31), accountId: account), throwsCall);
    expect(() => noise.ikInitiator(staticKey: ck, responderKey: Uint8List(33), accountId: account), throwsCall);
    expect(() => noise.ikInitiator(staticKey: ck, responderKey: [...computerPublic.sublist(1), 256], accountId: account), throwsCall);
    expect(() => noise.ikInitiator(staticKey: ck, responderKey: computerPublic, accountId: [...account.sublist(1), -1]), throwsCall);
    final short = sodium.secureCopy(Uint8List(31));
    expect(() => noise.ikInitiator(staticKey: short, responderKey: computerPublic, accountId: account), throwsCall);
    short.dispose();
    expect(() => noise.ikResponder(staticKey: sk, accountId: Uint8List(0)), throwsCall);
    for (final p in [Uint8List(31), Uint8List(33)]) {
      expect(() => noise.xxpsk3Initiator(staticKey: ck, prologue: prologue, psk: p), throwsCall);
      expect(() => noise.xxpsk3Responder(staticKey: sk, prologue: prologue, psk: p), throwsCall);
    }
    expect(() => noise.xxpsk3Responder(staticKey: sk, prologue: [300], psk: psk), throwsCall);
    expect(() => core(ik, false, remoteStatic: computerPublic), throwsCall, reason: 'a responder given a remote key');
    expect(() => core(xxpsk3, true, remoteStatic: computerPublic), throwsCall, reason: 'an XXpsk3 initiator given a remote key');
    expect(() => core(ik, true, pskBytes: psk), throwsCall, reason: 'a PSK for IK');
    expect(() => core(ik, true, ephemeral: Uint8List(31)), throwsCall);
    expect(() => core(ik, true, remoteStatic: Uint8List(31)), throwsCall);
    expect(() => core(xxpsk3, false, pskBytes: Uint8List(31)), throwsCall);

    // Out of order, then dead.
    {
      final r = core(ik, false);
      expect(() => r.writeMessage(), throwsCall, reason: 'the responder writing first');
      expectReason(r.writeMessage(), NoiseReason.dead);
      expectReason(r.readMessage(Uint8List(96)), NoiseReason.dead);
      expect(r.dead, isTrue);
    }
    {
      final i = core(ik, true);
      expect(() => i.readMessage(Uint8List(48)), throwsCall, reason: 'the initiator reading first');
      expectReason(i.writeMessage(), NoiseReason.dead);
      expectReason(i.readMessage(Uint8List(96)), NoiseReason.dead);
    }
    {
      final i = core(ik, true);
      expect(i.writeMessage().ok, isTrue);
      expect(() => i.writeMessage(), throwsCall, reason: 'writing twice');
      expectReason(i.readMessage(Uint8List(48)), NoiseReason.dead);
    }
    {
      final i = core(ik, true);
      final r = core(ik, false);
      final (ti, _) = pair(ik, i, r);
      expect(() => i.writeMessage(), throwsA(isA<NoiseCallError>().having((e) => e.message, 'message', 'the handshake is over')));
      expect(() => r.readMessage(Uint8List(96)), throwsA(isA<NoiseCallError>().having((e) => e.message, 'message', 'the handshake is over')));
      expect(ti.send(b([1])).ok, isTrue, reason: 'the transport lives on');
    }
    {
      final i = core(ik, true);
      expect(() => i.writeMessage(b([1])), throwsCall, reason: 'a payload where PiRC carries none');
      expectReason(i.writeMessage(), NoiseReason.dead);
    }
    // A transport: too long a plaintext.
    {
      final (ti, tr) = pair(ik);
      expect(() => ti.send(Uint8List(maxPlaintext + 1)), throwsCall);
      expectReason(ti.send(Uint8List(1)), NoiseReason.dead);
      expectReason(ti.receive(Uint8List(16)), NoiseReason.dead);
      expectReason(tr.receive(Uint8List(maxPlaintext + 17)), NoiseReason.length, 'too long a message is a result');
    }
    {
      final (ti, tr) = pair(ik);
      final m = ti.send(Uint8List(maxPlaintext));
      expect(m.ok && m.bytes!.length == maxMessage, isTrue, reason: '65,519 bytes is not too long');
      expect(tr.receive(m.bytes!).bytes!.length, maxPlaintext, reason: '65,535 bytes is not too long');
    }
  });

  test('a failed handshake and a finished one leave no native block held, and every block and buffer is zero when freed', () {
    for (final p in [ik, xxpsk3]) {
      final live = noiseLiveBlocks;
      late Transport ti;
      late Transport tr;
      final wipes = wipesDuring(() {
        (ti, tr) = pair(p);
        expect(noiseLiveBlocks, live + 2, reason: 'the two transports');
        ti.close();
        tr.close();
      });
      expect(noiseLiveBlocks, live);
      expect(wipes.length, greaterThan(10));
      expect(wipes.every((z) => z), isTrue, reason: '${wipes.where((z) => !z).length} of ${wipes.length} not zero');
    }
    // Dying: a failure frees and zeroes the block.
    final live = noiseLiveBlocks;
    final i = core(ik, true, ephemeral: secret('ephemeral i'));
    expect(i.writeMessage().ok, isTrue);
    expect(isZero(i.ephemeralSecret!) || isZero(i.symmetric.ck!) || isZero(i.symmetric.cipher.key!), isFalse);
    expect(noiseLiveBlocks, live + 1);
    final wipes = wipesDuring(() => expectReason(i.readMessage(Uint8List(48)..fillRange(0, 48, 9)), NoiseReason.decrypt));
    expect(wipes.isNotEmpty && wipes.every((z) => z), isTrue);
    expect(noiseLiveBlocks, live);
    expect(i.ephemeralSecret, isNull);
    // A mistake too.
    final r = core(ik, false);
    expect(noiseLiveBlocks, live + 1);
    expect(() => r.writeMessage(), throwsA(isA<NoiseCallError>()));
    expect(noiseLiveBlocks, live);
    // And a handshake's own: once its last message is written or read.
    final i2 = core(xxpsk3, true);
    final r2 = core(xxpsk3, false);
    expect(noiseLiveBlocks, live + 2);
    final (a, c) = pair(xxpsk3, i2, r2);
    expect(noiseLiveBlocks, live + 2, reason: 'only the transports');
    a.close();
    c.close();
    expect(noiseLiveBlocks, live);
  });

  test('between messages, the DH output and HKDF\'s buffers are zero', () {
    for (final p in [ik, xxpsk3]) {
      final i = core(p, true);
      final r = core(p, false);
      final m1 = i.writeMessage();
      expect(i.symmetric.transientsZero, isTrue);
      expect(r.readMessage(m1.message!).ok, isTrue);
      expect(r.symmetric.transientsZero, isTrue);
      final m2 = r.writeMessage();
      if (identical(p, xxpsk3)) expect(r.symmetric.transientsZero, isTrue);
      expect(i.readMessage(m2.message!).ok, isTrue);
      if (identical(p, xxpsk3)) expect(i.symmetric.transientsZero, isTrue);
    }
  });

  test('a DH that libsodium refuses, or that gives zeros, fails with dh', () {
    for (final (rc, out) in [
      (0, Uint8List(32)),
      (-1, Uint8List(32)..fillRange(0, 32, 7)),
      (-1, Uint8List(32)),
    ]) {
      final i = core(ik, true, natives: FakeDh(rc, out));
      expectReason(i.writeMessage(), NoiseReason.dh, '$rc ${hex(out)}');
      expectReason(i.writeMessage(), NoiseReason.dead);
    }
    // The same stand-in giving libsodium's answer works.
    final i = core(ik, true, natives: FakeDh(0, null));
    expect(i.writeMessage().ok, isTrue);
  });

  test('an exception from libsodium inside a call is passed on, and kills the handshake or transport', () {
    final i = core(ik, true, natives: FailingEncrypt());
    expect(() => i.writeMessage(), throwsStateError);
    expectReason(i.writeMessage(), NoiseReason.dead);
    // A transport: its encryptions in the handshake pass, then one fails.
    final x = core(ik, true, natives: FailingEncrypt(after: 2));
    final (ti, _) = pair(ik, x);
    expect(() => ti.send(b([1])), throwsStateError);
    expectReason(ti.send(b([1])), NoiseReason.dead);
    expect(ti.remoteStatic, isNull);
  });

  test('with payloads (the vectors\' way): a message\'s length from its tokens up to 65,535 bytes, and a payload past that the caller\'s mistake', () {
    {
      final i = core(ik, true, payloads: true);
      final r = core(ik, false, payloads: true);
      final m = i.writeMessage(Uint8List(65535 - 96));
      expect(m.message!.length, 65535);
      expect(r.readMessage(m.message!).payload!.length, 65535 - 96);
    }
    {
      final i = core(ik, true, payloads: true);
      final r = core(ik, false, payloads: true);
      final m = i.writeMessage();
      expect(m.message!.length, 96);
      expect(r.readMessage(m.message!).ok, isTrue, reason: 'an empty payload at exactly the tokens\' length');
    }
    expectReason(core(ik, false, payloads: true).readMessage(Uint8List(65536)), NoiseReason.length);
    expectReason(core(ik, false, payloads: true).readMessage(Uint8List(95)), NoiseReason.length);
    {
      final i = core(ik, true, payloads: true);
      expect(() => i.writeMessage(Uint8List(65535 - 95)), throwsA(isA<NoiseCallError>()));
      expectReason(i.writeMessage(), NoiseReason.dead);
    }
  });

  test('the protocol names are under 64 bytes', () {
    for (final p in [ik, xxpsk3]) {
      expect(utf8.encode(p.name).length, lessThan(64), reason: p.name);
    }
  });

  test('random messages through real handshakes, by the public API', () {
    final a = publicIk();
    final b2 = publicIk();
    expect(hex(a.m1) == hex(b2.m1), isFalse, reason: 'a fresh ephemeral key per handshake');
    expect(a.ti.handshakeHash, a.tr.handshakeHash);
    expect(a.tr.remoteStatic, clientPublic);
    expect(a.ti.remoteStatic, computerPublic);
    expect(a.ti.confirmed, isTrue);
    expect(a.tr.confirmed, isFalse);
    for (var n = 0; n < 50; n++) {
      final size = n == 49 ? maxPlaintext : sodium.randombytes.uniform(2000);
      final p = sodium.randombytes.buf(size);
      final (from, to) = n.isEven ? (a.ti, a.tr) : (a.tr, a.ti);
      final m = from.send(p);
      expect(m.message!.length, size + 16);
      expect(to.receive(m.message!).plaintext, p);
    }
    expect(a.tr.confirmed, isTrue);

    final ck = keyOf(clientSecret);
    final sk = keyOf(computerSecret);
    final xi = noise.xxpsk3Initiator(staticKey: ck, prologue: prologue, psk: psk);
    final xr = noise.xxpsk3Responder(staticKey: sk, prologue: prologue, psk: psk);
    ck.dispose();
    sk.dispose();
    final x1 = xi.writeMessage();
    expect(x1.message!.length, 48);
    expect(xr.remoteStatic, isNull);
    expect(xr.readMessage(x1.message!).ok, isTrue);
    final x2 = xr.writeMessage();
    expect(x2.message!.length, 96);
    expect(xi.readMessage(x2.message!).ok, isTrue);
    expect(xi.remoteStatic, computerPublic);
    final x3 = xi.writeMessage();
    expect(x3.message!.length, 64);
    final xd = xr.readMessage(x3.message!);
    expect(xd.transport!.remoteStatic, clientPublic);
    expect(xd.transport!.handshakeHash, x3.transport!.handshakeHash);
    expect(x3.transport!.confirmed, isFalse);
    expect(xd.transport!.confirmed, isTrue);
    for (var n = 0; n < 20; n++) {
      final p = sodium.randombytes.buf(sodium.randombytes.uniform(500));
      final (from, to) = n.isEven ? (xd.transport!, x3.transport!) : (x3.transport!, xd.transport!);
      expect(to.receive(from.send(p).message!).plaintext, p);
    }
    expect(psk, secret('psk'), reason: 'the caller\'s PSK left as it was');
  });

  test('the messages\' fixed lengths: IK 96 and 48, XXpsk3 48, 96 and 64', () {
    final file = jsonDecode(File('../cases/e2e/channel.json').readAsStringSync()) as Map;
    final cases = (file['cases'] as List).cast<Map>();
    for (final (about, lengths) in [
      ('IK: both messages', [96, 48]),
      ('XXpsk3: three messages', [48, 96, 64]),
    ]) {
      final c = cases.firstWhere((c) => (c['about'] as String).startsWith(about));
      expect([for (final s in (c['steps'] as List).cast<Map>()) if (s['call'] == 'write') (s['bytes'] as String).length ~/ 2], lengths);
    }
  });

  test('the public API carries no handshake payload: each message with an authentic payload of 1 byte fails with length', () {
    Handshake craft(NoisePattern p, bool initiator) => core(p, initiator, payloads: true);
    final x = b([0x78]);
    final ck = keyOf(clientSecret);
    final sk = keyOf(computerSecret);
    addTearDown(() {
      ck.dispose();
      sk.dispose();
    });
    {
      final m1 = craft(ik, true).writeMessage(x);
      expect(m1.message!.length, 97);
      final r = noise.ikResponder(staticKey: sk, accountId: account);
      expectReason(r.readMessage(m1.message!), NoiseReason.length);
      expectReason(r.readMessage(Uint8List.sublistView(m1.message!, 0, 96)), NoiseReason.dead);
    }
    {
      final i = noise.ikInitiator(staticKey: ck, responderKey: computerPublic, accountId: account);
      final c = craft(ik, false);
      expect(c.readMessage(i.writeMessage().message!).ok, isTrue);
      final m2 = c.writeMessage(x);
      expect(m2.message!.length, 49);
      expectReason(i.readMessage(m2.message!), NoiseReason.length);
    }
    {
      final m1 = craft(xxpsk3, true).writeMessage(x);
      expect(m1.message!.length, 49);
      expectReason(noise.xxpsk3Responder(staticKey: sk, prologue: prologue, psk: psk).readMessage(m1.message!), NoiseReason.length);
    }
    {
      final i = noise.xxpsk3Initiator(staticKey: ck, prologue: prologue, psk: psk);
      final c = craft(xxpsk3, false);
      expect(c.readMessage(i.writeMessage().message!).ok, isTrue);
      final m2 = c.writeMessage(x);
      expect(m2.message!.length, 97);
      expectReason(i.readMessage(m2.message!), NoiseReason.length);
    }
    {
      final r = noise.xxpsk3Responder(staticKey: sk, prologue: prologue, psk: psk);
      final c = craft(xxpsk3, true);
      expect(r.readMessage(c.writeMessage().message!).ok, isTrue);
      expect(c.readMessage(r.writeMessage().message!).ok, isTrue);
      final m3 = c.writeMessage(x);
      expect(m3.message!.length, 65);
      expectReason(r.readMessage(m3.message!), NoiseReason.length);
    }
  });

  test('remoteStatic is null once a handshake or a transport is dead', () {
    final ck = keyOf(clientSecret);
    final sk = keyOf(computerSecret);
    final i = noise.xxpsk3Initiator(staticKey: ck, prologue: prologue, psk: secret('another psk'));
    final r = noise.xxpsk3Responder(staticKey: sk, prologue: prologue, psk: psk);
    ck.dispose();
    sk.dispose();
    expect(r.readMessage(i.writeMessage().message!).ok, isTrue);
    expect(i.readMessage(r.writeMessage().message!).ok, isTrue);
    expect(i.remoteStatic, computerPublic);
    final m3 = i.writeMessage();
    expect(r.remoteStatic, isNull, reason: 'not yet carried');
    expectReason(r.readMessage(m3.message!), NoiseReason.decrypt);
    expect(r.remoteStatic, isNull);
    final t = m3.transport!;
    expect(t.remoteStatic, computerPublic);
    expectReason(t.receive(Uint8List(16)), NoiseReason.decrypt);
    expect(t.remoteStatic, isNull);
    final (ti, _) = pair(ik);
    ti.close();
    expect(ti.remoteStatic, isNull);
    // A handshake that dies after its remote key was known.
    final h = core(ik, true);
    expect(h.remoteStatic, computerPublic);
    expect(h.writeMessage().ok, isTrue);
    expectReason(h.readMessage(Uint8List(48)..fillRange(0, 48, 9)), NoiseReason.decrypt);
    expect(h.remoteStatic, isNull);
  });

  test('copies: of every input on entry, and of the keys and hash given out', () {
    // The caller's static key disposed, and its buffers zeroed, once the handshake is made.
    final ck = keyOf(clientSecret);
    final responderKey = Uint8List.fromList(computerPublic);
    final accountId = Uint8List.fromList(account);
    final i = noise.ikInitiator(staticKey: ck, responderKey: responderKey, accountId: accountId);
    ck.dispose();
    responderKey.fillRange(0, 32, 0);
    accountId.fillRange(0, 32, 0);
    final r = core(ik, false);
    final m1 = i.writeMessage();
    expect(r.readMessage(m1.message!).ok, isTrue, reason: 'nothing the caller changed after reached it');
    expect(r.remoteStatic, clientPublic);
    final m2 = r.writeMessage();
    final done = i.readMessage(m2.message!);
    expect(done.ok, isTrue);
    final t = done.transport!;
    t.handshakeHash.fillRange(0, 64, 0);
    t.remoteStatic!.fillRange(0, 32, 0);
    expect(t.handshakeHash, m2.transport!.handshakeHash);
    expect(t.remoteStatic, computerPublic);
    i.remoteStatic!.fillRange(0, 32, 0);
    expect(i.remoteStatic, computerPublic);
    // A message buffer changed after it was read, and a plaintext after it was sent.
    final p = b([1, 2, 3]);
    final sent = t.send(p);
    p.fillRange(0, 3, 0);
    expect(m2.transport!.receive(sent.message!).bytes, b([1, 2, 3]));
    // The core's PSK and ephemeral key: the caller's own copies kept.
    final mine = Uint8List.fromList(psk);
    final e = secret('ephemeral');
    final x = core(xxpsk3, true, pskBytes: mine, ephemeral: e);
    mine.fillRange(0, 32, 0);
    e.fillRange(0, 32, 0);
    expect(x.ephemeralSecret, secret('ephemeral'));
    expect(x.writeMessage().message!.sublist(0, 32), publicOf(secret('ephemeral')));
  });

  test('the public transport and handshake: none of the core\'s state reachable or settable', () {
    final a = publicIk();
    for (final t in [a.ti, a.tr]) {
      final d = t as dynamic;
      for (final get in [() => d.sendCipher, () => d.receiveCipher, () => d.dead, () => d.core, () => d.t]) {
        expect(get, throwsNoSuchMethodError);
      }
      expect(() => d.confirmed = true, throwsNoSuchMethodError);
      expect(() => d.remoteStatic = null, throwsNoSuchMethodError);
    }
    expect(a.tr.confirmed, isFalse);
    expect(() => a.tr.send(b([1])), throwsA(isA<NoiseCallError>()), reason: 'the gate holds through the facade');
    expectReason(a.tr.send(b([1])), NoiseReason.dead);
    final ck = keyOf(clientSecret);
    final h = noise.ikInitiator(staticKey: ck, responderKey: computerPublic, accountId: account) as dynamic;
    ck.dispose();
    for (final get in [() => h.symmetric, () => h.dead, () => h.pattern, () => h.ephemeralSecret]) {
      expect(get, throwsNoSuchMethodError);
    }
  });

  test('the public API\'s prologue is channelPrologue of the account ID', () {
    for (final (other, ok) in [(account, true), (secret('another account'), false)]) {
      final ck = keyOf(clientSecret);
      final i = noise.ikInitiator(staticKey: ck, responderKey: computerPublic, accountId: account);
      ck.dispose();
      final r = core(ik, false, prologueBytes: channelPrologue(other));
      final got = r.readMessage(i.writeMessage().message!);
      expect(got.ok, ok);
      if (!ok) expectReason(got, NoiseReason.decrypt);
    }
    final sk = keyOf(computerSecret);
    final r = noise.ikResponder(staticKey: sk, accountId: account);
    sk.dispose();
    expect(r.readMessage(core(ik, true).writeMessage().message!).ok, isTrue);
  });

  test('the public results carry the message, and the transport only after the last', () {
    final ck = keyOf(clientSecret);
    final sk = keyOf(computerSecret);
    final i = noise.ikInitiator(staticKey: ck, responderKey: computerPublic, accountId: account);
    final r = noise.ikResponder(staticKey: sk, accountId: account);
    ck.dispose();
    sk.dispose();
    final m1 = i.writeMessage();
    expect((m1.ok, m1.reason, m1.transport), (true, null, null));
    final got1 = r.readMessage(m1.message!);
    expect((got1.ok, got1.message, got1.transport), (true, null, null));
    final m2 = r.writeMessage();
    expect(m2.transport, isNotNull);
    final got2 = i.readMessage(m2.message!);
    expect((got2.ok, got2.message), (true, null));
    expect(got2.transport, isNotNull);
    final sk2 = keyOf(computerSecret);
    final bad = noise.ikResponder(staticKey: sk2, accountId: account).readMessage(Uint8List(1));
    sk2.dispose();
    expect((bad.ok, bad.reason, bad.message, bad.transport), (false, NoiseReason.length, null, null));
    final s = got2.transport!.send(Uint8List(0));
    expect((s.ok, s.reason, s.message!.length), (true, null, 16));
    final rc = m2.transport!.receive(s.message!);
    expect((rc.ok, rc.reason, rc.plaintext!.length), (true, null, 0));
  });

  test('the reasons\' names are the files\'', () {
    expect([for (final r in NoiseReason.values) r.name], ['length', 'dh', 'decrypt', 'dead']);
  });
}

/// libsodium's DH, recording which local key each call used: 'e' or 's'.
class _Spy extends NoiseNatives {
  _Spy(this.calls);
  final List<String> calls;
  @override
  int scalarmult(Pointer<UnsignedChar> q, Pointer<UnsignedChar> n, Pointer<UnsignedChar> p) {
    calls.add(_isEphemeral(n) ? 'e' : 's');
    return super.scalarmult(q, n, p);
  }

  bool _isEphemeral(Pointer<UnsignedChar> n) => hex(n.cast<Uint8>().asTypedList(32)) != hex(clientSecret) && hex(n.cast<Uint8>().asTypedList(32)) != hex(computerSecret);
}

class _Gone implements Exception {}

/// A key whose bytes cannot be read.
class _ThrowingKey implements SecureKey {
  @override
  int get length => 32;
  @override
  T runUnlockedSync<T>(SecureCallbackFn<T> callback, {bool writable = false}) => throw _Gone();
  @override
  noSuchMethod(Invocation invocation) => throw UnimplementedError();
}
