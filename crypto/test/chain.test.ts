// The chain a device follows (chain.ts), and the two sides of a join
// (join.ts's DeviceJoin and ClientJoin) run against each other.

import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { DeviceRole, DeviceSchema, JoinApprovalSchema, VersionRefSchema, type Device, type SignedObject } from "@pirc/protocol/v1alpha2";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, hex, utf8 } from "../bytes.ts";
import { Chain, MAX_UNCHECKED, MAX_UNCHECKED_PER_SIGNER } from "../chain.ts";
import * as ed25519 from "../ed25519.ts";
import { sha256 } from "../hpke.ts";
import { ClientJoin, DeviceJoin, JoinFailed, newCode } from "../join.ts";
import { encode, hash, sign } from "../objects.ts";

const signer = async (name: string) => ed25519.fromSeed(await sha256(utf8(`chain test ${name}`)));
const at = timestampFromMs(Date.UTC(2026, 10, 18));

function dev(role: DeviceRole, s: ed25519.Signer, by?: ed25519.Signer): Device {
  return create(DeviceSchema, { role, publicKey: s.publicKey, addedBy: by?.publicKey ?? new Uint8Array(0), addedAt: at });
}

const sorted = (ds: Device[]) => [...ds].sort((a, b) => compare(a.publicKey, b.publicKey));

async function v1(phone: ed25519.Signer) {
  return sign("list", new Uint8Array(0), phone, { $typeName: "pirc.v1alpha2.ListVersionBody", number: 1n, previous: new Uint8Array(0), devices: [dev(DeviceRole.CLIENT, phone)], withdrawn: [], signer: phone.publicKey });
}

async function next(account: Uint8Array, prev: SignedObject, number: bigint, devices: Device[], s: ed25519.Signer, withdrawn: Uint8Array[] = []) {
  return sign("list", account, s, { $typeName: "pirc.v1alpha2.ListVersionBody", number, previous: await hash(prev), devices: sorted(devices), withdrawn, signer: s.publicKey });
}

async function withdrawal(account: Uint8Array, s: ed25519.Signer, mine: SignedObject, winner: SignedObject, number: bigint) {
  return sign("withdrawal", account, s, {
    $typeName: "pirc.v1alpha2.WithdrawalBody",
    withdrawn: { $typeName: "pirc.v1alpha2.VersionRef", number, hash: await hash(mine) },
    winner: { $typeName: "pirc.v1alpha2.VersionRef", number, hash: await hash(winner) },
    signer: s.publicKey,
  });
}

