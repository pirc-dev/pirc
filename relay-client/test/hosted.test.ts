// The hosted connection (hosted.ts) against the Go relay's hosted mode:
// signing up with version 1 of the list, logging in to the account,
// publishing newer versions, a removed device told before its close, and
// a refused key retried rather than given up.
import { create } from "@bufbuild/protobuf";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { framed } from "@pirc/e2e/framed";
import { device, makeList, seed, sha256, signingPair } from "../../e2e/test/make.ts";
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

function connect(signer: Signer, accountId: Uint8Array, opts: { refusedRetryMs?: number; listCounter?: () => bigint } = {}) {
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
