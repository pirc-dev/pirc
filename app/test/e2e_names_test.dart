// Opening announcements, notices and names, and making names
// (lib/e2e/sealed.dart, names.dart) beyond the shared cases: what is a
// caller's mistake, that no input bytes make opening throw, and what the
// maker does that exact bytes do not show.
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sodium/sodium_sumo.dart';

import 'package:pirc/e2e/bytes.dart';
import 'package:pirc/e2e/framed.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/e2e/names.dart';
import 'package:pirc/e2e/sealed.dart';
import 'package:pirc/gen/pirc/v1alpha2/account.pb.dart';

typedef Account = ({
  KeyPair phone,
  SecureKey phoneBox,
  Uint8List phoneBoxPublic,
  SecureKey noticeSecret,
  SecureKey computerBox,
  List<SecureKey> clientBox,
  ListBody list,
  Uint8List accountId,
});

void main() {
  late E2e e2e;
  late SodiumSumo sodium;
  setUpAll(() async {
    e2e = await E2e.load();
    sodium = await SodiumSumoInit.init();
  });

  Uint8List key(int seed) => Uint8List.fromList(List.generate(32, (i) => (seed * 31 + i) & 0xff));

  /// An account: its phone, two clients and a computer, with the secret
  /// keys the tests open with.
  Account account({int clients = 2}) {
    final phone = sodium.crypto.sign.keyPair();
    final phoneBox = sodium.crypto.box.keyPair();
    final notice = sodium.crypto.box.keyPair();
    final computer = sodium.crypto.box.keyPair();
    final boxes = [for (var i = 0; i < clients; i++) sodium.crypto.box.keyPair()];
    final list = ListBody(counter: Int64(4), devices: [
      Device(role: roleClient, signingKey: phone.publicKey, channelKey: key(1), boxKey: phoneBox.publicKey, readOnlyKey: key(2), notificationKey: notice.publicKey),
      for (var i = 0; i < clients; i++)
        Device(role: roleClient, signingKey: key(10 + i), channelKey: key(20 + i), boxKey: boxes[i].publicKey),
      Device(role: roleComputer, signingKey: key(40), channelKey: key(41), boxKey: computer.publicKey),
    ]);
    return (
      phone: phone,
      phoneBox: phoneBox.secretKey,
      phoneBoxPublic: phoneBox.publicKey,
      noticeSecret: notice.secretKey,
      computerBox: computer.secretKey,
      clientBox: [for (final b in boxes) b.secretKey],
      list: list,
      accountId: key(99),
    );
  }

  MadeNames make(Account a, List<DeviceName> names, {Int64? ordering}) =>
      e2e.makeNames(accountId: a.accountId, list: a.list, phone: a.phone, phoneBoxSecretKey: a.phoneBox, ordering: ordering ?? Int64(1000), names: names);

  /// [plaintext] in a box from [from] to [to], with a random nonce.
  Uint8List boxed(List<int> plaintext, List<int> to, SecureKey from) {
    final nonce = sodium.randombytes.buf(nonceBytes);
    final box = sodium.crypto.box.easy(message: Uint8List.fromList(plaintext), nonce: nonce, publicKey: Uint8List.fromList(to), secretKey: from);
    return Uint8List.fromList([...nonce, ...box]);
  }

  /// What a computer seals for a slot: the prefix, 8 bytes of ordering, the body.
  Uint8List sealedFor(Account a, SealedKind kind, Slot slot, Int64 ordering, List<int> body, {bool toNotice = false}) {
    final plaintext = [
      ...framed(kind.context, [slot.accountId, slot.computerKey, slot.sessionId]),
      8,
      ...ordering.toBytes().reversed,
      ...body,
    ];
    return boxed(plaintext, toNotice ? a.list.devices.first.notificationKey : a.list.devices[1].boxKey, a.computerBox);
  }

  Slot slotOf(Account a, [List<int>? sessionId]) => Slot(accountId: a.accountId, computerKey: key(40), sessionId: sessionId ?? utf8.encode('s'));

  /// The phone's signed names, sealed to the first client.
  Uint8List namesSealed(Account a, List<int> body, {List<int>? accountId}) {
    final sig = sodium.crypto.sign.detached(message: framed(namesContext, [accountId ?? a.accountId, body]), secretKey: a.phone.secretKey);
    return boxed([...sig, ...body], a.list.devices[1].boxKey, a.phoneBox);
  }

  List<DeviceName> good(ListBody list) => [for (final d in list.devices) DeviceName(d.signingKey, 'device ${d.signingKey.first}')];

  test("the maker's copies open for each client, each with a fresh nonce", () {
    final a = account();
    final one = make(a, good(a.list));
    final two = make(a, good(a.list));
    // The phone itself is a client on the list, so it gets a copy too.
    expect(one.copies.length, 3);
    expect(one.skipped, isEmpty);
    final nonces = {for (final m in [one, two]) for (final c in m.copies) hexOf(c.sealed.sublist(0, nonceBytes))};
    expect(nonces.length, 6);
    final secrets = [a.phoneBox, ...a.clientBox];
    for (final m in [one, two]) {
      for (var i = 0; i < m.copies.length; i++) {
        final r = e2e.openNames(
          sealed: m.copies[i].sealed,
          accountId: a.accountId,
          list: a.list,
          phoneKey: a.phone.publicKey,
          recipientSecretKey: secrets[i].extractBytes(),
          now: Int64(1000),
        );
        expect(r.result, 'accepted', reason: r.reason);
        expect([for (final n in r.names) n.name], [for (final n in good(a.list)) n.name]);
        expect(r.dropped, isEmpty);
      }
    }
  });

  test('the maker cuts a name at a code point boundary and writes a lone surrogate as U+FFFD', () {
    final a = account();
    String opened(String name) {
      final m = make(a, [DeviceName(a.list.devices.first.signingKey, name)]);
      final r = e2e.openNames(
        sealed: m.copies.first.sealed,
        accountId: a.accountId,
        list: a.list,
        phoneKey: a.phone.publicKey,
        recipientSecretKey: a.phoneBox.extractBytes(),
        now: Int64(1000),
      );
      expect(r.result, 'accepted', reason: r.reason);
      return r.names.single.name;
    }

    expect(opened('p' * 200), 'p' * 200);
    expect(opened('p' * 201), 'p' * 200);
    expect(opened('é' * 101), 'é' * 100);
    expect(opened('p${'é' * 100}'), 'p${'é' * 99}');
    expect(opened('\u{1d11e}' * 51), '\u{1d11e}' * 50);
    expect(opened('€' * 67), '€' * 66);
    expect(opened('a\ud800b'), 'a\ufffdb');
    expect(opened('\ud800'), '\ufffd');
    expect(opened('\ufeffPixel'), '\ufeffPixel');
    expect(opened(''), '');
  });

  test('the maker skips a client whose key libsodium refuses, and the others still get theirs', () {
    final a = account(clients: 3);
    a.list.devices[2].boxKey = Uint8List(32);
    final m = make(a, good(a.list));
    expect(m.skipped, [Uint8List(32)]);
    expect(m.copies.length, 3);
    expect([for (final c in m.copies) hexOf(c.signingKey)], [for (final i in [0, 1, 3]) hexOf(a.list.devices[i].signingKey)]);
  });

  test("the maker's caller mistakes throw", () {
    final a = account();
    final names = good(a.list);
    void refuses(String why, void Function() f) => expect(f, throwsA(isA<NamesCallError>()), reason: why);
    MadeNames Function() with_({List<int>? accountId, ListBody? list, KeyPair? phone, SecureKey? box, Int64? ordering, List<DeviceName>? names_}) => () => e2e.makeNames(
          accountId: accountId ?? a.accountId,
          list: list ?? a.list,
          phone: phone ?? a.phone,
          phoneBoxSecretKey: box ?? a.phoneBox,
          ordering: ordering ?? Int64(1000),
          names: names_ ?? names,
        );
    with_()();
    for (final n in [0, 31, 33]) {
      refuses('an account ID of $n bytes', with_(accountId: Uint8List(n)));
    }
    refuses('ordering 2^63', with_(ordering: Int64.MIN_VALUE));
    refuses('ordering -1', with_(ordering: Int64(-1)));
    refuses('a list of counter 0', with_(list: ListBody(counter: Int64.ZERO, devices: a.list.devices)));
    refuses('a list of counter 2^63', with_(list: ListBody(counter: Int64.MIN_VALUE, devices: a.list.devices)));
    refuses('a phone not on the list', with_(phone: sodium.crypto.sign.keyPair()));
    refuses('a box secret key that is not the phone\'s', with_(box: a.clientBox.first));
    refuses('a name for a device not on the list', with_(names_: [...names, DeviceName(key(77), 'old')]));
    refuses('a key twice', with_(names_: [...names, names.first]));
    refuses('names over 32,768 bytes', with_(names_: [for (var i = 0; i < 200; i++) DeviceName(key(100 + i), 'n' * 200)]));
    final q = sodium.crypto.sign.keyPair();
    refuses('a key pair whose halves do not match', with_(phone: KeyPair(publicKey: a.phone.publicKey, secretKey: q.secretKey)));
    refuses('a nonce of 23 bytes', () => e2e.makeNamesWithNonces(
          accountId: a.accountId, list: a.list, phone: a.phone, phoneBoxSecretKey: a.phoneBox, ordering: Int64(1000), names: names, nonceFor: (_) => Uint8List(23)));
  });

  test('the maker writes only what holds something: names of ordering 0 and of an empty name', () {
    final a = account();
    final m = make(a, [DeviceName(a.list.devices.first.signingKey, '')], ordering: Int64.ZERO);
    final plain = sodium.crypto.box.openEasy(
      cipherText: Uint8List.sublistView(m.copies.first.sealed, nonceBytes),
      nonce: Uint8List.sublistView(m.copies.first.sealed, 0, nonceBytes),
      publicKey: a.phoneBoxPublic,
      secretKey: a.phoneBox,
    );
    // listCounter 4, then one name holding only its signing key: nothing for the ordering or the empty name.
    final body = plain.sublist(64);
    expect(body, [0x08, 4, 0x1a, 34, 0x0a, 32, ...a.list.devices.first.signingKey]);
  });

  test('names of a list counter of 2^63 or more are from a list the caller does not have yet', () {
    final a = account();
    // What only a phone could sign: the maker never writes it.
    Uint8List sealBody(Names names) {
      final body = names.writeToBuffer();
      final sig = sodium.crypto.sign.detached(message: framed(namesContext, [a.accountId, body]), secretKey: a.phone.secretKey);
      final nonce = Uint8List(nonceBytes);
      final box = sodium.crypto.box.easy(message: Uint8List.fromList([...sig, ...body]), nonce: nonce, publicKey: Uint8List.fromList(a.list.devices[1].boxKey), secretKey: a.phoneBox);
      return Uint8List.fromList([...nonce, ...box]);
    }

    NamesResult open(Int64 counter) => e2e.openNames(
          sealed: sealBody(Names(listCounter: counter, ordering: Int64(5))),
          accountId: a.accountId,
          list: a.list,
          phoneKey: a.phone.publicKey,
          recipientSecretKey: a.clientBox.first.extractBytes(),
          now: Int64(5),
        );
    expect(open(Int64(4)).result, 'accepted');
    expect(open(Int64(5)).result, 'later');
    expect(open(Int64.MAX_VALUE).result, 'later');
    expect(open(Int64.MIN_VALUE).result, 'later');
    expect(open(Int64(-1)).result, 'later');
  });

  test('the maker holds to the size every client accepts', () {
    // Clients enough that their names come to about 32 KB sealed.
    final phone = sodium.crypto.sign.keyPair();
    final box = sodium.crypto.box.keyPair();
    final clients = [for (var i = 0; i < 136; i++) Device(role: roleClient, signingKey: key(1000 + i), channelKey: key(2000 + i), boxKey: key(3000 + i))];
    final list = ListBody(counter: Int64(4), devices: [
      Device(role: roleClient, signingKey: phone.publicKey, channelKey: key(1), boxKey: box.publicKey, readOnlyKey: key(2), notificationKey: key(3)),
      ...clients,
    ]);
    // The sealed size with the first name [a] bytes long and the second [b],
    // the rest 200, or -1 if the maker refuses.
    int size(int a, int b) {
      final names = [for (final d in list.devices) DeviceName(d.signingKey, 'x' * 200)];
      names[0] = DeviceName(names[0].signingKey, 'x' * a);
      names[1] = DeviceName(names[1].signingKey, 'x' * b);
      try {
        return e2e.makeNames(accountId: key(99), list: list, phone: phone, phoneBoxSecretKey: box.secretKey, ordering: Int64(1000), names: names).copies.first.sealed.length;
      } on NamesCallError {
        return -1;
      }
    }

    int? found;
    for (var a = 0; a <= 200 && found == null; a++) {
      if (size(a, 0) == namesMaxBytes) found = a;
    }
    expect(found, isNotNull, reason: 'a length that makes exactly $namesMaxBytes bytes');
    expect(size(found! + 1, 0), -1, reason: 'one byte over');
    expect(size(found - 1, 0), namesMaxBytes - 1);
  });

  test('a session ID is capped in bytes, not characters', () {
    final a = account();
    final long = utf8.encode('\u00e9' * 65); // 65 characters, 130 bytes
    final slot = slotOf(a, long);
    final sealed = Uint8List(100);
    expect(e2e.openAnnouncement(sealed: sealed, slot: slot, recipientSecretKey: key(1), list: a.list, now: Int64.ZERO).reason, 'slot');
    expect(e2e.openNotice(sealed: sealed, slot: slot, recipientSecretKey: key(1), list: a.list, now: Int64.ZERO).reason, 'slot');
  });

  test('the ordering value is in range before it is compared with the highest seen', () {
    final a = account();
    final slot = slotOf(a);
    final high = Int64(5);
    final announcement = sealedFor(a, SealedKind.announcement, slot, Int64.MIN_VALUE, const []);
    final notice = sealedFor(a, SealedKind.notice, slot, Int64.MIN_VALUE, const [], toNotice: true);
    final names = namesSealed(a, Names(listCounter: Int64(1), ordering: Int64.MIN_VALUE).writeToBuffer());
    expect(e2e.openAnnouncement(sealed: announcement, slot: slot, recipientSecretKey: a.clientBox.first.extractBytes(), list: a.list, highest: high, now: Int64(5)).reason, 'range');
    expect(e2e.openNotice(sealed: notice, slot: slot, recipientSecretKey: a.noticeSecret.extractBytes(), list: a.list, highest: high, now: Int64(5)).reason, 'range');
    expect(
        e2e.openNames(sealed: names, accountId: a.accountId, list: a.list, phoneKey: a.phone.publicKey, recipientSecretKey: a.clientBox.first.extractBytes(), highest: high, now: Int64(5)).reason,
        'range');
    // And a value below 2^63 that is not above the highest seen is an ordering.
    final old = sealedFor(a, SealedKind.announcement, slot, Int64(5), const []);
    expect(e2e.openAnnouncement(sealed: old, slot: slot, recipientSecretKey: a.clientBox.first.extractBytes(), list: a.list, highest: high, now: Int64(5)).reason, 'ordering');
  });

  test('names are checked by size before the box, and a plaintext of exactly 64 bytes is a signature and an empty body', () {
    final a = account();
    NamesResult open(Uint8List sealed, {List<int>? phoneKey}) => e2e.openNames(
        sealed: sealed, accountId: a.accountId, list: a.list, phoneKey: phoneKey ?? a.phone.publicKey, recipientSecretKey: a.clientBox.first.extractBytes(), now: Int64.ZERO);
    expect(open(Uint8List(namesMaxBytes + 1), phoneKey: key(77)).reason, 'size');
    expect(open(Uint8List(namesMaxBytes), phoneKey: key(77)).reason, 'box');
    final sig = sodium.crypto.sign.detached(message: framed(namesContext, [a.accountId, const <int>[]]), secretKey: a.phone.secretKey);
    final r = open(boxed(sig, a.list.devices[1].boxKey, a.phoneBox));
    expect(r.result, 'accepted', reason: r.reason);
    expect(r.names, isEmpty);
    expect(r.ordering, Int64.ZERO);
    expect(r.listCounter, Int64.ZERO);
  });

  test('a name without a signing key is a key like any other: twice is refused, once is for a device off the list', () {
    final a = account();
    Names names(int n) => Names(listCounter: Int64(1), ordering: Int64(5), names: [for (var i = 0; i < n; i++) Name(name: [97])]);
    NamesResult open(Names b) => e2e.openNames(
        sealed: namesSealed(a, b.writeToBuffer()), accountId: a.accountId, list: a.list, phoneKey: a.phone.publicKey, recipientSecretKey: a.clientBox.first.extractBytes(), now: Int64(5));
    expect(open(names(2)).reason, 'duplicate-key');
    final one = open(names(1));
    expect(one.result, 'accepted');
    expect(one.dropped.single.name, 'a');
    expect(one.names, isEmpty);
  });

  test('the maker refuses a nonce of any other length', () {
    final a = account();
    for (final n in [0, 23, 25]) {
      expect(
          () => e2e.makeNamesWithNonces(
              accountId: a.accountId, list: a.list, phone: a.phone, phoneBoxSecretKey: a.phoneBox, ordering: Int64(1000), names: good(a.list), nonceFor: (_) => Uint8List(n)),
          throwsA(isA<NamesCallError>()),
          reason: '$n bytes');
    }
  });

  test('no plaintext makes opening throw, past the box and the prefix', () {
    final a = account();
    final slot = slotOf(a);
    final random = Random(7);
    List<int> bytes(int n) => [for (var i = 0; i < n; i++) random.nextInt(256)];
    final results = <String>{};
    for (var i = 0; i < 300; i++) {
      // Half the bodies are well-formed protobuf holding random bytes in a text field.
      final n = random.nextInt(6);
      final field = bytes(n);
      final body = i.isOdd ? [0x0a, n, ...field] : bytes(random.nextInt(40));
      final namesBody = i.isOdd ? [0x1a, n + 2, 0x12, n, ...field] : body;
      final ordering = Int64(random.nextInt(1 << 30));
      final announcement = e2e.openAnnouncement(
          sealed: sealedFor(a, SealedKind.announcement, slot, ordering, body), slot: slot, recipientSecretKey: a.clientBox.first.extractBytes(), list: a.list, now: Int64(1 << 31));
      final notice = e2e.openNotice(
          sealed: sealedFor(a, SealedKind.notice, slot, ordering, body, toNotice: true), slot: slot, recipientSecretKey: a.noticeSecret.extractBytes(), list: a.list, now: Int64(1 << 31));
      final names = e2e.openNames(
          sealed: namesSealed(a, namesBody), accountId: a.accountId, list: a.list, phoneKey: a.phone.publicKey, recipientSecretKey: a.clientBox.first.extractBytes(), now: Int64(1 << 31));
      // A random signed body, and a random plaintext under no signature at all.
      final unsigned = e2e.openNames(
          sealed: boxed(bytes(random.nextInt(200)), a.list.devices[1].boxKey, a.phoneBox), accountId: a.accountId, list: a.list, phoneKey: a.phone.publicKey,
          recipientSecretKey: a.clientBox.first.extractBytes(), now: Int64(1 << 31));
      for (final r in [announcement.result, notice.result, names.result, unsigned.result]) {
        expect(r, anyOf('accepted', 'later', 'refused'));
      }
      results.addAll(['${announcement.reason}', '${notice.reason}', '${names.reason}']);
    }
    // Random bodies reach the parse and text steps, not only the first refusals.
    expect(results, containsAll(['parse', 'text', 'null']));
  });

  test('no input bytes make opening throw', () {
    final a = account();
    final m = make(a, good(a.list));
    final slot = Slot(accountId: a.accountId, computerKey: key(40), sessionId: utf8.encode('s'));
    final lists = [a.list, ListBody()];
    for (final sealed in [Uint8List(0), Uint8List(40), Uint8List(1000)..fillRange(0, 1000, 0xff), m.copies.first.sealed]) {
      for (final k in [key(1), key(2), a.phoneBox.extractBytes()]) {
        for (final sessionId in [Uint8List(0), utf8.encode('s'), Uint8List.fromList([0xff])]) {
          for (final l in lists) {
            final s = Slot(accountId: slot.accountId, computerKey: slot.computerKey, sessionId: sessionId);
            expect(e2e.openAnnouncement(sealed: sealed, slot: s, recipientSecretKey: k, list: l, now: Int64.ZERO).result, anyOf('accepted', 'refused'));
            expect(e2e.openNotice(sealed: sealed, slot: s, recipientSecretKey: k, list: l, now: Int64.ZERO).result, anyOf('accepted', 'refused'));
            expect(
                e2e.openNames(sealed: sealed, accountId: a.accountId, list: l, phoneKey: a.phone.publicKey, recipientSecretKey: k, now: Int64.ZERO).result,
                anyOf('accepted', 'later', 'refused'));
          }
        }
      }
    }
  });

  test("opening's caller mistakes throw", () {
    final a = account();
    final slot = Slot(accountId: a.accountId, computerKey: key(40), sessionId: utf8.encode('s'));
    final k = key(1);
    void throwsMistake(void Function() f) => expect(f, anyOf(throwsA(isA<SealedCallError>()), throwsA(isA<NamesCallError>())));
    for (final n in [0, 31, 33]) {
      final bad = Uint8List(n);
      throwsMistake(() => e2e.openAnnouncement(sealed: Uint8List(100), slot: slot, recipientSecretKey: bad, list: a.list, now: Int64.ZERO));
      throwsMistake(() => e2e.openNotice(sealed: Uint8List(100), slot: slot, recipientSecretKey: bad, list: a.list, now: Int64.ZERO));
      throwsMistake(() => e2e.openNames(sealed: Uint8List(100), accountId: a.accountId, list: a.list, phoneKey: k, recipientSecretKey: bad, now: Int64.ZERO));
    }
    for (final highest in [Int64(-1), Int64.MIN_VALUE]) {
      throwsMistake(() => e2e.openAnnouncement(sealed: Uint8List(100), slot: slot, recipientSecretKey: k, list: a.list, highest: highest, now: Int64.ZERO));
      throwsMistake(() => e2e.openNotice(sealed: Uint8List(100), slot: slot, recipientSecretKey: k, list: a.list, highest: highest, now: Int64.ZERO));
      throwsMistake(() => e2e.openNames(sealed: Uint8List(100), accountId: a.accountId, list: a.list, phoneKey: k, recipientSecretKey: k, highest: highest, now: Int64.ZERO));
    }
    throwsMistake(() => e2e.openAnnouncement(sealed: Uint8List(100), slot: slot, recipientSecretKey: k, list: a.list, now: Int64(-1)));
    throwsMistake(() => e2e.openNotice(sealed: Uint8List(100), slot: slot, recipientSecretKey: k, list: a.list, now: Int64(-1)));
    throwsMistake(() => e2e.openNames(sealed: Uint8List(100), accountId: a.accountId, list: a.list, phoneKey: k, recipientSecretKey: k, now: Int64(-1)));
  });

  test('the caps are those of the plan, in bytes', () {
    expect(announcementCaps, {'sessionName': 200, 'folder': 1024, 'model': 200, 'computerName': 200, 'notice': 4096});
    expect(noticeCaps, {'sessionName': 200, 'computerName': 200, 'notice': 4096});
    expect([sealedMaxBytes, namesMaxBytes, nameMaxBytes, sessionIdMaxBytes, futureMs], [65536, 32768, 200, 128, 86400000]);
  });

  test('text: malformed UTF-8 is refused, a leading U+FEFF kept', () {
    for (final bad in [
      [0xff],
      [0xc0, 0x80], // overlong
      [0xed, 0xa0, 0x80], // a surrogate
      [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
      [0xe2, 0x82], // cut short
      [0x80],
    ]) {
      expect(utf8Text(bad), isNull, reason: '$bad');
    }
    expect(utf8Text([0xef, 0xbb, 0xbf]), '\ufeff');
    expect(utf8Text([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), '\ufeff\ufeff');
    expect(utf8Text([0x41, 0xef, 0xbb, 0xbf]), 'A\ufeff');
    expect(utf8Text(const []), '');
    expect(utf8Text(utf8.encode('\u{10ffff}')), '\u{10ffff}');
  });

  test('the shared cases are the same files the runner reads', () {
    for (final f in ['sealed.json', 'names.json']) {
      expect(File('../cases/e2e/$f').existsSync(), isTrue);
    }
  });
}
