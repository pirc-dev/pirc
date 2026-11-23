// The hosted connection (hosted.ts) against the Go relay's hosted mode:
// signing up with version 1 of the list, logging in to the account,
// publishing newer versions, a removed device told before its close, a
// refused key retried rather than given up, a computer's sealed copy
// opened by its client, Noise IK through a channel, and Noise XXpsk3 through a join.
import { create } from "@bufbuild/protobuf";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { load as loadE2e } from "@pirc/e2e";
import { framed } from "@pirc/e2e/framed";
import { load as loadNoise, type Transport } from "@pirc/e2e/noise";
import { boxSecrets, device, makeList, seed, sha256, signingPair } from "../../e2e/test/make.ts";
import { ErrorCode } from "@pirc/protocol";
import { DeviceRole, FrameSchema, type Frame } from "@pirc/protocol/v1alpha2";

import { Harness, startHostedRelay } from "../../test/harness.ts";
import { HostedConnection, hostedOrigin, type HostedState, type Signer } from "../hosted.ts";
import { wsSocket } from "../hosted-ws.ts";

const h = new Harness();
after(() => h.close());
const relay = await startHostedRelay(h);

async function generate(): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  return {
    publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, m as Uint8Array<ArrayBuffer>)),
  };
}

function connect(signer: Signer, accountId: Uint8Array, opts: { refusedRetryMs?: number; listCounter?: () => bigint; instanceId?: string } = {}) {
  const frames: Frame[] = [];
  const states: HostedState[] = [];
  // Frames and states in the order they came.
  const events: (Frame | HostedState)[] = [];
  const waiters: (() => void)[] = [];
  const conn = new HostedConnection({
    origin: relay.origin,
    accountId,
    signer,
    open: wsSocket,
    onFrame: (f) => {
      frames.push(f);
      events.push(f);
      waiters.splice(0).forEach((w) => w());
    },
    onState: (s) => {
      states.push(s);
      events.push(s);
      waiters.splice(0).forEach((w) => w());
    },
    minBackoffMs: 50,
    ...opts,
  });
  const until = async <T>(what: string, find: () => T | undefined): Promise<T> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const got = find();
      if (got !== undefined) return got;
      if (Date.now() > deadline) throw new Error(`waiting for ${what}: ${JSON.stringify(states.map((s) => s.kind))}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  conn.start();
  return { conn, frames, states, events, until };
}

test("framed: the context, a NUL, each part after its LEB128 length", () => {
  // The same vector as relay/internal/hosted's TestFramed and the app's test/framed_test.dart.
  assert.deepEqual(framed("ab", new Uint8Array(0), new Uint8Array(200).fill(7)), Uint8Array.from([0x61, 0x62, 0, 0, 0xc8, 0x01, ...new Uint8Array(200).fill(7)]));
});

test("an origin is a scheme and a host", () => {
  assert.equal(hostedOrigin("wss://relay.example"), "wss://relay.example");
  assert.equal(hostedOrigin("ws://127.0.0.1:8443/"), "ws://127.0.0.1:8443");
  for (const bad of ["https://relay.example", "wss://relay.example/v1alpha2", "wss://u@relay.example", "relay.example"]) {
    assert.throws(() => hostedOrigin(bad), bad);
  }
});

const EMPTY = new Uint8Array(0);
const CLIENT = 2;
const COMPUTER = 1;

// A device the test-only list maker knows, as a Signer.
function signerOf(name: string): Signer {
  const p = signingPair(name);
  return { publicKey: p.publicKey, sign: async (m) => p.sign(m) };
}

test("a phone signs up with version 1, logs in to its account, and a stranger is refused and tries again", async () => {
  const P = device("hosted phone", CLIENT, true);
  const phone = signerOf("hosted phone");
  const v1 = makeList({
    seed: seed("hosted phone signing"),
    accountId: EMPTY,
    counter: 1n,
    previousBody: null,
    devices: [P],
  });
  const account = sha256(v1.subarray(64));
  const a = connect(phone, new Uint8Array(0), { listCounter: () => 1n });
  await a.until("ready", () => (a.conn.current.kind === "ready" ? true : undefined));
  assert.ok(
    a.conn.send(
      create(FrameSchema, {
        body: {
          case: "signUp",
          value: {
            requestId: "s",
            attestation: { kind: { case: "test", value: new Uint8Array([1]) } },
            list: v1,
          },
        },
      }),
    ),
  );
  const signedUp = await a.until("SignedUp", () => a.frames.find((f) => f.body.case === "signedUp"));
  assert.deepEqual(signedUp.body.value && "accountId" in signedUp.body.value && signedUp.body.value.accountId, account);

  a.conn.switchAccount(account);
  await a.until("Welcome", () => {
    const s = a.conn.current;
    return s.kind === "ready" && s.welcome.role === DeviceRole.CLIENT ? s.welcome : undefined;
  });
  // The phone holds version 1, the relay's newest: Welcome carries no list.
  const w = a.conn.current.kind === "ready" ? a.conn.current.welcome : undefined;
  assert.equal(w?.listCounter, 1n);
  assert.equal(w?.list.length, 0);
  a.conn.stop();

  const stranger = connect(await generate(), account, { refusedRetryMs: 100 });
  await stranger.until("two refusals", () => (stranger.states.filter((s) => s.kind === "refused").length >= 2 ? true : undefined));
  const r = stranger.states.find((s) => s.kind === "refused");
  assert.ok(r?.kind === "refused" && r.code === ErrorCode.UNAUTHENTICATED);
  stranger.conn.stop();
});

test("the phone publishes version 2 with a computer, then version 3 without it, and the computer reads List before its close", async () => {
  const name = "hosted phone 2";
  const P = device(name, CLIENT, true);
  const C = device("hosted computer", COMPUTER, false);
  const key = seed(`${name} signing`);
  const v1 = makeList({
    seed: key,
    accountId: EMPTY,
    counter: 1n,
    previousBody: null,
    devices: [P],
  });
  const account = sha256(v1.subarray(64));
  const a = connect(signerOf(name), new Uint8Array(0));
  await a.until("ready", () => (a.conn.current.kind === "ready" ? true : undefined));
  a.conn.send(
    create(FrameSchema, {
      body: {
        case: "signUp",
        value: {
          requestId: "s",
          attestation: { kind: { case: "test", value: new Uint8Array([1]) } },
          list: v1,
        },
      },
    }),
  );
  await a.until("SignedUp", () => a.frames.find((f) => f.body.case === "signedUp"));
  a.conn.switchAccount(account);
  await a.until("Welcome", () => (a.conn.current.kind === "ready" && a.conn.current.welcome.role === DeviceRole.CLIENT ? true : undefined));
  const done = (id: string) => a.until(`Done ${id}`, () => a.frames.find((f) => (f.body.case === "done" || f.body.case === "error") && f.body.value.requestId === id));

  const v2 = makeList({
    seed: key,
    accountId: account,
    counter: 2n,
    previousBody: v1.subarray(64),
    devices: [P, C],
  });
  a.conn.send(
    create(FrameSchema, {
      body: { case: "publishList", value: { requestId: "p2", list: v2 } },
    }),
  );
  assert.equal((await done("p2")).body.case, "done");

  // The computer logs in holding nothing: Welcome carries version 2.
  const c = connect(signerOf("hosted computer"), account, {
    refusedRetryMs: 60_000,
    instanceId: "i1",
  });
  const welcome = await c.until("Welcome", () => (c.conn.current.kind === "ready" ? c.conn.current.welcome : undefined));
  assert.equal(welcome.role, DeviceRole.HOST);
  assert.equal(welcome.listCounter, 2n);
  assert.deepEqual(welcome.list, v2);

  const v3 = makeList({
    seed: key,
    accountId: account,
    counter: 3n,
    previousBody: v2.subarray(64),
    devices: [P],
  });
  a.conn.send(
    create(FrameSchema, {
      body: { case: "publishList", value: { requestId: "p3", list: v3 } },
    }),
  );
  assert.equal((await done("p3")).body.case, "done");
  await c.until("a close after List", () => (c.states.some((s) => s.kind === "offline") ? true : undefined));
  const list = c.events.findIndex((e) => "body" in e && e.body.case === "list");
  const closed = c.events.findIndex((e) => "kind" in e && e.kind === "offline");
  assert.ok(list >= 0 && list < closed, "List before the close");
  const l = c.events[list];
  assert.ok("body" in l && l.body.case === "list");
  assert.deepEqual(l.body.value.list, v3);
  const off = c.events[closed];
  assert.ok("kind" in off && off.kind === "offline" && off.reason.includes("1008"), JSON.stringify(off));

  // Logging in again, it is given version 3, then refused as removed.
  await c.until("refused", () => (c.states.some((s) => s.kind === "refused") ? true : undefined));
  const r = c.states.find((s) => s.kind === "refused");
  assert.ok(r?.kind === "refused" && r.code === ErrorCode.UNAUTHENTICATED && r.reason === "removed", JSON.stringify(r));
  assert.equal(c.frames.filter((f) => f.body.case === "list").length, 2);
  c.conn.stop();
  a.conn.stop();
});

// An account of a phone and a computer, both connected, the computer as
// pi process "i1".
async function phoneAndComputer(name: string) {
  const P = device(`${name} phone`, CLIENT, true);
  const C = device(`${name} computer`, COMPUTER, false);
  const key = seed(`${name} phone signing`);
  const v1 = makeList({ seed: key, accountId: EMPTY, counter: 1n, previousBody: null, devices: [P] });
  const accountId = sha256(v1.subarray(64));
  const phone = connect(signerOf(`${name} phone`), EMPTY);
  await phone.until("ready", () => (phone.conn.current.kind === "ready" ? true : undefined));
  phone.conn.send(create(FrameSchema, { body: { case: "signUp", value: { requestId: "s", attestation: { kind: { case: "test", value: new Uint8Array([1]) } }, list: v1 } } }));
  await phone.until("SignedUp", () => phone.frames.find((f) => f.body.case === "signedUp"));
  phone.conn.switchAccount(accountId);
  await phone.until("Welcome", () => (phone.conn.current.kind === "ready" && phone.conn.current.welcome.role === DeviceRole.CLIENT ? true : undefined));
  const v2 = makeList({ seed: key, accountId, counter: 2n, previousBody: v1.subarray(64), devices: [P, C] });
  phone.conn.send(create(FrameSchema, { body: { case: "publishList", value: { requestId: "p2", list: v2 } } }));
  await phone.until("Done", () => phone.frames.find((f) => f.body.case === "done" && f.body.value.requestId === "p2"));
  const computer = connect(signerOf(`${name} computer`), accountId, { instanceId: "i1" });
  await computer.until("Welcome", () => (computer.conn.current.kind === "ready" ? true : undefined));
  return { P, C, accountId, phone, computer, list: { counter: 2n, devices: [P, C] }, secrets: { phone: boxSecrets(`${name} phone`), computer: boxSecrets(`${name} computer`) } };
}

// The next frame of a connection a predicate takes, each taken once.
function taker(c: ReturnType<typeof connect>) {
  const taken = new Set<Frame>();
  return async <T>(what: string, pick: (f: Frame) => T | undefined): Promise<T> =>
    c.until(what, () => {
      for (const f of c.frames) {
        if (taken.has(f)) continue;
        const v = pick(f);
        if (v !== undefined) {
          taken.add(f);
          return v;
        }
      }
      return undefined;
    });
}

test("a computer's announcement, sealed with e2e/sealed.ts, reaches its client through the relay and opens there", async () => {
  const e2e = await loadE2e();
  const a = await phoneAndComputer("sealed");
  const fromPhone = taker(a.phone);
  a.phone.conn.send(create(FrameSchema, { body: { case: "subscribeSessions", value: {} } }));
  await fromPhone("SessionList", (f) => (f.body.case === "sessionList" ? f.body.value : undefined));

  const sessionId = "0194f3e2-7c1a-7000-8000-000000000001";
  const slot = { accountId: a.accountId, computerKey: a.C.signingKey, sessionId: new TextEncoder().encode(sessionId) };
  const ordering = BigInt(Date.now());
  const body = { sessionName: "the session", folder: "/work", model: "a model", computerName: "build box", notice: "a question?" };
  const sealed = e2e.seal({ list: a.list, boxSecretKey: a.secrets.computer.box, slot: { ...slot, kind: "announcement" }, ordering, body });
  assert.equal(sealed.copies.length, 1);
  a.computer.conn.send(
    create(FrameSchema, {
      body: {
        case: "sessionAnnounce",
        value: { session: { hostKey: a.C.signingKey, sessionId, instanceId: "i1" }, announcements: sealed.copies.map((c) => ({ recipientKey: c.recipientKey, sealed: c.sealed })) },
      },
    }),
  );
  const entry = await fromPhone("SessionUpdated", (f) => (f.body.case === "sessionUpdated" ? f.body.value.entry : undefined));
  assert.ok(entry);
  assert.deepEqual(entry.sealed, sealed.copies[0]!.sealed);
  const opened = e2e.openAnnouncement({ sealed: entry.sealed, slot, recipientSecretKey: a.secrets.phone.box, list: a.list, highest: null, now: BigInt(Date.now()) });
  assert.deepEqual(opened, { result: "accepted", ordering, body });
  a.phone.conn.stop();
  a.computer.conn.stop();
});

test("Noise IK through a channel: the handshake, then transport messages of 0 and 65,519 bytes both ways", async () => {
  const noise = await loadNoise();
  const a = await phoneAndComputer("channel");
  const fromPhone = taker(a.phone);
  const fromComputer = taker(a.computer);
  const initiator = noise.ikInitiator({ staticKey: noise.staticKey(a.secrets.phone.channel), responderKey: a.C.channelKey, accountId: a.accountId });
  const m1 = await initiator.writeMessage();
  assert.ok(m1.ok);
  assert.equal(m1.message.length, 96);
  a.phone.conn.send(create(FrameSchema, { body: { case: "openChannel", value: { requestId: "o", hostKey: a.C.signingKey, instanceId: "i1", message: m1.message } } }));
  const id = await fromPhone("ChannelOpened", (f) => (f.body.case === "channelOpened" ? f.body.value.channelId : undefined));
  const open = await fromComputer("OpenChannel", (f) => (f.body.case === "openChannel" ? f.body.value : undefined));
  assert.equal(open.channelId, id);

  const responder = noise.ikResponder({ staticKey: noise.staticKey(a.secrets.computer.channel), accountId: a.accountId });
  assert.ok((await responder.readMessage(open.message)).ok);
  const m2 = await responder.writeMessage();
  assert.ok(m2.ok && m2.transport);
  const computerSide: Transport = m2.transport;
  const msg = (message: Uint8Array) => create(FrameSchema, { body: { case: "channelMessage", value: { channelId: id, message } } });
  a.computer.conn.send(msg(m2.message));
  const got2 = await fromPhone("message 2", (f) => (f.body.case === "channelMessage" ? f.body.value.message : undefined));
  const r2 = await initiator.readMessage(got2);
  assert.ok(r2.ok && r2.transport);
  const phoneSide: Transport = r2.transport;
  assert.deepEqual(phoneSide.remoteStatic, a.C.channelKey);

  for (const n of [0, 65_519]) {
    const plain = new Uint8Array(n).map((_, i) => i & 0xff);
    for (const [from, to, sender, receiver] of [
      [a.phone, fromComputer, phoneSide, computerSide],
      [a.computer, fromPhone, computerSide, phoneSide],
    ] as const) {
      const sent = sender.send(plain);
      assert.ok(sent.ok);
      assert.equal(sent.message.length, n + 16);
      assert.ok(from.conn.send(msg(sent.message)));
      const got = await to(`${n} bytes`, (f) => (f.body.case === "channelMessage" ? f.body.value.message : undefined));
      const r = receiver.receive(got);
      assert.ok(r.ok);
      assert.deepEqual(r.plaintext, plain);
    }
  }
  assert.equal(computerSide.confirmed, true);
  a.phone.conn.stop();
  a.computer.conn.stop();
});

test("Noise XXpsk3 through a join: the account's phone looks up the new device's 8-character code, and the three messages and a transport message pass", async () => {
  const noise = await loadNoise();
  const a = await phoneAndComputer("join");
  const fromPhone = taker(a.phone);
  const joiner = connect(await generate(), EMPTY);
  const fromJoiner = taker(joiner);
  await joiner.until("ready", () => (joiner.conn.current.kind === "ready" ? true : undefined));
  const lookup = "K7QMK7QM";
  joiner.conn.send(create(FrameSchema, { body: { case: "joinWait", value: { lookup } } }));
  // The relay holds the wait before it takes the lookup: a short lookup is refused.
  a.phone.conn.send(create(FrameSchema, { body: { case: "joinLookup", value: { requestId: "short", lookup: "K7QM" } } }));
  const refused = await fromPhone("an error", (f) => (f.body.case === "error" ? f.body.value : undefined));
  assert.equal(refused.requestId, "short");
  assert.equal(refused.code, ErrorCode.SESSION_NOT_FOUND);
  await new Promise((r) => setTimeout(r, 100));
  a.phone.conn.send(create(FrameSchema, { body: { case: "joinLookup", value: { requestId: "l", lookup } } }));
  const paired = await fromPhone("JoinPaired", (f) => (f.body.case === "joinPaired" ? f.body.value : undefined));
  const joinId = paired.joinId;
  assert.equal((await fromJoiner("JoinPaired", (f) => (f.body.case === "joinPaired" ? f.body.value : undefined))).joinId, joinId);

  const psk = new Uint8Array(32).fill(7);
  const prologue = new TextEncoder().encode("join test");
  const initiator = noise.xxpsk3Initiator({ staticKey: noise.staticKey(new Uint8Array(32).fill(1)), prologue, psk });
  const responder = noise.xxpsk3Responder({ staticKey: noise.staticKey(new Uint8Array(32).fill(2)), prologue, psk });
  const step = (c: typeof a.phone, message: Uint8Array) => assert.ok(c.conn.send(create(FrameSchema, { body: { case: "joinMessage", value: { joinId, step: message } } })));
  const stepOf = (f: Frame) => (f.body.case === "joinMessage" ? f.body.value.step : undefined);

  const m1 = await initiator.writeMessage();
  assert.ok(m1.ok);
  assert.equal(m1.message.length, 48);
  step(a.phone, m1.message);
  assert.ok((await responder.readMessage(await fromJoiner("message 1", stepOf))).ok);
  const m2 = await responder.writeMessage();
  assert.ok(m2.ok);
  assert.equal(m2.message.length, 96);
  step(joiner, m2.message);
  assert.ok((await initiator.readMessage(await fromPhone("message 2", stepOf))).ok);
  const m3 = await initiator.writeMessage();
  assert.ok(m3.ok && m3.transport);
  assert.equal(m3.message.length, 64);
  step(a.phone, m3.message);
  const r3 = await responder.readMessage(await fromJoiner("message 3", stepOf));
  assert.ok(r3.ok && r3.transport);
  assert.deepEqual(r3.transport.handshakeHash, m3.transport.handshakeHash);
  const sent = m3.transport.send(new TextEncoder().encode("role and keys"));
  assert.ok(sent.ok);
  step(a.phone, sent.message);
  const got = r3.transport.receive(await fromJoiner("transport", stepOf));
  assert.ok(got.ok);
  assert.equal(new TextDecoder().decode(got.plaintext), "role and keys");
  a.phone.conn.stop();
  a.computer.conn.stop();
  joiner.conn.stop();
});
