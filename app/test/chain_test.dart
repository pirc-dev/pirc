// The chain a device follows (app/lib/e2e/chain.dart), and the two sides of
// a join (join.dart's DeviceJoin and ClientJoin) run against each other: a
// port of crypto/test/chain.test.ts.
import 'package:fixnum/fixnum.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:protobuf/well_known_types/google/protobuf/timestamp.pb.dart';

import 'package:pirc/e2e/bytes.dart';
import 'package:pirc/e2e/chain.dart';
import 'package:pirc/e2e/ed25519.dart' as ed25519;
import 'package:pirc/e2e/hpke.dart' as hpke;
import 'package:pirc/e2e/join.dart';
import 'package:pirc/e2e/list.dart';
import 'package:pirc/e2e/objects.dart';
import 'package:pirc/e2e/u64.dart';
import 'package:pirc/gen/pirc/v1alpha2/e2e.pb.dart';

Future<ed25519.Signer> signer(String name) async => ed25519.SeedSigner.fromSeed(await hpke.sha256(utf8('chain test $name')));
final at = Timestamp.fromDateTime(DateTime.utc(2026, 11, 18));

Device dev(DeviceRole role, ed25519.Signer s, [ed25519.Signer? by]) =>
    Device(role: role, publicKey: s.publicKey, addedBy: by?.publicKey ?? empty, addedAt: at);

List<Device> sorted(List<Device> ds) => [...ds]..sort((a, b) => compare(a.publicKey, b.publicKey));

Future<SignedObject> v1(ed25519.Signer phone) => sign(Kind.list, empty, phone,
    ListVersionBody(number: Int64.ONE, devices: [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone)], signer: phone.publicKey));

Future<SignedObject> next(List<int> account, SignedObject prev, int number, List<Device> devices, ed25519.Signer s,
        [List<List<int>> withdrawn = const []]) async =>
    sign(
        Kind.list,
        account,
        s,
        ListVersionBody(
            number: Int64(number),
            previous: await hash(prev),
            devices: sorted(devices),
            withdrawn: withdrawn,
            signer: s.publicKey));

Future<SignedObject> withdrawal(
        List<int> account, ed25519.Signer s, SignedObject mine, SignedObject winner, int number) async =>
    sign(
        Kind.withdrawal,
        account,
        s,
        WithdrawalBody(
            withdrawn: VersionRef(number: Int64(number), hash: await hash(mine)),
            winner: VersionRef(number: Int64(number), hash: await hash(winner)),
            signer: s.publicKey));

