// What a hosted account's client does with versions it is shown, with no
// relay: a fork it adopted neither side of blocks it; a withdrawn version
// that added it is a failed join, which deletes nothing; a removal is
// recorded and said before anything is deleted, a mutual one said as
// such, and one stopped half-way finished at the next open; the caps of
// 256 hosts and 32 clients (docs/e2e.md, section 3).
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import assert from "node:assert/strict";
import { test } from "node:test";

import { DeviceRole, DeviceSchema, type Device, type SignedObject } from "@pirc/protocol/v1alpha2";
import type { OpenSocket } from "@pirc/relay-client/hosted";
import { compare, utf8 } from "@pirc/crypto/bytes";
import * as ed25519 from "@pirc/crypto/ed25519";
import { sha256 } from "@pirc/crypto/hpke";
import { checkFirst, checkNext, MAX_CLIENTS, MAX_HOSTS, Refused } from "@pirc/crypto/list";
import { encode, hash, sign } from "@pirc/crypto/objects";

import { HostedClient, type AccountEvent } from "../core/hosted/account.ts";
import { MemoryStore } from "../core/hosted/store.ts";

const signer = async (name: string) => ed25519.fromSeed(await sha256(utf8(`hosted list test ${name}`)));
const at = timestampFromMs(Date.UTC(2026, 10, 19));
const dev = (role: DeviceRole, s: { publicKey: Uint8Array }, by?: ed25519.Signer, owner?: ed25519.Signer): Device =>
  create(DeviceSchema, { role, publicKey: s.publicKey, addedBy: by?.publicKey ?? new Uint8Array(0), addedAt: at, owner: owner?.publicKey ?? new Uint8Array(0) });
const sorted = (ds: Device[]) => [...ds].sort((a, b) => compare(a.publicKey, b.publicKey));

const v1 = (phone: ed25519.Signer) =>
  sign("list", new Uint8Array(0), phone, { $typeName: "pirc.v1alpha2.ListVersionBody", number: 1n, previous: new Uint8Array(0), devices: [dev(DeviceRole.CLIENT, phone)], withdrawn: [], signer: phone.publicKey });
const next = async (account: Uint8Array, prev: SignedObject, number: bigint, devices: Device[], s: ed25519.Signer, withdrawn: Uint8Array[] = []) =>
  sign("list", account, s, { $typeName: "pirc.v1alpha2.ListVersionBody", number, previous: await hash(prev), devices: sorted(devices), withdrawn, signer: s.publicKey });
const withdrawal = async (account: Uint8Array, s: ed25519.Signer, mine: SignedObject, winner: SignedObject, number: bigint) =>
  sign("withdrawal", account, s, {
    $typeName: "pirc.v1alpha2.WithdrawalBody",
    withdrawn: { $typeName: "pirc.v1alpha2.VersionRef", number, hash: await hash(mine) },
    winner: { $typeName: "pirc.v1alpha2.VersionRef", number, hash: await hash(winner) },
    signer: s.publicKey,
  });

// Never connects: these clients are only shown versions.
const nowhere: OpenSocket = () => ({ send() {}, close() {}, bufferedAmount: 0 });

/** A client of `me`'s, with `branch` as its chain, opened from a store. */
async function clientOn(me: ed25519.Signer, branch: SignedObject[]) {
  const store = new MemoryStore();
  const account = await hash(branch[0]);
  await store.set("chain", { branch: branch.map(encode), others: [], withdrawals: [] });
  await store.set("label-keys", []);
  await store.set("account", { origin: "wss://relay.example", accountId: account });
  const events: AccountEvent[] = [];
  const client = (await HostedClient.open({ origin: "wss://relay.example", open: nowhere, store, signer: me, name: "me", onEvent: (e) => events.push(e) }))!;
  return { client, store, events, account };
}

test("a fork at a version this client adopted neither side of blocks it; one it adopted a side of does not", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), me = await signer("me"), host = await signer("host");
  const first = await v1(phone);
  const account = await hash(first);
  const d2 = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone), dev(DeviceRole.CLIENT, me, phone)];
  const two = await next(account, first, 2n, d2, phone);
  const threeA = await next(account, two, 3n, [...d2, dev(DeviceRole.HOST, host, phone)], phone);
  const threeB = await next(account, two, 3n, d2.filter((d) => d.publicKey !== phone.publicKey), tablet);

  // Both at once, as to a client that was away.
  const away = await clientOn(me, [first, two]);
  await away.client.takeVersions([threeA, threeB], []);
  assert.ok(away.events.some((e) => e.type === "undecided" && e.number === 3n));
  assert.match(away.client.blocked ?? "", /took neither side/);
  await assert.rejects(away.client.remove(host.publicKey), /took neither side/);
  // It stays so when opened again.
  const reopened = (await HostedClient.open({ origin: "wss://relay.example", open: nowhere, store: away.store, signer: me, name: "me" }))!;
  assert.ok(reopened.blocked);

  // One then the other: it keeps the side it took, and says there is a fork.
  const took = await clientOn(me, [first, two]);
  await took.client.takeVersions([threeA], []);
  await took.client.takeVersions([threeB], []);
  assert.equal(took.client.blocked, undefined);
  assert.equal(took.client.latest.body.number, 3n);
  assert.ok(took.events.some((e) => e.type === "fork"));
});