test("a chain follows versions, finds forks, and keeps its branch whatever a withdrawal says", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), host = await signer("host"), other = await signer("other");
  const first = await v1(phone);
  const account = await hash(first);
  const d2 = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone)];
  const two = await next(account, first, 2n, d2, phone);
  const c = await Chain.start(first, account);
  assert.equal(hex(c.accountId), hex(account));

  // Out of order is fine; one that does not chain is refused.
  const three = await next(account, two, 3n, [...d2, dev(DeviceRole.HOST, host, phone)], phone);
  let ch = await c.add([three, two]);
  assert.deepEqual(ch.taken.map((v) => v.body.number), [2n, 3n]);
  assert.equal(ch.forks.length, 0);
  const stray = await next(account, first, 3n, d2, phone);
  ch = await c.add([stray]);
  assert.equal(ch.refused.length, 1);

  // Two clients at once: the relay took the phone's 4; the tablet's 4,
  // seen by this device first, is withdrawn by the tablet.
  const tablet4 = await next(account, three, 4n, [...d2, dev(DeviceRole.HOST, host, phone), dev(DeviceRole.HOST, other, tablet)], tablet);
  const phone4 = await next(account, three, 4n, d2, phone);
  ch = await c.add([tablet4]);
  assert.equal(c.latest.body.number, 4n);
  assert.equal(hex(c.latest.hash), hex(await hash(tablet4)));
  ch = await c.add([phone4]);
  assert.equal(ch.forks.length, 1, "a fork until a withdrawal explains it");
  assert.equal(hex(c.latest.hash), hex(await hash(tablet4)), "the branch stays");
  // A withdrawal by someone else than the signer does not count.
  ch = await c.add([], [await withdrawal(account, phone, tablet4, phone4, 4n)]);
  assert.equal(ch.refused.length, 1);
  ch = await c.add([], [await withdrawal(account, tablet, tablet4, phone4, 4n)]);
  // The withdrawal moves nothing: the device keeps the version it took.
  // That version lost, so the fork stands: the device is on the losing side.
  assert.equal(ch.forks.length, 1);
  assert.equal(hex(ch.forks[0].hash), hex(await hash(phone4)));
  assert.equal(ch.taken.length, 0);
  assert.ok(c.isWithdrawn(await hash(tablet4)));
  assert.equal(hex(c.latest.hash), hex(await hash(tablet4)));

  // Saved and loaded: the same branch, and the version built on the other
  // side is not followed.
  const five = await next(account, phone4, 5n, d2, tablet, [await hash(tablet4)]);
  await c.add([five]);
  assert.equal(hex(c.latest.hash), hex(await hash(tablet4)));
  const again = await Chain.load(c.saved(), account);
  assert.equal(hex(again.latest.hash), hex(await hash(tablet4)));
  assert.equal(again.withdrawals().length, 1);
  await assert.rejects(Chain.load(c.saved(), new Uint8Array(32)));

  // A device that has taken neither: shown both and the withdrawal, it takes
  // neither still, in any order (the withdrawal's signer may be a device
  // removed since); one that saw one first keeps it.
  for (const order of [[[two, three, tablet4, phone4]], [[two, three, tablet4], [phone4]]]) {
    const c2 = await Chain.start(first);
    for (const [i, vs] of order.entries()) await c2.add(vs, i === 0 ? [await withdrawal(account, tablet, tablet4, phone4, 4n)] : []);
    assert.ok(c2.isWithdrawn(await hash(tablet4)));
    if (order.length === 1) assert.ok(c2.undecided(), "both at once: neither taken");
    else assert.equal(hex(c2.latest.hash), hex(await hash(tablet4)), "it took the one it saw first");
  }
});

test("a join between the two sides, and a wrong code", async () => {
  const origin = "wss://relay.test";
  const host = await signer("joining host");
  const code = newCode();
  const { join: d, offer } = await DeviceJoin.start(origin, code, { role: DeviceRole.HOST, signer: host, name: "build box" });
  const { join: c, answer } = await ClientJoin.answer(origin, code, offer);
  const confirm = await d.onAnswer(answer);
  const device = await c.onConfirm(confirm);
  assert.equal(device.role, DeviceRole.HOST);
  assert.equal(hex(device.publicKey), hex(host.publicKey));
  assert.equal(device.name, "build box");
  const approval = create(JoinApprovalSchema, { accountId: new Uint8Array(32).fill(1) });
  const result = await d.onResult(await c.result({ case: "approval", value: approval }));
  assert.equal(result.case, "approval");
  assert.equal(hex(result.value!.accountId as Uint8Array), hex(approval.accountId));

  // A wrong secret: the device finds the client's confirmation wrong.
  const { join: d2, offer: o2 } = await DeviceJoin.start(origin, code, { role: DeviceRole.HOST, signer: host, name: "x" });
  const wrong = { lookup: code.lookup, secret: code.secret === "00000" ? "00001" : "00000" };
  const { answer: a2 } = await ClientJoin.answer(origin, wrong, o2);
  await assert.rejects(d2.onAnswer(a2), JoinFailed);
  // Another relay's origin, likewise.
  const { join: d3, offer: o3 } = await DeviceJoin.start(origin, code, { role: DeviceRole.HOST, signer: host, name: "x" });
  const { answer: a3 } = await ClientJoin.answer("wss://other.test", code, o3);
  await assert.rejects(d3.onAnswer(a3), JoinFailed);
  // Steps out of order.
  await assert.rejects(c.onConfirm(offer), JoinFailed);
});

