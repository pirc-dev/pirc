// A hosted account's client against the Go relay's hosted mode, for what
// stage 5's step 0 fixed in it (docs/design.md, step 14): a sign-up whose
// answer was lost, finished with the same version 1; the list compared at
// login by number and hash; a second client that joins by the code it
// shows, and leaves; the label key made new when a client goes and not
// when a host does; a host approved again after a join cut off; the
// pre-key renewed by the clock and sent again until taken; the account's
// subscriptions at login.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { after, test } from "node:test";

import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { AccountSubscriptionSchema, FrameSchema, ListVersionBodySchema, SubscriptionStore, type Attestation, type Frame } from "@pirc/protocol/v1alpha2";
import { wsSocket } from "@pirc/relay-client/hosted-ws";
import type { OpenSocket } from "@pirc/relay-client/hosted";
import { equal, random } from "@pirc/crypto/bytes";
import * as ed25519 from "@pirc/crypto/ed25519";
import * as hpke from "@pirc/crypto/hpke";
import { decode, encode, hash, sign } from "@pirc/crypto/objects";

import { join as hostJoin } from "../../extension/src/hosted/join.ts";
import { HostedClient, Lost, PRE_KEY_KEEP_MS, PRE_KEY_RENEW_MS, offerPurchase, type AccountEvent, type ClientOptions } from "../core/hosted/account.ts";
import { joinAccount } from "../core/hosted/join.ts";
import { MemoryStore, type Store } from "../core/hosted/store.ts";
import { Harness, startHostedRelay } from "../../test/harness.ts";

const h = new Harness();
const stops: (() => void)[] = [];
after(async () => {
  for (const s of stops) s();
  await h.close();
});
const relay = await startHostedRelay(h);
const attestation: Attestation = { $typeName: "pirc.v1alpha2.Attestation", kind: { case: "test", value: new Uint8Array([1]) }, subscription: "" };
const DAY = 24 * 3600_000;