void main() {
  test('a chain follows versions, finds forks, and keeps its branch whatever a withdrawal says', () async {
    final phone = await signer('phone'), tablet = await signer('tablet');
    final host = await signer('host'), other = await signer('other');
    final first = await v1(phone);
    final account = await hash(first);
    final d2 = [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone), dev(DeviceRole.DEVICE_ROLE_CLIENT, tablet, phone)];
    final two = await next(account, first, 2, d2, phone);
    final c = await Chain.start(first, account);
    expect(hex(c.accountId), hex(account));

    // Out of order is fine; one that does not chain is refused.
    final three = await next(account, two, 3, [...d2, dev(DeviceRole.DEVICE_ROLE_HOST, host, phone)], phone);
    var ch = await c.add([three, two]);
    expect([for (final v in ch.taken) v.body.number.toInt()], [2, 3]);
    expect(ch.forks, isEmpty);
    final stray = await next(account, first, 3, d2, phone);
    ch = await c.add([stray]);
    expect(ch.refused, hasLength(1));

    // Two clients at once: the relay took the phone's 4; the tablet's 4,
    // seen by this device first, is withdrawn by the tablet.
    final tablet4 = await next(account, three, 4,
        [...d2, dev(DeviceRole.DEVICE_ROLE_HOST, host, phone), dev(DeviceRole.DEVICE_ROLE_HOST, other, tablet)], tablet);
    final phone4 = await next(account, three, 4, d2, phone);
    await c.add([tablet4]);
    expect(c.latest.body.number.toInt(), 4);
    expect(hex(c.latest.hash), hex(await hash(tablet4)));
    ch = await c.add([phone4]);
    expect(ch.forks, hasLength(1), reason: 'a fork until a withdrawal explains it');
    expect(hex(c.latest.hash), hex(await hash(tablet4)), reason: 'the branch stays');
    expect(c.undecided(), isNull, reason: 'it took a side');
    // A withdrawal by someone else than the signer does not count.
    ch = await c.add([], [await withdrawal(account, phone, tablet4, phone4, 4)]);
    expect(ch.refused, hasLength(1));
    ch = await c.add([], [await withdrawal(account, tablet, tablet4, phone4, 4)]);
    // The withdrawal moves nothing: the device keeps the version it took.
    // That version lost, so the fork stands: the device is on the losing side.
    expect([for (final v in ch.forks) hex(v.hash)], [hex(await hash(phone4))]);
    expect(ch.taken, isEmpty);
    expect(c.isWithdrawn(await hash(tablet4)), isTrue);
    expect(hex(c.latest.hash), hex(await hash(tablet4)));

    // Saved and loaded: the same branch, and the version built on the
    // other side is not followed.
    final five = await next(account, phone4, 5, d2, tablet, [await hash(tablet4)]);
    await c.add([five]);
    expect(hex(c.latest.hash), hex(await hash(tablet4)));
    final again = await Chain.load(c.saved(), account);
    expect(hex(again.latest.hash), hex(await hash(tablet4)));
    expect(again.withdrawals(), hasLength(1));
    expect(again.onBranch(Int64(4), await hash(tablet4)), isTrue);
    expect(() => Chain.load(c.saved(), List.filled(32, 0)), throwsA(isA<Refused>()));

    // A device that has taken neither: shown both and the withdrawal, it
    // takes neither still, in any order (the withdrawal's signer may be a
    // device removed since).
    for (final order in [
      [
        [two, three, tablet4, phone4]
      ],
      [
        [two, three, tablet4],
        [phone4]
      ],
    ]) {
      final c2 = await Chain.start(first);
      for (final (i, vs) in order.indexed) {
        await c2.add(vs, i == 0 ? [await withdrawal(account, tablet, tablet4, phone4, 4)] : const []);
      }
      expect(c2.isWithdrawn(await hash(tablet4)), isTrue);
      if (order.length == 1) expect(c2.undecided(), isNotNull, reason: 'both at once: neither taken');
      if (order.length == 2) expect(hex(c2.latest.hash), hex(await hash(tablet4)), reason: 'it took the one it saw first');
    }

    // Two versions at once, from the tip, neither withdrawn: undecided.
    final c3 = await Chain.start(first);
    await c3.add([two, three]);
    await c3.add([tablet4, phone4]);
    expect(c3.latest.body.number.toInt(), 3);
    expect(c3.undecided(), isNotNull);
  });

  test('a join between the two sides, and a wrong code', () async {
    const origin = 'wss://relay.test';
    final host = await signer('joining host');
    final code = newCode();
    final c0 = (lookup: code.lookup, secret: code.secret);
    final d = await DeviceJoin.start(origin, c0, role: DeviceRole.DEVICE_ROLE_HOST, signer: host, name: 'build box');
    final c = await ClientJoin.answer(origin, c0, d.offer);
    final confirm = await d.join.onAnswer(c.answer);
    final device = await c.join.onConfirm(confirm);
    expect(device.role, DeviceRole.DEVICE_ROLE_HOST);
    expect(hex(device.publicKey), hex(host.publicKey));
    expect(device.name, 'build box');
    final approval = JoinApproval(accountId: List.filled(32, 1));
    final result = await d.join.onResult(await c.join.result(JoinResult(approval: approval)));
    expect(result.whichResult(), JoinResult_Result.approval);
    expect(hex(result.approval.accountId), hex(approval.accountId));

    // A wrong secret: the device finds the client's confirmation wrong.
    final d2 = await DeviceJoin.start(origin, c0, role: DeviceRole.DEVICE_ROLE_HOST, signer: host, name: 'x');
    final wrong = (lookup: code.lookup, secret: code.secret == '00000' ? '00001' : '00000');
    final a2 = await ClientJoin.answer(origin, wrong, d2.offer);
    await expectLater(d2.join.onAnswer(a2.answer), throwsA(isA<JoinFailed>()));
    // Another relay's origin, likewise.
    final d3 = await DeviceJoin.start(origin, c0, role: DeviceRole.DEVICE_ROLE_HOST, signer: host, name: 'x');
    final a3 = await ClientJoin.answer('wss://other.test', c0, d3.offer);
    await expectLater(d3.join.onAnswer(a3.answer), throwsA(isA<JoinFailed>()));
    // Steps out of order.
    await expectLater(c.join.onConfirm(d.offer), throwsA(isA<JoinFailed>()));
  });

  test('a name is cut to 128 bytes on a character boundary', () {
    final long = 'é' * 100; // 200 bytes
    final cut = cutName(long);
    expect(utf8(cut).length, 128);
    expect(cut, 'é' * 64);
    expect(cutName('a${'é' * 64}'), 'a${'é' * 63}');
  });

  test('a branch kept at a fork is the branch after save and load', () async {
    final phone = await signer('phone'), tablet = await signer('tablet'), thief = await signer('thief');
    final first = await sign(Kind.list, empty, phone,
        ListVersionBody(number: Int64.ONE, devices: [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone)], signer: phone.publicKey));
    final account = await hash(first);
    final all = [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone), dev(DeviceRole.DEVICE_ROLE_CLIENT, tablet, phone), dev(DeviceRole.DEVICE_ROLE_CLIENT, thief, phone)];
    final two = await next(account, first, 2, all, phone);
    // The phone removes the thief in 3 and adopts it; 4 follows.
    final kept = [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone), dev(DeviceRole.DEVICE_ROLE_CLIENT, tablet, phone)];
    final three = await next(account, two, 3, kept, phone);
    final four = await next(account, three, 4, kept, tablet);
    final c = await Chain.start(first, account);
    await c.add([two, three, four]);
    expect(c.latest.body.number.toInt(), 4);
    // The removed thief's key signs another 3, on 2, which the relay shows.
    final thief3 = await next(account, two, 3, [dev(DeviceRole.DEVICE_ROLE_CLIENT, thief, phone)..addedBy = phone.publicKey, dev(DeviceRole.DEVICE_ROLE_CLIENT, tablet, phone)], thief);
    final ch = await c.add([thief3]);
    expect(ch.forks, hasLength(1));
    expect(c.latest.body.number.toInt(), 4, reason: 'keeps its branch');
    expect(c.undecided(), isNull);
    final again = await Chain.load(c.saved(), account);
    expect(again.undecided(), isNull, reason: 'after a restart it still took a side');
    expect(again.latest.body.number.toInt(), 4, reason: 'after a restart the same branch');
  });

  test('withdrawals of versions not seen: kept only from a key some version has as a client, and only so many', () async {
    final phone = await signer('phone'), stranger = await signer('stranger');
    final first = await sign(Kind.list, empty, phone,
        ListVersionBody(number: Int64.ONE, devices: [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone)], signer: phone.publicKey));
    final account = await hash(first);
    final c = await Chain.start(first, account);
    Future<SignedObject> unseen(ed25519.Signer s, int i) => sign(Kind.withdrawal, account, s,
        WithdrawalBody(
            withdrawn: VersionRef(number: Int64(40), hash: List.filled(32, i)),
            winner: VersionRef(number: Int64(40), hash: List.filled(32, 255)),
            signer: s.publicKey));
    final ch = await c.add([], [await unseen(stranger, 1)]);
    expect(ch.refused, hasLength(1));
    expect(c.withdrawals(), isEmpty);
    // One signer's: a few, its oldest let go.
    for (var i = 0; i < maxUncheckedPerSigner + 3; i++) {
      await c.add([], [await unseen(phone, i)]);
    }
    expect(c.withdrawals(), hasLength(maxUncheckedPerSigner));
    // Of many clients: so many in all.
    final many = [for (var i = 0; i < 10; i++) await signer('client $i')];
    final c2 = await Chain.start(first, account);
    await c2.add([
      await next(account, first, 2, [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone), for (final m in many) dev(DeviceRole.DEVICE_ROLE_CLIENT, m, phone)], phone)
    ]);
    for (var j = 0; j < many.length; j++) {
      for (var i = 0; i < maxUncheckedPerSigner; i++) {
        await c2.add([], [await unseen(many[j], 100 + j * maxUncheckedPerSigner + i)]);
      }
    }
    expect(c2.withdrawals(), hasLength(maxUnchecked));
  });

  test("a removed client cannot take back an old version of its own: a withdrawal names another device's version beside it", () async {
    final phone = await signer('phone'), tablet = await signer('tablet'), thief = await signer('thief'), evil = await signer('evil');
    const c = DeviceRole.DEVICE_ROLE_CLIENT;
    final first = await sign(Kind.list, empty, phone, ListVersionBody(number: Int64.ONE, devices: [dev(c, phone)], signer: phone.publicKey));
    final account = await hash(first);
    final two = await next(account, first, 2, [dev(c, phone), dev(c, thief, phone)], phone);
    // The thief signs 3; the phone removes it in 4; the tablet signs 5.
    final three = await next(account, two, 3, [dev(c, phone), dev(c, thief, phone), dev(c, tablet, thief)], thief);
    final four = await next(account, three, 4, [dev(c, phone), dev(c, tablet, thief)], phone);
    final five = await next(account, four, 5, [dev(c, phone), dev(c, tablet, thief)], tablet);
    // Its stolen key signs another 3 on 2, keeping itself, and withdraws its
    // old 3 naming that one.
    final alt = await next(account, two, 3, [dev(c, thief, phone), dev(c, evil, thief)], thief);
    Future<SignedObject> takeBack(List<int> winner) async => sign(Kind.withdrawal, account, thief,
        WithdrawalBody(withdrawn: VersionRef(number: Int64(3), hash: await hash(three)), winner: VersionRef(number: Int64(3), hash: winner), signer: thief.publicKey));
    final w = await takeBack(await hash(alt));
    // In every order: refused once both are here, and the thief's 3 never
    // followed (shown both 3s at once, a device takes neither, a fork it
    // was never part of, and is joined again).
    for (final order in [
      [
        [two, three, four, five, alt]
      ],
      [
        [two, three],
        [alt],
        [four, five]
      ],
      [
        [two, three, alt],
        [four, five]
      ],
    ]) {
      final ch = await Chain.start(first, account);
      final refused = <String>[];
      for (final (i, vs) in order.indexed) {
        refused.addAll([for (final r in (await ch.add(vs, i == 0 ? [w] : const [])).refused) r.reason]);
      }
      expect(refused, contains(contains("not another device's version")), reason: '$order');
      expect(ch.isWithdrawn(await hash(three)), isFalse);
      final altHash = hex(await hash(alt));
      expect(ch.from(Int64.ONE).any((v) => hex(v.hash) == altHash), isFalse);
      final tip = ch.undecided() == null ? hex(await hash(five)) : hex(await hash(two));
      expect(hex(ch.latest.hash), tip);
      expect(hex((await Chain.load(ch.saved(), account)).latest.hash), tip);
    }
    // Naming a winner no one shows: kept, never counting.
    final ch = await Chain.start(first, account);
    await ch.add([two, three, four, five], [await takeBack(List.filled(32, 9))]);
    expect(ch.isWithdrawn(await hash(three)), isFalse);
    expect(ch.latest.body.number, Int64(5));
  });

  test("a lost version's withdrawal moves no device, whatever the order; it explains the fork", () async {
    final phone = await signer('phone'), tablet = await signer('tablet'), laptop = await signer('laptop');
    const c = DeviceRole.DEVICE_ROLE_CLIENT;
    final first = await sign(Kind.list, empty, phone, ListVersionBody(number: Int64.ONE, devices: [dev(c, phone)], signer: phone.publicKey));
    final account = await hash(first);
    final all = [dev(c, phone), dev(c, tablet, phone), dev(c, laptop, phone)];
    final two = await next(account, first, 2, all, phone);
    final lost = await next(account, two, 3, [dev(c, phone), dev(c, tablet, phone)], tablet);
    final won = await next(account, two, 3, [dev(c, phone), dev(c, laptop, phone)], phone);
    // The laptop, shown the lost one, built on it.
    final onLost = await next(account, lost, 4, [dev(c, phone), dev(c, tablet, phone)], tablet);
    final w = await sign(Kind.withdrawal, account, tablet,
        WithdrawalBody(withdrawn: VersionRef(number: Int64(3), hash: await hash(lost)), winner: VersionRef(number: Int64(3), hash: await hash(won)), signer: tablet.publicKey));
    for (final order in [
      [
        [two, lost],
        [won],
        [onLost]
      ],
      [
        [two, lost, onLost],
        [won]
      ],
      [
        [two, won],
        [lost, onLost]
      ],
    ]) {
      final ch = await Chain.start(first, account);
      for (final vs in order) {
        await ch.add(vs);
      }
      final before = hex(ch.latest.hash);
      final got = await ch.add([], [w]);
      // The withdrawal moved nothing. It explains the fork to a device on
      // the side that won; on the side that lost, the fork stands.
      final lostSide = hex(ch.at(Int64(3))!.hash) == hex(await hash(lost));
      expect(got.forks, hasLength(lostSide ? 1 : 0), reason: '$order');
      expect(hex(ch.latest.hash), before, reason: '$order');
      expect(ch.isWithdrawn(await hash(lost)), isTrue);
      expect(hex((await Chain.load(ch.saved(), account)).latest.hash), hex(ch.latest.hash));
    }
  });

  test('a fork of two versions saves the same whatever order they came in', () async {
    final phone = await signer('phone'), tablet = await signer('tablet');
    const c = DeviceRole.DEVICE_ROLE_CLIENT;
    final first = await sign(Kind.list, empty, phone, ListVersionBody(number: Int64.ONE, devices: [dev(c, phone)], signer: phone.publicKey));
    final account = await hash(first);
    final two = await next(account, first, 2, [dev(c, phone), dev(c, tablet, phone)], phone);
    final a = await next(account, two, 3, [dev(c, phone)], tablet);
    final b = await next(account, two, 3, [dev(c, tablet, phone)], phone);
    // Taken in one add: in hash order, whatever the order given.
    Future<String> forks(List<SignedObject> order) async {
      final ch = await Chain.start(first, account);
      await ch.add([two]);
      return [for (final v in (await ch.add(order)).forks) hex(v.hash)].join(',');
    }
    expect(await forks([a, b]), await forks([b, a]));
    // Taken in two adds, a third beside them so that none is followed:
    // saved in hash order all the same.
    final x = await next(account, two, 3, [dev(c, phone), dev(c, tablet, phone)], tablet);
    Future<String> saved(SignedObject one, SignedObject other) async {
      final ch = await Chain.start(first, account);
      await ch.add([two, one, x]);
      await ch.add([other]);
      return [for (final o in ch.saved().others) hex(encode(o))].join(',');
    }
    expect(await saved(a, b), await saved(b, a));
  });

  test("an unseen withdrawal another key names first does not take the honest one's place", () async {
    final phone = await signer('phone'), tablet = await signer('tablet');
    const c = DeviceRole.DEVICE_ROLE_CLIENT;
    final first = await sign(Kind.list, empty, phone, ListVersionBody(number: Int64.ONE, devices: [dev(c, phone)], signer: phone.publicKey));
    final account = await hash(first);
    final two = await next(account, first, 2, [dev(c, phone), dev(c, tablet, phone)], phone);
    final lost = await next(account, two, 3, [dev(c, phone)], tablet);
    final won = await next(account, two, 3, [dev(c, tablet, phone)], phone);
    Future<SignedObject> withdrawal(ed25519.Signer s) async => sign(Kind.withdrawal, account, s,
        WithdrawalBody(withdrawn: VersionRef(number: Int64(3), hash: await hash(lost)), winner: VersionRef(number: Int64(3), hash: await hash(won)), signer: s.publicKey));
    // The other key's first, or the honest one's: either way only the
    // honest one is kept, and the chain loads.
    for (final firstBy in [phone, tablet]) {
      final ch = await Chain.start(first, account);
      await ch.add([two], [await withdrawal(firstBy)]);
      await ch.add([], [await withdrawal(firstBy == phone ? tablet : phone)]);
      await ch.add([lost, won]);
      expect(ch.isWithdrawn(await hash(lost)), isTrue);
      expect(ch.withdrawals(), hasLength(1));
      expect((await Chain.load(ch.saved(), account)).isWithdrawn(await hash(lost)), isTrue);
    }
    // The same key naming another winner first, one never shown: the
    // honest one is kept beside it, and counts.
    final bogus = await next(account, two, 3, [dev(c, phone), dev(c, tablet, phone)], tablet, [List.filled(32, 9)]);
    final ch = await Chain.start(first, account);
    await ch.add([two], [
      await sign(Kind.withdrawal, account, tablet,
          WithdrawalBody(withdrawn: VersionRef(number: Int64(3), hash: await hash(lost)), winner: VersionRef(number: Int64(3), hash: await hash(bogus)), signer: tablet.publicKey))
    ]);
    await ch.add([], [await withdrawal(tablet)]);
    await ch.add([lost, won]);
    expect(ch.isWithdrawn(await hash(lost)), isTrue, reason: "the honest winner's withdrawal counts");
  });

  test('a device shown the code takes one answer: a right one after a wrong one is refused', () async {
    const origin = 'wss://relay.test';
    final host = await signer('joining host');
    final code = newCode();
    final d = await DeviceJoin.start(origin, (lookup: code.lookup, secret: code.secret), role: DeviceRole.DEVICE_ROLE_HOST, signer: host, name: 'x');
    final wrong = await ClientJoin.answer(origin, (lookup: code.lookup, secret: code.secret == '00000' ? '00001' : '00000'), d.offer);
    await expectLater(d.join.onAnswer(wrong.answer), throwsA(isA<JoinFailed>()));
    final right = await ClientJoin.answer(origin, (lookup: code.lookup, secret: code.secret), d.offer);
    await expectLater(d.join.onAnswer(right.answer), throwsA(isA<JoinFailed>()));
  });

  test('versions from a number past the branch, from 2^63 on too, are none', () async {
    final phone = await signer('phone');
    final first = await sign(Kind.list, empty, phone,
        ListVersionBody(number: Int64.ONE, devices: [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone)], signer: phone.publicKey));
    final account = await hash(first);
    final ch = await Chain.start(first, account);
    await ch.add([await next(account, first, 2, [dev(DeviceRole.DEVICE_ROLE_CLIENT, phone)], phone)]);
    expect(ch.from(Int64(2)), hasLength(1));
    expect(ch.from(Int64(3)), isEmpty);
    for (final n in [Int64.MIN_VALUE, Int64.MIN_VALUE + 1, Int64(-1)]) {
      expect(ch.from(n), isEmpty, reason: n.toStringUnsigned());
      expect(ch.at(n), isNull, reason: n.toStringUnsigned());
    }
  });

  test('uint64s compared and written unsigned', () {
    final top = Int64(-1), half = Int64.MIN_VALUE, below = Int64.MAX_VALUE;
    expect(compareU64(below, half), lessThan(0));
    expect(compareU64(half, top), lessThan(0));
    expect(gtU64(top, Int64.ONE), isTrue);
    expect(geU64(half, half), isTrue);
    expect([u64Text(below), u64Text(half), u64Text(top)], ['9223372036854775807', '9223372036854775808', '18446744073709551615']);
  });

  test('on the withdrawn side, the fork stands though the other side is withdrawn too', () async {
    final phone = await signer('phone'), thief = await signer('thief');
    const c = DeviceRole.DEVICE_ROLE_CLIENT;
    final first = await sign(Kind.list, empty, phone, ListVersionBody(number: Int64.ONE, devices: [dev(c, phone)], signer: phone.publicKey));
    final account = await hash(first);
    final two = await next(account, first, 2, [dev(c, phone), dev(c, thief, phone)], phone);
    final three = await next(account, two, 3, [dev(c, phone)], phone);
    final x = await next(account, two, 3, [dev(c, phone), dev(c, thief, phone)], thief);
    Future<SignedObject> w(ed25519.Signer s, SignedObject mine, SignedObject winner) async => sign(Kind.withdrawal, account, s,
        WithdrawalBody(withdrawn: VersionRef(number: Int64(3), hash: await hash(mine)), winner: VersionRef(number: Int64(3), hash: await hash(winner)), signer: s.publicKey));
    final ch = await Chain.start(first, account);
    await ch.add([two, x]);
    final got = await ch.add([three], [await w(thief, x, three), await w(phone, three, x)]);
    expect(ch.isWithdrawn(await hash(x)) && ch.isWithdrawn(await hash(three)), isTrue);
    expect(got.forks, hasLength(1));
    expect(ch.forks(), hasLength(1));
  });
}