test("withdrawals of versions not seen: kept only from a key some version has as a client, and only so many", async () => {
  const phone = await signer("phone"), stranger = await signer("stranger");
  const first = await v1(phone);
  const account = await hash(first);
  const c = await Chain.start(first, account);
  const unseen = async (s: ed25519.Signer, i: number) =>
    sign("withdrawal", account, s, {
      $typeName: "pirc.v1alpha2.WithdrawalBody",
      withdrawn: create(VersionRefSchema, { number: 40n, hash: new Uint8Array(32).fill(i) }),
      winner: create(VersionRefSchema, { number: 40n, hash: new Uint8Array(32).fill(255) }),
      signer: s.publicKey,
    });
  const ch = await c.add([], [await unseen(stranger, 1)]);
  assert.equal(ch.refused.length, 1);
  assert.equal(c.withdrawals().length, 0);
  // One signer's: a few, its oldest let go.
  for (let i = 0; i < MAX_UNCHECKED_PER_SIGNER + 3; i++) await c.add([], [await unseen(phone, i)]);
  assert.equal(c.withdrawals().length, MAX_UNCHECKED_PER_SIGNER);
  // Of many clients: so many in all.
  const many = await Promise.all([...Array(10).keys()].map((i) => signer(`client ${i}`)));
  const c2 = await Chain.start(first, account);
  await c2.add([await next(account, first, 2n, [dev(DeviceRole.CLIENT, phone), ...many.map((m) => dev(DeviceRole.CLIENT, m, phone))], phone)]);
  for (const [j, m] of many.entries()) for (let i = 0; i < MAX_UNCHECKED_PER_SIGNER; i++) await c2.add([], [await unseen(m, 100 + j * MAX_UNCHECKED_PER_SIGNER + i)]);
  assert.equal(c2.withdrawals().length, MAX_UNCHECKED);
});

test("a branch kept at a fork is the branch after save and load", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), thief = await signer("thief");
  const first = await v1(phone);
  const account = await hash(first);
  const all = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone), dev(DeviceRole.CLIENT, thief, phone)];
  const two = await next(account, first, 2n, all, phone);
  // The phone removes the thief in 3 and adopts it; 4 follows.
  const kept = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone)];
  const three = await next(account, two, 3n, kept, phone);
  const four = await next(account, three, 4n, kept, tablet);
  const c = await Chain.start(first, account);
  await c.add([two, three, four]);
  // The removed thief's key signs another 3, on 2, which the relay shows.
  const thief3 = await next(account, two, 3n, [dev(DeviceRole.CLIENT, tablet, phone), dev(DeviceRole.CLIENT, thief, phone)], thief);
  const ch = await c.add([thief3]);
  assert.equal(ch.forks.length, 1);
  assert.equal(c.latest.body.number, 4n, "keeps its branch");
  assert.equal(c.undecided(), undefined);
  const again = await Chain.load(c.saved(), account);
  assert.equal(again.undecided(), undefined, "after a restart it still took a side");
  assert.equal(hex(again.latest.hash), hex(await hash(four)), "after a restart the same branch");
});

