// The chain a device follows (chain.ts), and the two sides of a join
// (join.ts's DeviceJoin and ClientJoin) run against each other.

import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { DeviceRole, DeviceSchema, JoinApprovalSchema, type Device, type SignedObject } from "@pirc/protocol/v1alpha2";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, hex, utf8 } from "../bytes.ts";
import { Chain } from "../chain.ts";
import * as ed25519 from "../ed25519.ts";
import { sha256 } from "../hpke.ts";
import { ClientJoin, DeviceJoin, JoinFailed, newCode } from "../join.ts";
import { hash, sign } from "../objects.ts";

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

test("a chain follows versions, moves off a withdrawn one, and finds forks", async () => {
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
  assert.equal(ch.forks.length, 0);
  assert.deepEqual(ch.dropped.map((v) => hex(v.hash)), [hex(await hash(tablet4))]);
  assert.deepEqual(ch.taken.map((v) => hex(v.hash)), [hex(await hash(phone4))]);
  assert.ok(c.isWithdrawn(await hash(tablet4)));

  // Saved and loaded: the same branch.
  const five = await next(account, phone4, 5n, d2, tablet, [await hash(tablet4)]);
  await c.add([five]);
  const again = await Chain.load(c.saved(), account);
  assert.equal(hex(again.latest.hash), hex(await hash(five)));
  assert.equal(again.withdrawals().length, 1);
  await assert.rejects(Chain.load(c.saved(), new Uint8Array(32)));

  // A withdrawal of a version not yet seen is kept, then acts on it.
  const c2 = await Chain.start(first);
  await c2.add([two, three], [await withdrawal(account, tablet, tablet4, phone4, 4n)]);
  await c2.add([tablet4]);
  assert.equal(c2.latest.body.number, 3n, "a withdrawn version is not followed");
  await c2.add([phone4]);
  assert.equal(hex(c2.latest.hash), hex(await hash(phone4)));
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
