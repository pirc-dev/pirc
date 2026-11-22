// The list's check and maker (lib/e2e/list.dart) beyond the shared cases:
// what is a caller's mistake, and that no input bytes make the check throw.
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/list.dart';
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';

void main() {
  late E2e e2e;
  late SodiumSumo sodium;
  setUpAll(() async {
    e2e = await E2e.load();
    sodium = await SodiumSumoInit.init();
  });

  Uint8List key(int seed) => Uint8List.fromList(List.generate(32, (i) => (seed * 31 + i) & 0xff));
  Device phone(KeyPair p) => Device(role: roleClient, signingKey: p.publicKey, channelKey: key(1), boxKey: key(2), readOnlyKey: key(3), notificationKey: key(4));
  Device computer(int s) => Device(role: roleComputer, signingKey: key(s), channelKey: key(s + 1), boxKey: key(s + 2));

  test('no input bytes make the check throw', () {
    for (final bytes in [Uint8List(0), Uint8List(64), Uint8List(200)..fillRange(0, 200, 0xff)]) {
      for (final phoneKey in [Uint8List(0), Uint8List(31), Uint8List(32)]) {
        expect(e2e.checkList(bytes: bytes, phoneKey: phoneKey, mode: ListMode.first, highest: Int64.ZERO).result, 'refused');
        expect(e2e.checkList(bytes: bytes, phoneKey: phoneKey, mode: ListMode.later, accountId: Uint8List(32), highest: Int64.ZERO).result, 'refused');
      }
    }
  });

  test("a caller's mistakes throw", () {
    final bytes = Uint8List(100);
    final k = Uint8List(32);
    for (final id in [null, Uint8List(0), Uint8List(31), Uint8List(33)]) {
      expect(() => e2e.checkList(bytes: bytes, phoneKey: k, mode: ListMode.later, accountId: id, highest: Int64.ZERO), throwsA(isA<ListCallError>()));
    }
    expect(() => e2e.checkList(bytes: bytes, phoneKey: k, mode: ListMode.first, accountId: Uint8List(31), highest: Int64.ZERO), throwsA(isA<ListCallError>()));
    expect(() => e2e.checkList(bytes: bytes, phoneKey: k, mode: ListMode.first, highest: Int64.ZERO, self: Device()), throwsA(isA<ListCallError>()));
    expect(() => e2e.checkList(bytes: bytes, phoneKey: k, mode: ListMode.first, highest: Int64(-1)), throwsA(isA<ListCallError>()));
  });

  test('the maker refuses a version the check would not accept', () {
    final p = sodium.crypto.sign.keyPair();
    final v1 = e2e.makeList(phone: p, devices: [phone(p)], counter: Int64.ONE);
    final body = Uint8List.sublistView(v1, 64);
    final id = e2e.sha256(body);
    expect(e2e.checkList(bytes: v1, phoneKey: p.publicKey, mode: ListMode.first, accountId: id, highest: Int64.ZERO).result, 'accepted');
    final good = e2e.makeList(phone: p, devices: [phone(p), computer(10)], previousBody: body, accountId: id, counter: Int64(2));
    expect(e2e.checkList(bytes: good, phoneKey: p.publicKey, mode: ListMode.later, accountId: id, highest: Int64.ONE).result, 'accepted');
    void refuses(String why, void Function() make) => expect(make, throwsA(isA<ListCallError>()), reason: why);
    refuses('two devices in version 1', () => e2e.makeList(phone: p, devices: [phone(p), computer(10)], counter: Int64.ONE));
    refuses('counter 2 in version 1', () => e2e.makeList(phone: p, devices: [phone(p)], counter: Int64(2)));
    refuses('counter 1 later', () => e2e.makeList(phone: p, devices: [phone(p)], previousBody: body, accountId: id, counter: Int64.ONE));
    refuses('counter 2^63', () => e2e.makeList(phone: p, devices: [phone(p)], previousBody: body, accountId: id, counter: Int64.MIN_VALUE));
    refuses('an account ID without a previous body', () => e2e.makeList(phone: p, devices: [phone(p)], accountId: id, counter: Int64(2)));
    refuses('a previous body without an account ID', () => e2e.makeList(phone: p, devices: [phone(p)], previousBody: body, counter: Int64(2)));
    for (final n in [0, 5, 31, 33]) {
      refuses('an account ID of $n bytes', () => e2e.makeList(phone: p, devices: [phone(p), computer(10)], previousBody: body, accountId: Uint8List(n), counter: Int64(2)));
    }
    refuses('an empty previous body', () => e2e.makeList(phone: p, devices: [phone(p), computer(10)], previousBody: Uint8List(0), accountId: id, counter: Int64(2)));
    final q = sodium.crypto.sign.keyPair();
    refuses('a key pair whose halves do not match', () => e2e.makeList(phone: KeyPair(publicKey: p.publicKey, secretKey: q.secretKey), devices: [phone(p)], counter: Int64.ONE));
    refuses('the same, later', () => e2e.makeList(phone: KeyPair(publicKey: p.publicKey, secretKey: q.secretKey), devices: [phone(p), computer(10)], previousBody: body, accountId: id, counter: Int64(2)));
    refuses('a key twice', () => e2e.makeList(phone: p, devices: [phone(p), computer(10), computer(10)], previousBody: body, accountId: id, counter: Int64(2)));
    refuses('the phone missing', () => e2e.makeList(phone: p, devices: [computer(10)], previousBody: body, accountId: id, counter: Int64(2)));
    refuses('role 3', () => e2e.makeList(phone: p, devices: [phone(p), computer(10)..role = 3], previousBody: body, accountId: id, counter: Int64(2)));
  });

  test("an accepted list shares no bytes with the caller's", () {
    final p = sodium.crypto.sign.keyPair();
    final v1 = e2e.makeList(phone: p, devices: [phone(p)], counter: Int64.ONE);
    final r = e2e.checkList(bytes: v1, phoneKey: p.publicKey, mode: ListMode.first, highest: Int64.ZERO);
    final before = List.of(r.list!.devices.single.channelKey);
    v1.fillRange(0, v1.length, 0xaa);
    expect(r.list!.devices.single.channelKey, before);
  });

  test('the checks load once', () async {
    expect(await E2e.load(), same(e2e));
  });

  test('a start that fails is tried again on the next call', () async {
    E2e.forget();
    var calls = 0;
    SodiumSumo init() {
      calls++;
      if (calls == 1) throw StateError('no libsodium');
      return sodium;
    }

    await expectLater(E2e.loadWith(init), throwsStateError);
    final second = await E2e.loadWith(init);
    expect(calls, 2);
    expect(await E2e.loadWith(init), same(second));
    expect(calls, 2);
    E2e.forget();
  });
}
