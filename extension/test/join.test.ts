// /pirc join's computer side (join.ts) against the Go relay, with a test
// phone in TypeScript doing the phone's part (the app's is part 7): the
// code read, Noise XXpsk3 with the secret, the offers both ways, the list
// published and sent; then the account written and logged in to. And what
// the computer refuses: a wrong secret, a list without it, a phone's
// offer that fails, a code past its time.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { joinPrologue, load as loadE2e, makeOffer, readJoinText, ROLE_COMPUTER, type DeviceKeys } from "@pirc/e2e";
import { load as loadNoise, type Transport } from "@pirc/e2e/noise";
import { FrameSchema, JoinAcceptSchema, JoinOfferSchema, type Frame } from "@pirc/protocol/v1alpha2";
import { HostedConnection, type Signer } from "@pirc/relay-client/hosted";
import { wsSocket } from "@pirc/relay-client/hosted-ws";
import { randomBytes } from "node:crypto";
import { body, device as keysOf, makeList, seed, sha256, signingPair } from "../../e2e/test/make.ts";

import { Harness, startHostedRelay } from "../../test/harness.ts";
import { readSecrets, writeAccount } from "../src/account.ts";
import { Hosted } from "../src/hosted.ts";
import { ComputerJoin, qrLines } from "../src/join.ts";
import { accountId, alice, channelSecret, phone, v1, version } from "./account-fixture.ts";

const h = new Harness();
const running: { stop(): void }[] = [];
after(() => {
  for (const r of running) r.stop();
  return h.close();
});
const relay = await startHostedRelay(h);
const e2e = await loadE2e();
const noise = await loadNoise();

function signer(name: string): Signer {
  const p = signingPair(name);
  return { publicKey: p.publicKey, sign: async (m) => p.sign(m) };
}

