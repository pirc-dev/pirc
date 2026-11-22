// The hosted connection (hosted.ts) against the Go relay's hosted mode:
// signing up, logging in to the account, and a refused key retried rather
// than given up.
import { create } from "@bufbuild/protobuf";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { framed } from "@pirc/e2e/framed";
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

function connect(signer: Signer, accountId: Uint8Array, opts: { refusedRetryMs?: number } = {}) {
  const frames: Frame[] = [];
  const states: HostedState[] = [];
  const waiters: (() => void)[] = [];
  const conn = new HostedConnection({
    origin: relay.origin,
    accountId,
    signer,
    open: wsSocket,
    onFrame: (f) => {
      frames.push(f);
      waiters.splice(0).forEach((w) => w());
    },
    onState: (s) => {
      states.push(s);
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
  return { conn, frames, states, until };
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

test("a phone signs up, logs in to its account, and a stranger is refused and tries again", async () => {
  const phone = await generate();
  const account = new Uint8Array(await crypto.subtle.digest("SHA-256", phone.publicKey as Uint8Array<ArrayBuffer>));
  const a = connect(phone, new Uint8Array(0));
  await a.until("ready", () => (a.conn.current.kind === "ready" ? true : undefined));
  assert.ok(a.conn.send(create(FrameSchema, { body: { case: "signUp", value: { requestId: "s", attestation: { kind: { case: "test", value: new Uint8Array([1]) } } } } })));
  const signedUp = await a.until("SignedUp", () => a.frames.find((f) => f.body.case === "signedUp"));
  assert.deepEqual(signedUp.body.value && "accountId" in signedUp.body.value && signedUp.body.value.accountId, account);

  a.conn.switchAccount(account);
  await a.until("Welcome", () => {
    const s = a.conn.current;
    return s.kind === "ready" && s.welcome.role === DeviceRole.CLIENT ? s.welcome : undefined;
  });
  a.conn.stop();

  const stranger = connect(await generate(), account, { refusedRetryMs: 100 });
  await stranger.until("two refusals", () => (stranger.states.filter((s) => s.kind === "refused").length >= 2 ? true : undefined));
  const r = stranger.states.find((s) => s.kind === "refused");
  assert.ok(r?.kind === "refused" && r.code === ErrorCode.UNAUTHENTICATED);
  stranger.conn.stop();
});