test("a version that added this client, withdrawn, is a failed join: nothing is deleted", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), me = await signer("me"), host = await signer("host");
  const first = await v1(phone);
  const account = await hash(first);
  const d2 = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone)];
  const two = await next(account, first, 2n, d2, phone);
  // The phone's 3 adds this client; the tablet's 3, adding a host, won.
  const mine = await next(account, two, 3n, [...d2, dev(DeviceRole.CLIENT, me, phone)], phone);
  const won = await next(account, two, 3n, [...d2, dev(DeviceRole.HOST, host, tablet)], tablet);
  const c = await clientOn(me, [first, two, mine]);
  await c.client.takeVersions([won], [await withdrawal(account, phone, mine, won, 3n)]);
  assert.ok(c.events.some((e) => e.type === "join-failed"));
  assert.ok(!c.events.some((e) => e.type === "removed-me"));
  assert.ok(await c.store.get("account"), "nothing deleted");
});

test("a removal is recorded and said before anything is deleted; a mutual one says so; one cut off is finished at the next open", async () => {
  const phone = await signer("phone"), me = await signer("me");
  const first = await v1(phone);
  const account = await hash(first);
  const both = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, me, phone)];
  const two = await next(account, first, 2n, both, phone);
  const removesMe = await next(account, two, 3n, [dev(DeviceRole.CLIENT, phone)], phone);

  // Plain: the phone removes this client.
  const plain = await clientOn(me, [first, two]);
  let atEvent: unknown;
  const seen: AccountEvent[] = [];
  const watched = (await HostedClient.open({
    origin: "wss://relay.example",
    open: nowhere,
    store: plain.store,
    signer: me,
    name: "me",
    onEvent: (e) => {
      seen.push(e);
      // What the store held when the person was told: still everything.
      if (e.type === "removed-me") atEvent = { ...e, removed: plain.store.get("removed"), account: plain.store.get("account") };
    },
  }))!;
  await watched.takeVersions([removesMe], []);
  const told = seen.find((e) => e.type === "removed-me");
  assert.ok(told && told.type === "removed-me" && !told.mutual);
  const snap = atEvent as { removed: Promise<unknown>; account: Promise<unknown> };
  assert.ok(await snap.removed, "recorded before it was said");
  assert.equal(await plain.store.get("account"), undefined, "then deleted");

  // Mutual: this client was removing the phone, which removed it first.
  const mutual = await clientOn(me, [first, two]);
  const removingPhone = await next(account, two, 3n, [dev(DeviceRole.CLIENT, me, phone)], me);
  await mutual.store.set("pending-version", encode(removingPhone));
  await mutual.client.takeVersions([removesMe], []);
  const m = mutual.events.find((e) => e.type === "removed-me");
  assert.ok(m && m.type === "removed-me" && m.mutual);

  // Cut off half-way: the record is there, the account too; open finishes.
  const half = await clientOn(me, [first, two]);
  await half.store.set("removed", { by: phone.publicKey, number: 3n, mutual: false });
  assert.deepEqual((await HostedClient.removal(half.store))?.number, 3n);
  assert.equal(await HostedClient.open({ origin: "wss://relay.example", open: nowhere, store: half.store, signer: me, name: "me" }), undefined);
  assert.equal(await half.store.get("account"), undefined);
  assert.equal(await HostedClient.removal(half.store), undefined);
});

test("an account holds at most 256 hosts and 32 clients, each client with its read-only key", async () => {
  const phone = await signer("phone");
  const first = await v1(phone);
  const account = await hash(first);
  const many = async (n: number, what: string) => Promise.all(Array.from({ length: n }, (_, i) => signer(`${what} ${i}`)));
  const clients = await many(MAX_CLIENTS - 1, "client");
  const hosts = await many(MAX_HOSTS, "host");
  const prev = await checkFirst(first);
  const full = [dev(DeviceRole.CLIENT, phone), ...clients.map((c) => dev(DeviceRole.CLIENT, c, phone)), dev(DeviceRole.READ_ONLY, await signer("ro"), phone, phone), ...hosts.map((x) => dev(DeviceRole.HOST, x, phone))];
  const two = await next(account, first, 2n, full, phone);
  const v2 = await checkNext(account, prev, two);
  assert.equal(v2.body.devices.length, MAX_HOSTS + MAX_CLIENTS + 1);
  const oneHostMore = await next(account, two, 3n, [...full, dev(DeviceRole.HOST, await signer("host x"), phone)], phone);
  await assert.rejects(checkNext(account, v2, oneHostMore), (e) => e instanceof Refused && /256 hosts/.test(e.message));
  const oneClientMore = await next(account, two, 3n, [...full, dev(DeviceRole.CLIENT, await signer("client x"), phone)], phone);
  await assert.rejects(checkNext(account, v2, oneClientMore), (e) => e instanceof Refused && /32 clients/.test(e.message));

  // A client on the full account has no room for either, and says so
  // before a code is typed.
  const c = await clientOn(phone, [first, two]);
  assert.equal(c.client.room(DeviceRole.HOST), false);
  assert.equal(c.client.room(DeviceRole.CLIENT), false);
  const roomy = await clientOn(phone, [first]);
  assert.equal(roomy.client.room(DeviceRole.CLIENT), true);
});