async function until<T>(what: string, find: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = find();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function device(name: string, account: Uint8Array) {
  const frames: Frame[] = [];
  const conn = new HostedConnection({ origin: relay.origin, accountId: account, signer: signer(name), open: wsSocket, onFrame: (f) => frames.push(f), minBackoffMs: 50 });
  conn.start();
  running.push(conn);
  const taken = new Set<Frame>();
  const next = <T>(what: string, pick: (f: Frame) => T | undefined) =>
    until(what, () => {
      for (const f of frames) {
        if (taken.has(f)) continue;
        const v = pick(f);
        if (v !== undefined) {
          taken.add(f);
          return v;
        }
      }
      return undefined;
    });
  return { conn, next, ready: () => until(`${name} ready`, () => (conn.current.kind === "ready" ? true : undefined)) };
}

// The account's phone, signed up once for the file.
const p = device("phone", new Uint8Array(0));
await p.ready();
p.conn.send(create(FrameSchema, { body: { case: "signUp", value: { requestId: "s", attestation: { kind: { case: "test", value: new Uint8Array([1]) } }, list: v1 } } }));
await p.next("SignedUp", (f) => (f.body.case === "signedUp" ? f : undefined));
p.conn.switchAccount(accountId);
await p.ready();
let counter = 1n;
let request = 0;

function computerJoin(joinMs?: number) {
  const cj = new ComputerJoin({ origin: relay.origin, e2e, noise, open: wsSocket, random: (n) => new Uint8Array(randomBytes(n)), log: () => {}, joinMs });
  running.push({ stop: () => cj.cancel() });
  return cj;
}

interface PhoneSide {
  secret?: Uint8Array;
  // The list to send, given the computer as it offered itself.
  list?: (c: DeviceKeys) => Uint8Array;
  publish?: boolean;
  offerSigner?: string;
  first?: Uint8Array;
}

// The phone's part of a join, reading the computer's text; returns the
// computer as it offered itself, or undefined if the join ended first.
async function phoneJoins(text: string, o: PhoneSide = {}): Promise<DeviceKeys | undefined> {
  const code = readJoinText(text)!;
  let joinId = "";
  for (;;) {
    const id = `l${++request}`;
    p.conn.send(create(FrameSchema, { body: { case: "joinLookup", value: { requestId: id, lookup: code.lookup } } }));
    const r = await p.next("JoinPaired", (f) => (f.body.case === "joinPaired" && f.body.value.requestId === id ? f.body.value.joinId : f.body.case === "error" && f.body.value.requestId === id ? "" : undefined));
    if (r) {
      joinId = r;
      break;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  const step = (s: Uint8Array) => p.conn.send(create(FrameSchema, { body: { case: "joinMessage", value: { joinId, step: s } } }));
  const fromComputer = () => p.next("a step", (f) => (f.body.case === "joinMessage" && f.body.value.joinId === joinId ? f.body.value.step : f.body.case === "joinEnded" && f.body.value.joinId === joinId ? null : undefined));
  const init = noise.xxpsk3Initiator({ staticKey: noise.staticKey(channelSecret("phone")), prologue: joinPrologue(code.lookup), psk: o.secret ?? code.secret });
  const m1 = await init.writeMessage();
  assert.ok(m1.ok);
  step(m1.message);
  const m2 = await fromComputer();
  assert.ok(m2);
  assert.ok((await init.readMessage(m2)).ok);
  const m3 = await init.writeMessage();
  assert.ok(m3.ok && m3.transport);
  const t: Transport = m3.transport;
  step(m3.message);
  const offerStep = await fromComputer();
  if (!offerStep) return undefined;
  const r = t.receive(offerStep);
  assert.ok(r.ok);
  const offer = e2e.checkOffer({ offer: r.plaintext, role: ROLE_COMPUTER, remoteStatic: t.remoteStatic!, handshakeHash: t.handshakeHash });
  assert.equal(offer.result, "accepted");
  const computer = offer.result === "accepted" ? offer.device : undefined!;
  const list = (o.list ?? ((c) => version(++counter, [phone, c])))(computer);
  if (o.publish ?? true) {
    const id = `p${++request}`;
    p.conn.send(create(FrameSchema, { body: { case: "publishList", value: { requestId: id, list } } }));
    await p.next("Done", (f) => (f.body.case === "done" && f.body.value.requestId === id ? f : undefined));
  }
  const accept = create(JoinAcceptSchema, {
    phone: fromBinary(JoinOfferSchema, makeOffer(phone, t.handshakeHash, signingPair(o.offerSigner ?? "phone").sign)),
    first: o.first ?? v1,
    list,
    phoneName: new TextEncoder().encode("Pixel 9"),
  });
  const sent = t.send(toBinary(JoinAcceptSchema, accept));
  assert.ok(sent.ok);
  step(sent.message);
  return computer;
}

// Version 1 holding the phone's signing key with other keys beside it,
// and a version 2 made for that account, so that only the check of
// version 1's device against the phone's offer can refuse it.
function otherFirst(): PhoneSide {
  const EMPTY = new Uint8Array(0);
  const other = { ...phone, boxKey: keysOf("another phone", 2, true).boxKey };
  const firstBody = body({ accountId: EMPTY, counter: 1n, previousHash: EMPTY, devices: [other] });
  const first = makeList({ seed: seed("phone signing"), accountId: EMPTY, counter: 1n, previousBody: null, devices: [other] });
  return { first, publish: false, list: (c) => makeList({ seed: seed("phone signing"), accountId: sha256(firstBody), counter: 2n, previousBody: firstBody, devices: [other, c] }) };
}

test("a computer joins: the phone reads its code, both offer, the list adds it, and it logs in to the account", async () => {
  const cj = computerJoin();
  const done = cj.start();
  assert.equal(cj.text.length, 65);
  assert.ok(qrLines(cj.text).length > 10);
  const computer = await phoneJoins(cj.text);
  const joined = await done;
  assert.equal(joined.phoneName, "Pixel 9");
  assert.deepEqual(joined.info.accountId, accountId);
  assert.deepEqual(joined.info.phoneKey, phone.signingKey);
  assert.equal(joined.lists.length, 2);

  // Written and logged in to.
  const dir = join(mkdtempSync(join(tmpdir(), "pirc-join-")), "account");
  writeAccount(dir, joined.secrets, joined.info, joined.lists);
  assert.deepEqual(readSecrets(dir), joined.secrets);
  const hosted = await Hosted.open(dir, { instanceId: "i1", computerName: "c", lives: () => [], announce: () => {}, request: () => {}, onStatus: () => {}, log: () => {}, fail: () => {} });
  running.push(hosted);
  assert.deepEqual(hosted.signingKey, computer!.signingKey);
  hosted.start();
  await until("the joined computer logged in", () => (hosted.current.kind === "ready" ? true : undefined));
  hosted.stop();
});

test("refused: a wrong secret, a list without this computer, a phone's offer that fails, a list not the phone's", async () => {
  const cases: [string, PhoneSide, RegExp][] = [
    ["wrong secret", { secret: new Uint8Array(32).fill(1), publish: false }, /did not match/],
    ["no computer", { list: () => version(++counter, [phone, alice]), publish: false }, /refused \(self\)/],
    ["offer", { offerSigner: "alice", publish: false }, /offer was refused \(signature\)/],
    ["list signer", { list: (c) => version(++counter, [phone, c], new Uint8Array(32).fill(5)), publish: false }, /refused \(signature\)/],
    ["version 1 of another phone", otherFirst(), /not that phone's/],
  ];
  for (const [what, side, want] of cases) {
    const cj = computerJoin();
    const done = cj.start();
    const settled = done.then(
      () => assert.fail(`${what}: joined`),
      (e: Error) => assert.match(e.message, want, what),
    );
    await phoneJoins(cj.text, side);
    await settled;
  }
});

test("the code expires on the computer's own clock", async () => {
  const cj = computerJoin(200);
  await assert.rejects(cj.start(), /expired/);
});