async function until<T>(what: string, find: () => T | undefined | false | "" | Promise<T | undefined | false | "">, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await find();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Phone = { client: HostedClient; events: AccountEvent[]; store: Store; opts: ClientOptions };

function options(name: string, signer: ed25519.Signer, store: Store, extra: Partial<ClientOptions> = {}): ClientOptions & { events: AccountEvent[] } {
  const events: AccountEvent[] = [];
  return { origin: relay.origin, open: wsSocket, store, signer, name, onEvent: (e) => events.push(e), events, ...extra };
}

async function signUp(name: string, extra: Partial<ClientOptions> = {}): Promise<Phone> {
  const store = new MemoryStore();
  const o = options(name, await ed25519.generate(), store, extra);
  const client = await HostedClient.signUp(o, attestation);
  client.start();
  stops.push(() => client.stop());
  await until("the pre-key", () => client.myPreKeys().length > 0);
  await client.nameSelf();
  return { client, events: o.events, store, opts: o };
}

/** A second client, joined by the code it shows, typed into `by`. */
async function joinClient(by: HostedClient, name: string): Promise<Phone> {
  const store = new MemoryStore();
  const o = options(name, await ed25519.generate(), store);
  let shown = "";
  const j = joinAccount({ ...o, attestation, onCode: (s) => (shown = s) });
  stops.push(() => j.cancel());
  await until("the code", () => shown);
  const outcome = await by.join(shown, async () => true);
  assert.ok("joined" in outcome && !outcome.again);
  const { client } = await j.done;
  client.start();
  stops.push(() => client.stop());
  await until("its pre-key", () => client.myPreKeys().length > 0);
  return { client, events: o.events, store, opts: o };
}

/** A host joined by /pirc join's code; its anchor in a folder of its own. */
async function joinHost(by: HostedClient, signer: ed25519.Signer, anchorDir: string, again = false) {
  let shown = "";
  const j = hostJoin({ origin: relay.origin, signer, name: "build box", log: () => {}, anchorDir, onCode: (s) => (shown = s) });
  stops.push(() => j.cancel());
  j.done.catch(() => {});
  await until("the code", () => shown);
  const outcome = await by.join(shown, async (_, listed) => {
    assert.equal(listed, again);
    return true;
  });
  assert.ok("joined" in outcome && outcome.again === again);
  return j.done;
}

const currentLabelKey = (c: HostedClient) => (c as unknown as { currentLabelKey(): { number: bigint; key: Uint8Array } | undefined }).currentLabelKey();

test("a sign-up whose answer was lost is finished with the same version 1: one account", async () => {
  // The store fails once, where the account is kept after the relay
  // answered: as an app killed after SignUp was taken.
  const inner = new MemoryStore();
  let failOnce = true;
  const store: Store = {
    get: (k) => inner.get(k),
    set: async (k, v) => {
      if (k === "account" && failOnce) {
        failOnce = false;
        throw new Error("killed");
      }
      return inner.set(k, v);
    },
    delete: (k) => inner.delete(k),
    clear: () => inner.clear(),
  };
  const o = options("Pixel 9", await ed25519.generate(), store);
  await assert.rejects(HostedClient.signUp(o, attestation), /killed/);
  assert.ok(await HostedClient.signUpPending(store));
  const first = await hash(decode((await inner.get<{ v1: Uint8Array }>("sign-up"))!.v1));
  const client = await HostedClient.signUp(o, attestation);
  assert.deepEqual(client.accountId, first, "the account the first try made");
  assert.ok(!(await HostedClient.signUpPending(store)));
  // The relay answered SignedUp for the same version 1, so the account is
  // the one the first try made: its ID is version 1's hash either way.
  client.start();
  stops.push(() => client.stop());
  await until("logged in", () => client.conn.current.kind === "ready");
  assert.equal(client.latest.body.number, 1n);
  client.stop();
});

test("the relay's latest is compared by number and hash at login, and a mismatch fetched", async () => {
  const sent: Frame[] = [];
  // The Welcome rewritten to name another version of the same number.
  const open: OpenSocket = (url, on) => {
    const s = wsSocket(url, {
      ...on,
      message: (data) => {
        const f = fromBinary(FrameSchema, data);
        if (f.body.case === "welcome" && f.body.value.listVersion) {
          f.body.value.listVersion.hash = random(32);
          return on.message(toBinary(FrameSchema, f));
        }
        on.message(data);
      },
    });
    return {
      send: (d) => {
        sent.push(fromBinary(FrameSchema, d));
        s.send(d);
      },
      close: () => s.close(),
      get bufferedAmount() {
        return s.bufferedAmount;
      },
      ping: s.ping && (() => s.ping!()),
    };
  };
  const p = await signUp("Pixel 9");
  p.client.stop();
  const again = (await HostedClient.open({ ...p.opts, open }))!;
  again.start();
  stops.push(() => again.stop());
  const get = await until("a GetVersions from the version it has", () => sent.find((f) => f.body.case === "getVersions"));
  assert.ok(get.body.case === "getVersions");
  assert.equal(get.body.value.from, 1n);
  again.stop();
});

test("a second client joins by its code; a host's removal keeps the label key, a client's makes one; a client leaves", async () => {
  const phone = await signUp("Pixel 9");
  const tablet = await joinClient(phone.client, "iPad");
  assert.equal(phone.client.latest.body.number, 2n);
  await until("the tablet's name at the phone", () => phone.client.label(tablet.client.publicKey) === "iPad");
  await until("the label key at the tablet", () => currentLabelKey(tablet.client));
  assert.deepEqual(currentLabelKey(tablet.client)!.key, currentLabelKey(phone.client)!.key);

  // A host joins and is removed: no new label key, which it never had.
  const host = await ed25519.generate();
  await joinHost(phone.client, host, pathJoin(mkdtempSync(pathJoin(tmpdir(), "pirc-anchor-")), "hosted"));
  const before = currentLabelKey(phone.client)!;
  await phone.client.remove(host.publicKey);
  assert.equal(currentLabelKey(phone.client)!.number, before.number, "removing a host keeps the label key");

  // A third client is removed by the phone: the phone makes the new key,
  // named by its removal, and the tablet gets it wrapped.
  const laptop = await joinClient(phone.client, "laptop browser");
  const removal = await phone.client.remove(laptop.client.publicKey);
  assert.ok(removal);
  await until("the new label key at the phone", () => currentLabelKey(phone.client)!.number === removal.body.number);
  await until("the new label key at the tablet", () => currentLabelKey(tablet.client)?.number === removal.body.number);
  await until("the laptop's removal taken", () => laptop.events.find((e) => e.type === "removed-me"));
  assert.equal(await laptop.store.get("account"), undefined, "the removed client keeps nothing");

  // The tablet leaves: it deletes what it keeps, and the phone, which
  // stays, makes the new label key, which the tablet never sees.
  const left = await tablet.client.leave();
  assert.ok(left);
  const gone = tablet.events.find((e) => e.type === "removed-me");
  assert.ok(gone && gone.type === "removed-me" && equal(gone.by, tablet.client.publicKey) && !gone.mutual);
  assert.equal(await tablet.store.get("account"), undefined);
  await until("the phone's new label key after the leave", () => currentLabelKey(phone.client)!.number === left.body.number);

  // The last client cannot leave.
  await assert.rejects(phone.client.leave(), /last client/);
  phone.client.stop();
});

test("a host whose join was cut off after its version was taken is approved again, with no new version", async () => {
  const phone = await signUp("Pixel 9");
  const host = await ed25519.generate();
  const dir = mkdtempSync(pathJoin(tmpdir(), "pirc-anchor-"));
  await joinHost(phone.client, host, pathJoin(dir, "hosted"));
  const number = phone.client.latest.body.number;
  // The host lost its anchor, as one killed before it wrote it; it keeps
  // its key and shows a new code.
  rmSync(pathJoin(dir, "hosted"), { recursive: true, force: true });
  const joined = await joinHost(phone.client, host, pathJoin(dir, "hosted"), true);
  assert.equal(phone.client.latest.body.number, number, "no new version");
  assert.equal(joined.anchor.latest.body.number, number);
  phone.client.stop();
});

test("the pre-key is renewed by the clock, sent again until the relay takes it, and the old one kept two days", async () => {
  // The clock starts eight days back, so that the relay, on real time,
  // takes keys made on it.
  let now = Date.now() - 8 * DAY;
  const phone = await signUp("Pixel 9", { now: () => now });
  const first = phone.client.myPreKeys()[0].publicKey;
  now += PRE_KEY_RENEW_MS;
  // Disconnected: the new key is made, and kept, but not taken.
  phone.client.stop();
  await assert.rejects(phone.client.maintain(), /not connected/);
  const kept = phone.client.myPreKeys();
  assert.equal(kept.length, 2);
  const second = kept[0].publicKey;
  assert.ok(!equal(second, first));
  // Connected again: the same key is sent, and the old one stays.
  phone.client.start();
  await until("logged in", () => phone.client.conn.current.kind === "ready");
  await phone.client.maintain();
  assert.deepEqual(phone.client.myPreKeys().map((k) => k.publicKey), [second, first]);
  // Two days after the new one's publication, the old one goes.
  now += PRE_KEY_KEEP_MS;
  await phone.client.maintain();
  assert.deepEqual(phone.client.myPreKeys().map((k) => k.publicKey), [second]);
  phone.client.stop();
});

test("a client is told the account's subscriptions at login, and offered a purchase only when none carries it on", async () => {
  const phone = await signUp("Pixel 9");
  const subs = phone.client.subscriptions!;
  assert.equal(subs.length, 1);
  assert.equal(subs[0].store, SubscriptionStore.TEST);
  assert.ok(subs[0].renews && !subs[0].lapsed);
  assert.equal(offerPurchase(subs, Date.now()), false);
  phone.client.stop();

  const at = (ms: number) => ({ $typeName: "google.protobuf.Timestamp" as const, seconds: BigInt(Math.floor(ms / 1000)), nanos: 0 });
  const sub = (o: { ends: number; renews?: boolean; lapsed?: boolean }) =>
    create(AccountSubscriptionSchema, { store: SubscriptionStore.APP_STORE, ends: at(o.ends), renews: o.renews ?? false, lapsed: o.lapsed ?? false });
  const now = Date.now();
  assert.equal(offerPurchase(undefined, now), false, "not known yet");
  assert.equal(offerPurchase([], now), true, "none at all");
  assert.equal(offerPurchase([sub({ ends: now - DAY, lapsed: true })], now), true, "only lapsed ones");
  assert.equal(offerPurchase([sub({ ends: now + 30 * DAY, renews: true })], now), false, "one that renews");
  assert.equal(offerPurchase([sub({ ends: now + 30 * DAY })], now), false, "one that ends in a month");
  assert.equal(offerPurchase([sub({ ends: now + 3 * DAY })], now), true, "one that ends this week and will not renew");
  assert.equal(offerPurchase([sub({ ends: now + 3 * DAY }), sub({ ends: now + 40 * DAY })], now), false, "another carries it on");
});


// --- what the review of step 0 found ---

// A relay that hides from this device every version after `upTo`.
const hiding = (upTo: bigint): OpenSocket => (url, on) =>
  wsSocket(url, {
    ...on,
    message: (data) => {
      const f = fromBinary(FrameSchema, data);
      if (f.body.case === "versions") {
        f.body.value.versions = f.body.value.versions.filter((v) => fromBinary(ListVersionBodySchema, v.body).number <= upTo);
        return on.message(toBinary(FrameSchema, f));
      }
      on.message(data);
    },
  });

test("a client leaves while two stay: both end with the one label key the relay took first, and read each other's names", async () => {
  const phone = await signUp("Pixel 9");
  const tablet = await joinClient(phone.client, "iPad");
  const laptop = await joinClient(phone.client, "laptop");
  await until("the names at the tablet", () => tablet.client.label(laptop.client.publicKey) === "laptop");
  const left = await laptop.client.leave();
  assert.ok(left);
  await until("the same new label key at both", () => {
    const a = currentLabelKey(phone.client), b = currentLabelKey(tablet.client);
    return a?.number === left.body.number && b?.number === left.body.number && equal(a.key, b.key);
  });
  await phone.client.rename(tablet.client.publicKey, "renamed by phone");
  await until("the phone's rename at the tablet", () => tablet.client.label(tablet.client.publicKey) === "renamed by phone");
  await tablet.client.rename(phone.client.publicKey, "renamed by tablet");
  await until("the tablet's rename at the phone", () => phone.client.label(phone.client.publicKey) === "renamed by tablet");
  phone.client.stop();
  tablet.client.stop();
});

test("two clients removing each other at once: the one removed is told it was mutual", async () => {
  for (let i = 0; i < 3; i++) {
    const phone = await signUp("Pixel 9");
    const tablet = await joinClient(phone.client, "iPad");
    await Promise.allSettled([phone.client.remove(tablet.client.publicKey), tablet.client.remove(phone.client.publicKey)]);
    const told = await until("a removal", () => [...phone.events, ...tablet.events].find((e) => e.type === "removed-me"));
    assert.ok(told.type === "removed-me" && told.mutual, `run ${i}`);
    phone.client.stop();
    tablet.client.stop();
  }
});

test("a pre-key never taken and near its end is dropped for a new one", async () => {
  const phone = await signUp("Pixel 9");
  phone.client.stop();
  // A key made 20 days ago whose publication never succeeded, behind a
  // published one older still.
  const made = Date.now() - 20 * DAY;
  const pair = await hpke.x25519Generate();
  const obj = await sign("pre-key", phone.client.accountId, phone.opts.signer, { $typeName: "pirc.v1alpha2.PreKeyBody", signer: phone.opts.signer.publicKey, preKey: pair.publicKey, madeAt: timestampFromMs(made), expiresAt: timestampFromMs(made + 14 * DAY) });
  const kept = (await phone.store.get<{ madeAt: number; publishedAt?: number }[]>("pre-keys"))!;
  kept[0].madeAt = kept[0].publishedAt = Date.now() - 27 * DAY;
  await phone.store.set("pre-keys", [...kept, { pair, obj: encode(obj), madeAt: made, expiresAt: made + 14 * DAY, pending: true }]);
  const again = (await HostedClient.open(phone.opts))!;
  again.start();
  stops.push(() => again.stop());
  await until("logged in", () => again.conn.current.kind === "ready");
  await again.maintain();
  const newest = again.myPreKeys()[0];
  assert.ok(!equal(newest.publicKey, pair.publicKey), "the dead key was dropped");
  again.stop();
});

test("a version whose answer is lost with the connection is kept, sent again, and no other of its number signed", async () => {
  const sent: Uint8Array[] = [];
  let drop = true;
  // The connection lost just as the version goes.
  const open: OpenSocket = (url, on) => {
    const s = wsSocket(url, on);
    return {
      send: (d) => {
        const f = fromBinary(FrameSchema, d);
        if (f.body.case === "publishVersion") {
          sent.push(f.body.value.version!.body);
          if (drop) {
            drop = false;
            on.close(1006, "dropped");
            s.close();
            return;
          }
        }
        s.send(d);
      },
      close: () => s.close(),
      get bufferedAmount() {
        return s.bufferedAmount;
      },
      ping: s.ping && (() => s.ping!()),
    };
  };
  const phone = await signUp("Pixel 9", { open });
  const ro = await ed25519.generate();
  await assert.rejects(phone.client.addReadOnly(ro.publicKey), (e) => e instanceof Lost);
  assert.ok(await phone.store.get("pending-version"), "kept while its fate is unknown");
  await until("the kept version taken at the next login", () => phone.client.latest.body.number === 2n);
  assert.equal(await phone.store.get("pending-version"), undefined);
  assert.equal(new Set(sent.map((b) => Buffer.from(b).toString("hex"))).size, 1, "one version 2, sent twice");
  phone.client.stop();
});

test("a device approved again is not handed a list from before a later removal", async () => {
  const phone = await signUp("Pixel 9");
  const tablet = await joinClient(phone.client, "iPad");
  const laptop = await joinClient(phone.client, "laptop");
  await phone.client.remove(laptop.client.publicKey);
  tablet.client.stop();
  // The tablet lost its account and shows a new code with its key, through
  // a relay that hides the laptop's removal.
  const o = options("iPad", tablet.opts.signer, new MemoryStore(), { open: hiding(3n) });
  let shown = "";
  const j = joinAccount({ ...o, attestation, onCode: (s) => (shown = s) });
  j.done.catch(() => {});
  await until("the code", () => shown);
  const outcome = await phone.client.join(shown, async () => true);
  assert.ok("joined" in outcome && outcome.again);
  await assert.rejects(j.done, /approving client's latest version/);
  phone.client.stop();
});