test("a removed client cannot take back an old version of its own: a withdrawal names another device's version beside it", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), thief = await signer("thief"), evil = await signer("evil");
  const C = DeviceRole.CLIENT;
  const first = await v1(phone);
  const account = await hash(first);
  const two = await next(account, first, 2n, [dev(C, phone), dev(C, thief, phone)], phone);
  // The thief signs 3; the phone removes it in 4; the tablet signs 5.
  const three = await next(account, two, 3n, [dev(C, phone), dev(C, thief, phone), dev(C, tablet, thief)], thief);
  const four = await next(account, three, 4n, [dev(C, phone), dev(C, tablet, thief)], phone);
  const five = await next(account, four, 5n, [dev(C, phone), dev(C, tablet, thief)], tablet);
  // Its stolen key signs another 3 on 2, keeping itself, and withdraws its
  // old 3 naming that one.
  const alt = await next(account, two, 3n, [dev(C, thief, phone), dev(C, evil, thief)], thief);
  const takeBack = async (winner: Uint8Array) =>
    sign("withdrawal", account, thief, {
      $typeName: "pirc.v1alpha2.WithdrawalBody",
      withdrawn: create(VersionRefSchema, { number: 3n, hash: await hash(three) }),
      winner: create(VersionRefSchema, { number: 3n, hash: winner }),
      signer: thief.publicKey,
    });
  const w = await takeBack(await hash(alt));
  // In every order: refused once both are here, and the thief's 3 never
  // followed (shown both 3s at once, a device takes neither, a fork it was
  // never part of, and is joined again).
  for (const order of [[[two, three, four, five, alt]], [[two, three], [alt], [four, five]], [[two, three, alt], [four, five]]]) {
    const c = await Chain.start(first, account);
    const refused: string[] = [];
    for (const [i, vs] of order.entries()) refused.push(...(await c.add(vs, i === 0 ? [w] : [])).refused.map((r) => r.reason));
    assert.ok(refused.some((r) => r.includes("not another device's version")));
    assert.ok(!c.isWithdrawn(await hash(three)));
    const altHash = hex(await hash(alt));
    assert.ok(!c.from(1n).some((v) => hex(v.hash) === altHash));
    const tip = c.undecided() ? hex(await hash(two)) : hex(await hash(five));
    assert.equal(hex(c.latest.hash), tip);
    assert.equal(hex((await Chain.load(c.saved(), account)).latest.hash), tip);
  }
  // Naming a winner no one shows: kept, never counting.
  const c = await Chain.start(first, account);
  await c.add([two, three, four, five], [await takeBack(new Uint8Array(32).fill(9))]);
  assert.ok(!c.isWithdrawn(await hash(three)));
  assert.equal(c.latest.body.number, 5n);
});

test("a lost version's withdrawal moves no device, whatever the order; it explains the fork", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), laptop = await signer("laptop");
  const C = DeviceRole.CLIENT;
  const first = await v1(phone);
  const account = await hash(first);
  const two = await next(account, first, 2n, [dev(C, phone), dev(C, tablet, phone), dev(C, laptop, phone)], phone);
  const lost = await next(account, two, 3n, [dev(C, phone), dev(C, tablet, phone)], tablet);
  const won = await next(account, two, 3n, [dev(C, phone), dev(C, laptop, phone)], phone);
  // The laptop, shown the lost one, built on it.
  const onLost = await next(account, lost, 4n, [dev(C, phone), dev(C, tablet, phone)], tablet);
  const w = await sign("withdrawal", account, tablet, {
    $typeName: "pirc.v1alpha2.WithdrawalBody",
    withdrawn: create(VersionRefSchema, { number: 3n, hash: await hash(lost) }),
    winner: create(VersionRefSchema, { number: 3n, hash: await hash(won) }),
    signer: tablet.publicKey,
  });
  for (const order of [[[two, lost], [won], [onLost]], [[two, lost, onLost], [won]], [[two, won], [lost, onLost]]]) {
    const c = await Chain.start(first, account);
    for (const vs of order) await c.add(vs);
    const before = hex(c.latest.hash);
    const got = await c.add([], [w]);
    // The withdrawal moved nothing. It explains the fork to a device on the
    // side that won; on the side that lost, the fork stands.
    const lostSide = hex(c.at(3n)!.hash) === hex(await hash(lost));
    assert.equal(got.forks.length, lostSide ? 1 : 0);
    assert.equal(hex(c.latest.hash), before);
    assert.ok(c.isWithdrawn(await hash(lost)));
    assert.equal(hex((await Chain.load(c.saved(), account)).latest.hash), hex(c.latest.hash));
  }
});

