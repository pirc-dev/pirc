// What a hosted account's client does with versions it is shown, with no
// relay: a fork it adopted neither side of blocks it; a withdrawn version
// that added it is a failed join, which deletes nothing; a removal is
// recorded and said before anything is deleted, a mutual one said as
// such, and one stopped half-way finished at the next open; the caps of
// 256 hosts and 32 clients (docs/e2e.md, section 3).
import { create, fromJson } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { Frame as Frame1 } from "@pirc/protocol";
import { DeviceRole, DeviceSchema, FrameSchema, type Device, type SignedObject } from "@pirc/protocol/v1alpha2";
import type { OpenSocket } from "@pirc/relay-client/hosted";
import { compare, unhex, utf8 } from "@pirc/crypto/bytes";
import * as ed25519 from "@pirc/crypto/ed25519";
import { sha256, x25519FromPrivate } from "@pirc/crypto/hpke";
import { checkFirst, checkNext, MAX_CLIENTS, MAX_HOSTS, Refused } from "@pirc/crypto/list";
import { decode, encode, hash, sign } from "@pirc/crypto/objects";

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
  assert.ok(await snap.account, "nothing deleted before it was said");
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

test("a fork a withdrawal then explains lifts the block, as opening again does", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), me = await signer("me");
  const first = await v1(phone);
  const account = await hash(first);
  const d2 = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone), dev(DeviceRole.CLIENT, me, phone)];
  const two = await next(account, first, 2n, d2, phone);
  const threeA = await next(account, two, 3n, [...d2, dev(DeviceRole.HOST, await signer("h1"), phone)], phone);
  const threeB = await next(account, two, 3n, [...d2, dev(DeviceRole.HOST, await signer("h2"), tablet)], tablet);
  const c = await clientOn(me, [first, two]);
  await c.client.takeVersions([threeA, threeB], []);
  assert.ok(c.client.blocked);
  await c.client.takeVersions([], [await withdrawal(account, tablet, threeB, threeA, 3n)]);
  assert.equal(c.client.latest.body.number, 3n);
  assert.equal(c.client.blocked, undefined);
  const reopened = (await HostedClient.open({ origin: "wss://relay.example", open: nowhere, store: c.store, signer: me, name: "me" }))!;
  assert.equal(reopened.blocked, undefined);
});

test("a blocked client signs no label record, and asks nothing of a host", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), me = await signer("me");
  const first = await v1(phone);
  const account = await hash(first);
  const d2 = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone), dev(DeviceRole.CLIENT, me, phone)];
  const two = await next(account, first, 2n, d2, phone);
  const c = await clientOn(me, [first, two]);
  await c.client.takeVersions([await next(account, two, 3n, d2.slice(1), tablet), await next(account, two, 3n, [...d2, dev(DeviceRole.HOST, await signer("h"), phone)], phone)], []);
  assert.ok(c.client.blocked);
  await assert.rejects(c.client.rename(phone.publicKey, "x"), /took neither side/);
  await c.client.maintain();
  assert.deepEqual(c.client.myPreKeys(), [], "no pre-key made");
});

test("once removed, work queued behind the removal writes nothing back", async () => {
  const phone = await signer("phone"), me = await signer("me");
  const first = await v1(phone);
  const account = await hash(first);
  const two = await next(account, first, 2n, [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, me, phone)], phone);
  const iLeave = await next(account, two, 3n, [dev(DeviceRole.CLIENT, phone)], me);
  const c = await clientOn(me, [first, two]);
  await c.store.set("label-keys", [{ number: 1n, hash: account, key: new Uint8Array(32).fill(7) }]);
  const client = (await HostedClient.open({ origin: "wss://relay.example", open: nowhere, store: c.store, signer: me, name: "me" }))!;
  const queued = client as unknown as { serial<T>(fn: () => Promise<T>): Promise<T>; takeLabels(r: SignedObject[], w: SignedObject[]): Promise<void> };
  const a = queued.serial(() => client.takeVersions([iLeave], []));
  const b = queued.serial(() => queued.takeLabels([], [])).catch(() => {});
  await a;
  await b;
  assert.equal(await c.store.get("label-keys"), undefined);
  assert.equal(await c.store.get("account"), undefined);
});

test("a failed join stays one when the client is opened again", async () => {
  const phone = await signer("phone"), tablet = await signer("tablet"), me = await signer("me"), host = await signer("host");
  const first = await v1(phone);
  const account = await hash(first);
  const d2 = [dev(DeviceRole.CLIENT, phone), dev(DeviceRole.CLIENT, tablet, phone)];
  const two = await next(account, first, 2n, d2, phone);
  const mine = await next(account, two, 3n, [...d2, dev(DeviceRole.CLIENT, me, phone)], phone);
  const won = await next(account, two, 3n, [...d2, dev(DeviceRole.HOST, host, tablet)], tablet);
  const c = await clientOn(me, [first, two, mine]);
  await c.client.takeVersions([won], [await withdrawal(account, phone, mine, won, 3n)]);
  const again = (await HostedClient.open({ origin: "wss://relay.example", open: nowhere, store: c.store, signer: me, name: "me" }))!;
  assert.match(again.blocked ?? "", /join failed/);
});

test("a session frame behind a version is opened under the list that version makes", async () => {
  const objects = JSON.parse(readFileSync(new URL("../../cases/e2e/objects.json", import.meta.url), "utf8"));
  const phone = await ed25519.fromSeed(unhex(objects.devices.phone.seed));
  const [first, ...rest] = ["v1", "v2", "v3"].map((n) => decode(unhex(objects.objects[n].encoded)));
  const store = new MemoryStore();
  await store.set("chain", { branch: [first, ...rest].map(encode), others: [], withdrawals: [] });
  await store.set("pre-keys", [{ pair: await x25519FromPrivate(unhex(objects.devices.phone.pre_key_private)), obj: new Uint8Array(), madeAt: 0, expiresAt: 0 }]);
  await store.set("label-keys", []);
  await store.set("account", { origin: "wss://relay.example", accountId: unhex(objects.account_id) });
  const out: Frame1[] = [];
  const client = (await HostedClient.open({ origin: "wss://relay.example", open: nowhere, store, signer: phone, name: "phone", onFrame: (f) => out.push(f) }))!;
  client.sessions.onState({ kind: "ready", welcome: {} as never });
  // Version 4a removes the tablet the bundle wraps for; it is slow to
  // check, and the session list comes right behind it.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const take = client.takeVersions.bind(client);
  client.takeVersions = async (v, w) => {
    await gate;
    return take(v, w);
  };
  const inner = client as unknown as { onFrame(f: unknown): void; work: Promise<unknown> };
  inner.onFrame(create(FrameSchema, { body: { case: "versions", value: { requestId: "", versions: [decode(unhex(objects.objects.v4a.encoded))], withdrawals: [] } } }));
  const exchange = JSON.parse(readFileSync(new URL("../../cases/exchanges/hosted/off-the-list.json", import.meta.url), "utf8"));
  inner.onFrame(fromJson(FrameSchema, exchange.steps[0].in));
  release();
  await inner.work;
  await client.sessions.settled();
  assert.equal(client.latest.body.number, 4n);
  const lists = out.filter((f) => f.body.case === "sessionList");
  assert.ok(lists.length === 1 && lists[0].body.case === "sessionList" && lists[0].body.value.sessions.length === 0, "nothing read under a bundle for a device off the list");
});