test("a fork of two versions saves the same whatever order they came in", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet");
  const first = await v1(phone);
  const account = await hash(first);
  const two = await next(account, first, 2n, [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone)], phone);
  const a = await next(account, two, 3n, [dev(DeviceRole.CLIENT, phone)], tablet);
  const b = await next(account, two, 3n, [dev(DeviceRole.CLIENT, tablet, phone)], phone);
  // Taken in one add: in hash order, whatever the order given.
  const forks = async (order: SignedObject[]) => {
    const c = await Chain.start(first, account);
    await c.add([two]);
    return (await c.add(order)).forks.map((v) => hex(v.hash)).join(",");
  };
  assert.equal(await forks([a, b]), await forks([b, a]));
  // Taken in two adds, a third beside them so that none is followed:
  // saved in hash order all the same.
  const x = await next(account, two, 3n, [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone)], tablet);
  const saved = async (one: SignedObject, other: SignedObject) => {
    const c = await Chain.start(first, account);
    await c.add([two, one, x]);
    await c.add([other]);
    return c.saved().others.map((o) => hex(encode(o))).join(",");
  };
  assert.equal(await saved(a, b), await saved(b, a));
});

test("an unseen withdrawal another key names first does not take the honest one's place", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet");
  const first = await v1(phone);
  const account = await hash(first);
  const two = await next(account, first, 2n, [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone)], phone);
  const lost = await next(account, two, 3n, [dev(DeviceRole.CLIENT, phone)], tablet);
  const won = await next(account, two, 3n, [dev(DeviceRole.CLIENT, tablet, phone)], phone);
  const withdrawal = async (s: ed25519.Signer) =>
    sign("withdrawal", account, s, {
      $typeName: "pirc.v1alpha2.WithdrawalBody",
      withdrawn: create(VersionRefSchema, { number: 3n, hash: await hash(lost) }),
      winner: create(VersionRefSchema, { number: 3n, hash: await hash(won) }),
      signer: s.publicKey,
    });
  // The other key's first, or the honest one's: either way only the honest
  // one is kept, and the chain loads.
  for (const firstBy of [phone, tablet]) {
    const c = await Chain.start(first, account);
    await c.add([two], [await withdrawal(firstBy)]);
    await c.add([], [await withdrawal(firstBy === phone ? tablet : phone)]);
    await c.add([lost, won]);
    assert.ok(c.isWithdrawn(await hash(lost)));
    assert.equal(c.withdrawals().length, 1);
    assert.ok((await Chain.load(c.saved(), account)).isWithdrawn(await hash(lost)));
  }
  // The same key naming another winner first, one never shown: the honest
  // one is kept beside it, and counts.
  const bogus = await next(account, two, 3n, [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone)], tablet, [new Uint8Array(32).fill(9)]);
  const c = await Chain.start(first, account);
  await c.add([two], [await sign("withdrawal", account, tablet, {
    $typeName: "pirc.v1alpha2.WithdrawalBody",
    withdrawn: create(VersionRefSchema, { number: 3n, hash: await hash(lost) }),
    winner: create(VersionRefSchema, { number: 3n, hash: await hash(bogus) }),
    signer: tablet.publicKey,
  })]);
  await c.add([], [await withdrawal(tablet)]);
  await c.add([lost, won]);
  assert.ok(c.isWithdrawn(await hash(lost)), "the honest winner's withdrawal counts");
});

test("a device shown the code takes one answer: a right one after a wrong one is refused", async () => {
  const origin = "wss://relay.test";
  const host = await signer("joining host");
  const code = newCode();
  const d = await DeviceJoin.start(origin, code, { role: DeviceRole.HOST, signer: host, name: "x" });
  const wrong = await ClientJoin.answer(origin, { lookup: code.lookup, secret: code.secret === "00000" ? "00001" : "00000" }, d.offer);
  await assert.rejects(d.join.onAnswer(wrong.answer), JoinFailed);
  const right = await ClientJoin.answer(origin, code, d.offer);
  await assert.rejects(d.join.onAnswer(right.answer), JoinFailed);
});
