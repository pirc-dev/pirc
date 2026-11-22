// Noise: the published vectors in cases/noise/ and every case of
// cases/e2e/channel.json, each file's shape checked and the count run
// checked against it, then what bytes cannot show.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import sodium from "libsodium-wrappers-sumo";

import { channelPrologue, load, type Transport as PublicTransport } from "../noise.ts";
import { CipherState, Handshake, IK, MAX_PLAINTEXT, nonceBytes, NONCE_CAP, once, XXPSK3, type HandshakeInit, type Pattern, type StaticKey, type Transport } from "../noise-core.ts";
import { CHECK_PATTERNS, fromHex, partyHandshake, PATTERNS, runChannel, runVector, toHex, VECTOR_KEYS, VECTOR_OPTIONAL, type ChannelCase, type ChannelFile, type VectorFile } from "./channel.ts";

await sodium.ready;
const noise = await load();
const libsodiumKeys = async (s: Uint8Array) => noise.staticKey(s);
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;
const sameKeys = (o: unknown, keys: string[], what: string) => assert.deepEqual(Object.keys(o as object).sort(), [...keys].sort(), what);
const REASONS = ["length", "dh", "decrypt", "dead"];

// ------------------------------------------------------------ the files

test("cases/noise: the published vectors", async () => {
  let ran = 0;
  let total = 0;
  for (const name of ["cacophony", "snow"]) {
    const file = read<VectorFile>(`../../cases/noise/${name}.json`);
    sameKeys(file, ["about", "source", "commit", "licence", "vectors"], `${name}: its keys`);
    assert.match(file.commit, /^[0-9a-f]{40}$/, `${name}: its commit`);
    assert.ok(file.source.includes(file.commit), `${name}: the source at its commit`);
    assert.ok(file.vectors.length > 0, `${name}: no vectors`);
    total += file.vectors.length;
    for (const v of file.vectors) {
      for (const k of VECTOR_KEYS) assert.ok(k in v, `${name}, ${v.protocol_name}: no ${k}`);
      for (const k of Object.keys(v)) assert.ok(VECTOR_KEYS.includes(k) || VECTOR_OPTIONAL.includes(k), `${name}, ${v.protocol_name}: unknown key ${k}`);
      for (const m of v.messages) sameKeys(m, ["payload", "ciphertext"], `${name}: a message's keys`);
      assert.ok(v.protocol_name in PATTERNS, `${name}: ${v.protocol_name}`);
      assert.deepEqual(await runVector(sodium, v, libsodiumKeys), [], `${name}, ${v.protocol_name}`);
      ran++;
    }
  }
  assert.equal(ran, total);
  // cacophony's IK and XXpsk3 with their handshake hashes, and snow's IK without.
  assert.equal(total, 3);
});

const PARTY_KEYS: Record<string, { required: string[]; optional: string[] }> = {
  "IK initiator": { required: ["role", "staticKey", "ephemeralKey", "responderKey"], optional: [] },
  "IK responder": { required: ["role", "staticKey", "ephemeralKey"], optional: [] },
  "XXpsk3 initiator": { required: ["role", "staticKey", "ephemeralKey", "prologue", "psk"], optional: [] },
  "XXpsk3 responder": { required: ["role", "staticKey", "ephemeralKey", "prologue", "psk"], optional: [] },
};
const STEP_KEYS: Record<string, string[][]> = {
  write: [["bytes"], ["bytes", "done"], ["fails"]],
  read: [["bytes"], ["bytes", "done"], ["bytes", "fails"]],
  send: [["plaintext", "bytes"], ["plaintext", "fails"], ["plaintext", "throws"]],
  receive: [["bytes", "plaintext"], ["bytes", "fails"]],
};
/** A need, and what in a case makes it need it. */
const EVIDENCE: Record<string, (c: Extract<ChannelCase, { parties: unknown }>) => boolean> = {
  "ik-responder": (c) => c.check === "IK" && Object.values(c.parties).some((p) => p.role === "responder"),
  "own-prologue": (c) => c.check === "IK" && Object.values(c.parties).some((p) => "prologue" in p),
  xxpsk3: (c) => c.check === "XXpsk3",
};
/** What this package has: everything. */
const HAS = new Set(Object.keys(EVIDENCE));

function shapeOf(where: string, c: ChannelCase): void {
  if (c.check === "prologue") {
    sameKeys(c, ["check", "about", "needs", "accountId", "bytes"], `${where}: its keys`);
    assert.deepEqual(c.needs, [], `${where}: needs`);
    return;
  }
  assert.ok(c.check in CHECK_PATTERNS, `${where}: unknown check ${String(c.check)}`);
  sameKeys(c, ["check", "about", "needs", "parties", "steps"], `${where}: its keys`);
  for (const n of c.needs) assert.ok(n in EVIDENCE, `${where}: unknown need ${n}`);
  for (const [n, has] of Object.entries(EVIDENCE)) assert.equal(c.needs.includes(n), has(c), `${where}: needs ${n} iff the case shows it`);
  for (const [name, p] of Object.entries(c.parties)) {
    const shape = PARTY_KEYS[`${c.check} ${p.role}`];
    assert.ok(shape, `${where}: party ${name}'s role`);
    const keys = [...shape.required, ...(c.check === "IK" ? ["accountId" in p ? "accountId" : "prologue"] : [])];
    sameKeys(p, keys, `${where}: party ${name}'s keys`);
  }
  assert.ok(c.steps.length > 0, `${where}: no steps`);
  for (const [i, s] of c.steps.entries()) {
    assert.ok(s.party in c.parties, `${where}, step ${i}: no party ${s.party}`);
    const forms = STEP_KEYS[s.call];
    assert.ok(forms, `${where}, step ${i}: unknown call ${String(s.call)}`);
    const keys = Object.keys(s).filter((k) => k !== "party" && k !== "call").sort();
    assert.ok(forms.some((f) => JSON.stringify([...f].sort()) === JSON.stringify(keys)), `${where}, step ${i}: keys ${keys.join(", ")}`);
    if ("fails" in s) assert.ok(REASONS.includes(s.fails), `${where}, step ${i}: reason ${s.fails}`);
    if ("throws" in s) assert.equal(s.throws, true);
    if ("done" in s && s.done) sameKeys(s.done, ["handshakeHash", "remoteStatic", "confirmed"], `${where}, step ${i}: done's keys`);
  }
  // After a failure, every call of that party gives dead.
  const failed = new Set<string>();
  for (const [i, s] of c.steps.entries()) {
    if (failed.has(s.party)) assert.ok("fails" in s && s.fails === "dead", `${where}, step ${i}: dead after a failure`);
    if (("fails" in s && s.fails !== "dead") || "throws" in s) failed.add(s.party);
  }
}

test("cases/e2e/channel.json", async () => {
  const file = read<ChannelFile>("../../cases/e2e/channel.json");
  sameKeys(file, ["about", "cases"], "channel.json: its keys");
  assert.ok(file.cases.length > 0);
  let ran = 0;
  for (const [i, c] of file.cases.entries()) {
    shapeOf(`channel.json, case ${i}`, c);
    if (!c.needs.every((n) => HAS.has(n))) continue;
    assert.deepEqual(await runChannel(sodium, c, libsodiumKeys), [], c.about);
    ran++;
  }
  assert.equal(ran, file.cases.length, "every case in channel.json needs only what this package has");
});

test("channel.json: each failure, its reason, and dead after it, at each side", () => {
  const file = read<ChannelFile>("../../cases/e2e/channel.json");
  const seen = new Set<string>();
  for (const c of file.cases) {
    if (c.check === "prologue") continue;
    for (const s of c.steps) {
      const role = c.parties[s.party].role;
      if ("fails" in s) seen.add(`${c.check} ${role} ${s.call} ${s.fails}`);
    }
  }
  for (const want of [
    "IK initiator write dh",
    "IK initiator read length",
    "IK initiator read decrypt",
    "IK initiator read dh",
    "IK initiator receive length",
    "IK initiator receive decrypt",
    "IK initiator write dead",
    "IK initiator read dead",
    "IK initiator send dead",
    "IK initiator receive dead",
    "IK responder read length",
    "IK responder read decrypt",
    "IK responder read dh",
    "IK responder receive length",
    "IK responder receive decrypt",
    "IK responder write dead",
    "IK responder read dead",
    "IK responder send dead",
    "IK responder receive dead",
    "XXpsk3 initiator read length",
    "XXpsk3 initiator read decrypt",
    "XXpsk3 initiator read dh",
    "XXpsk3 responder read length",
    "XXpsk3 responder read decrypt",
    "XXpsk3 responder read dh",
    "XXpsk3 responder write dh",
    "XXpsk3 initiator receive decrypt",
    "XXpsk3 responder receive decrypt",
    "XXpsk3 initiator send dead",
    "XXpsk3 responder send dead",
    "XXpsk3 initiator receive dead",
    "XXpsk3 responder receive dead",
  ]) {
    assert.ok(seen.has(want), want);
  }
});

// ------------------------------------------------------- what bytes cannot show

const secret = (name: string) => sodium.crypto_generichash(32, new TextEncoder().encode(`noise test ${name}`), null);
const ACCOUNT = secret("account");
const CLIENT = noise.staticKey(secret("client"));
const COMPUTER = noise.staticKey(secret("computer"));
const PSK = secret("psk");
const PROLOGUE = new TextEncoder().encode("a test prologue");

function core(pattern: Pattern, initiator: boolean, over: Partial<HandshakeInit> = {}): Handshake {
  const ik = pattern === IK;
  return new Handshake(sodium, {
    pattern,
    initiator,
    staticKey: initiator ? CLIENT : COMPUTER,
    ...(ik && initiator ? { remoteStatic: COMPUTER.publicKey } : {}),
    prologue: ik ? channelPrologue(ACCOUNT) : PROLOGUE,
    ...(ik ? {} : { psk: PSK }),
    payloads: false,
    ...over,
  });
}

/** A handshake to its end between two cores: the transports, initiator's first. */
async function pair(pattern: Pattern, i = core(pattern, true), r = core(pattern, false)): Promise<[Transport, Transport]> {
  let ti: Transport | undefined;
  let tr: Transport | undefined;
  for (let n = 0; n < pattern.messages.length; n++) {
    const [w, rd] = n % 2 === 0 ? [i, r] : [r, i];
    const m = await w.writeMessage();
    assert.ok(m.ok);
    const got = await rd.readMessage(m.message);
    assert.ok(got.ok);
    for (const [h, t] of [
      [w, m.transport],
      [rd, got.transport],
    ] as const) {
      if (t) h === i ? (ti = t) : (tr = t);
    }
  }
  assert.ok(ti && tr);
  return [ti, tr];
}

const flip = (b: Uint8Array): Uint8Array => {
  const out = b.slice();
  out[out.length - 1] ^= 1;
  return out;
};
const LOW = fromHex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800");
const isZero = (b: Uint8Array) => b.every((x) => x === 0);

test("the counter: 255, 256, 2^32, 2^53+1 and 2^63-2 give libsodium's bytes with the nonce typed out", async () => {
  const byHand: [bigint, string][] = [
    [255n, "00000000ff00000000000000"],
    [256n, "000000000001000000000000"],
    [2n ** 32n, "000000000000000001000000"],
    [2n ** 53n + 1n, "000000000100000000002000"],
    [2n ** 63n - 2n, "00000000feffffffffffff7f"],
  ];
  for (const [n, nonce] of byHand) {
    assert.equal(toHex(nonceBytes(n)), nonce, String(n));
    const [ti, tr] = await pair(IK);
    const key = ti.sendCipher.k!.slice();
    ti.sendCipher.n = n;
    tr.receiveCipher.n = n;
    const plaintext = Uint8Array.of(1, 2, 3);
    const sent = ti.send(plaintext);
    assert.ok(sent.ok);
    assert.equal(toHex(sent.message), toHex(sodium.crypto_aead_chacha20poly1305_ietf_encrypt(plaintext, new Uint8Array(0), null, fromHex(nonce), key)), String(n));
    assert.deepEqual(tr.receive(sent.message), { ok: true, plaintext });
    assert.equal(ti.sendCipher.n, n + 1n);
  }
});

test("the counter's cap: 2^63-2 is the last used; a call that would use 2^63-1 throws and kills the transport", async () => {
  assert.equal(NONCE_CAP, 2n ** 63n - 1n);
  {
    const [ti, tr] = await pair(IK);
    ti.sendCipher.n = NONCE_CAP - 1n;
    assert.ok(ti.send(new Uint8Array(1)).ok);
    assert.throws(() => ti.send(new Uint8Array(1)), RangeError);
    assert.deepEqual(ti.send(new Uint8Array(1)), { ok: false, reason: "dead" });
    assert.deepEqual(ti.receive(new Uint8Array(16)), { ok: false, reason: "dead" });
    assert.ok(isZero(ti.sendCipher.k!) && isZero(ti.receiveCipher.k!));
    void tr;
  }
  {
    const [ti, tr] = await pair(IK);
    const m = ti.send(new Uint8Array(1));
    assert.ok(m.ok);
    tr.receiveCipher.n = NONCE_CAP;
    assert.throws(() => tr.receive(m.message), RangeError);
    assert.deepEqual(tr.send(new Uint8Array(1)), { ok: false, reason: "dead" });
    assert.deepEqual(tr.receive(m.message), { ok: false, reason: "dead" });
  }
  const c = new CipherState(sodium);
  c.setKey(new Uint8Array(32).fill(1));
  c.n = NONCE_CAP;
  assert.throws(() => c.encrypt(new Uint8Array(0), new Uint8Array(0)), RangeError);
  assert.throws(() => c.decrypt(new Uint8Array(0), new Uint8Array(16)), RangeError);
});

test("close() zeroes both keys, and every later call gives dead", async () => {
  const [ti] = await pair(XXPSK3);
  const keys = [ti.sendCipher.k!, ti.receiveCipher.k!];
  assert.ok(!keys.some(isZero));
  ti.close();
  assert.ok(keys.every(isZero));
  assert.deepEqual(ti.send(new Uint8Array(1)), { ok: false, reason: "dead" });
  assert.deepEqual(ti.receive(new Uint8Array(17)), { ok: false, reason: "dead" });
});

test("confirmed: the IK responder and the XXpsk3 initiator only once a message from the other side decrypts; the IK initiator and the XXpsk3 responder at once", async () => {
  const i = core(IK, true);
  const r = core(IK, false);
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  assert.equal(r.remoteStatic, null);
  assert.ok((await r.readMessage(m1.message)).ok);
  assert.deepEqual(r.remoteStatic, CLIENT.publicKey, "the initiator's key, unconfirmed, after message 1");
  const m2 = await r.writeMessage();
  assert.ok(m2.ok && m2.transport);
  const tr = m2.transport;
  assert.equal(tr.confirmed, false);
  const got = await i.readMessage(m2.message);
  assert.ok(got.ok && got.transport);
  assert.equal(got.transport.confirmed, true);
  // A message that does not decrypt confirms nothing.
  const r2 = core(IK, false);
  assert.ok((await r2.readMessage(m1.message)).ok);
  const m2b = await r2.writeMessage();
  assert.ok(m2b.ok && m2b.transport);
  const sent = got.transport.send(Uint8Array.of(7));
  assert.ok(sent.ok);
  assert.deepEqual(m2b.transport.receive(sent.message), { ok: false, reason: "decrypt" });
  assert.equal(m2b.transport.confirmed, false);
  assert.deepEqual(tr.receive(sent.message), { ok: true, plaintext: Uint8Array.of(7) });
  assert.equal(tr.confirmed, true);
  const [xi, xr] = await pair(XXPSK3);
  assert.ok(!xi.confirmed && xr.confirmed);
  const early = xi.send(Uint8Array.of(1));
  assert.ok(early.ok, "the XXpsk3 initiator sends unconfirmed");
  assert.equal(xi.confirmed, false);
  assert.deepEqual(xr.receive(early.message), { ok: true, plaintext: Uint8Array.of(1) });
  const back = xr.send(Uint8Array.of(2));
  assert.ok(back.ok);
  assert.deepEqual(xi.receive(flip(back.message)), { ok: false, reason: "decrypt" }, "a message that does not decrypt");
  assert.equal(xi.confirmed, false);
  const [xi2, xr2] = await pair(XXPSK3);
  const m = xr2.send(Uint8Array.of(3));
  assert.ok(m.ok);
  assert.deepEqual(xi2.receive(m.message), { ok: true, plaintext: Uint8Array.of(3) });
  assert.equal(xi2.confirmed, true);
});

test("the IK responder's send throws before confirmation, and the transport is then dead", async () => {
  const [ti, tr] = await pair(IK);
  assert.throws(() => tr.send(Uint8Array.of(1)), TypeError);
  const m = ti.send(Uint8Array.of(1));
  assert.ok(m.ok);
  assert.deepEqual(tr.receive(m.message), { ok: false, reason: "dead" });
  assert.deepEqual(tr.send(Uint8Array.of(1)), { ok: false, reason: "dead" });
});

/** A static key whose DH waits until released. */
function slowKey(inner: StaticKey): { key: StaticKey; release: () => void; seen: Uint8Array[] } {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const seen: Uint8Array[] = [];
  return {
    key: {
      publicKey: inner.publicKey,
      dh: async (p) => {
        seen.push(p);
        await gate;
        return inner.dh(p);
      },
    },
    release: () => release(),
    seen,
  };
}

test("a call while another is pending throws, kills the handshake, and the pending one then gives dead", async () => {
  for (const second of ["write", "read"] as const) {
    const slow = slowKey(COMPUTER);
    const i = core(IK, true);
    const r = core(IK, false, { staticKey: slow.key });
    const m1 = await i.writeMessage();
    assert.ok(m1.ok);
    const pending = r.readMessage(m1.message);
    await new Promise((res) => setTimeout(res, 0));
    assert.equal(slow.seen.length, 1, "waiting in es");
    await assert.rejects(second === "write" ? r.writeMessage() : r.readMessage(m1.message), TypeError);
    slow.release();
    assert.deepEqual(await pending, { ok: false, reason: "dead" });
    assert.deepEqual(await r.writeMessage(), { ok: false, reason: "dead" });
    assert.ok(isZero(r.symmetric.ck));
  }
});

test("the peer key given to a static key's dh() is a copy", async () => {
  const given: Uint8Array[] = [];
  const key: StaticKey = { publicKey: CLIENT.publicKey, dh: async (p) => (given.push(p), CLIENT.dh(p)) };
  const responderKey = COMPUTER.publicKey;
  const i = core(IK, true, { staticKey: key, remoteStatic: responderKey });
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  given[0].fill(0);
  const r = core(IK, false);
  assert.ok((await r.readMessage(m1.message)).ok, "zeroing the copy changed nothing");
  assert.deepEqual(i.remoteStatic, responderKey);
});

test("a static key's dh() that rejects, or gives other than 32 bytes, or zeros, is a dh failure, never an exception", async () => {
  for (const [about, dh] of [
    ["rejects", async () => Promise.reject(new Error("gone"))],
    ["throws", () => {
      throw new Error("gone");
    }],
    ["31 bytes", async () => new Uint8Array(31).fill(1)],
    ["33 bytes", async () => new Uint8Array(33).fill(1)],
    ["zeros", async () => new Uint8Array(32)],
    ["not bytes", async () => "1".repeat(32) as unknown as Uint8Array],
    ["an array", async () => Array(32).fill(1) as unknown as Uint8Array],
  ] as const) {
    const i = core(IK, true, { staticKey: { publicKey: CLIENT.publicKey, dh: dh as StaticKey["dh"] } });
    assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dh" }, about);
    assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dead" }, about);
  }
});

test("the DH order: an initiator's static key meets a remote key only after an ephemeral DH with it", async () => {
  // In the patterns' tokens.
  const uses = (t: string, initiator: boolean) => {
    const local = t[initiator ? 0 : 1];
    const remote = t[initiator ? 1 : 0];
    return { local, remote };
  };
  for (const [pattern, sides] of [
    [IK, [true]],
    [XXPSK3, [true, false]],
  ] as const) {
    for (const initiator of sides) {
      const before = new Set<string>();
      for (const t of pattern.messages.flat()) {
        if (t.length !== 2) continue;
        const { local, remote } = uses(t, initiator);
        if (local === "s") assert.ok(before.has(remote), `${pattern.name}: ${t} before an ephemeral DH with r${remote}`);
        if (local === "e") before.add(remote);
      }
    }
  }
  // In a run: given a low-order key, the static key's dh() is never called.
  const spy = (inner: StaticKey) => {
    const seen: string[] = [];
    return { seen, key: { publicKey: inner.publicKey, dh: async (p: Uint8Array) => (seen.push(toHex(p)), inner.dh(p)) } };
  };
  {
    const s = spy(CLIENT);
    const i = core(IK, true, { staticKey: s.key, remoteStatic: LOW });
    assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dh" });
    assert.deepEqual(s.seen, []);
  }
  {
    const s = spy(CLIENT);
    const i = core(IK, true, { staticKey: s.key });
    assert.ok((await i.writeMessage()).ok);
    const m2 = new Uint8Array(48);
    m2.set(LOW);
    assert.deepEqual(await i.readMessage(m2), { ok: false, reason: "dh" });
    assert.deepEqual(s.seen, [toHex(COMPUTER.publicKey)], "only ss, with the computer's key");
  }
  {
    const s = spy(CLIENT);
    const i = core(XXPSK3, true, { staticKey: s.key });
    assert.ok((await i.writeMessage()).ok);
    const m2 = new Uint8Array(96);
    m2.set(LOW);
    assert.deepEqual(await i.readMessage(m2), { ok: false, reason: "dh" });
    assert.deepEqual(s.seen, []);
  }
});

test("no input bytes make a handshake or a transport throw", async () => {
  const lengths = [0, 1, 15, 16, 17, 31, 32, 47, 48, 49, 63, 64, 65, 95, 96, 97, 200, 65_535, 65_536];
  const inputs = lengths.flatMap((n) => [new Uint8Array(n), sodium.randombytes_buf(n), new Uint8Array(n).fill(0xff)]);
  for (const bytes of inputs) {
    const readers: Handshake[] = [core(IK, false), core(XXPSK3, false)];
    const i = core(IK, true);
    assert.ok((await i.writeMessage()).ok);
    const x = core(XXPSK3, true);
    assert.ok((await x.writeMessage()).ok);
    readers.push(i, x);
    for (const h of readers) {
      const r = await h.readMessage(bytes);
      assert.ok(!r.ok && REASONS.includes(r.reason), `${bytes.length} bytes`);
    }
    const [ti, tr] = await pair(IK);
    for (const t of [ti, tr]) {
      const r = t.receive(bytes);
      assert.ok(!r.ok && REASONS.includes(r.reason), `${bytes.length} bytes`);
    }
  }
});

test("a caller's mistakes throw, and kill the state", async () => {
  const ok = { staticKey: CLIENT, responderKey: COMPUTER.publicKey, accountId: ACCOUNT };
  for (const bad of [{ accountId: new Uint8Array(31) }, { accountId: new Uint8Array(33) }, { accountId: "00".repeat(32) as unknown as Uint8Array }, { responderKey: new Uint8Array(31) }, { staticKey: { publicKey: new Uint8Array(31), dh: CLIENT.dh } }, { staticKey: {} as StaticKey }]) {
    assert.throws(() => noise.ikInitiator({ ...ok, ...bad }), TypeError, JSON.stringify(Object.keys(bad)));
  }
  assert.throws(() => noise.ikResponder({ staticKey: COMPUTER, accountId: new Uint8Array(0) }), TypeError);
  for (const psk of [new Uint8Array(31), new Uint8Array(33), undefined]) {
    assert.throws(() => noise.xxpsk3Initiator({ staticKey: CLIENT, prologue: PROLOGUE, psk: psk as Uint8Array }), TypeError);
  }
  assert.throws(() => noise.xxpsk3Responder({ staticKey: COMPUTER, prologue: "x" as unknown as Uint8Array, psk: PSK }), TypeError);
  assert.throws(() => noise.staticKey(new Uint8Array(31)), TypeError);
  assert.throws(() => noise.staticKey("a".repeat(32) as unknown as Uint8Array), TypeError, "a string libsodium would take");
  assert.throws(() => noise.staticKey(Array(32).fill(1) as unknown as Uint8Array), TypeError, "an array of 32 numbers, which a copy would take");
  assert.throws(() => core(IK, true, { staticKey: { publicKey: CLIENT.publicKey } as StaticKey }), TypeError, "a static key without dh()");
  assert.throws(() => core(IK, true, { staticKey: { publicKey: CLIENT.publicKey, dh: "x" } as unknown as StaticKey }), TypeError, "a dh that is not a function");
  assert.throws(() => core(IK, false, { remoteStatic: COMPUTER.publicKey }), TypeError, "a responder given a remote key");
  assert.throws(() => core(IK, true, { psk: PSK }), TypeError, "a PSK for IK");
  assert.throws(() => core(IK, true, { ephemeral: new Uint8Array(31) }), TypeError);

  // Out of order, then dead.
  for (const [about, call] of [
    ["the responder writing first", (r: Handshake) => r.writeMessage()],
    ["the initiator reading first", (_r: Handshake, i: Handshake) => i.readMessage(new Uint8Array(48))],
  ] as const) {
    const i = core(IK, true);
    const r = core(IK, false);
    const h = about.startsWith("the responder") ? r : i;
    await assert.rejects(call(r, i), TypeError, about);
    assert.deepEqual(await h.writeMessage(), { ok: false, reason: "dead" }, about);
    assert.deepEqual(await h.readMessage(new Uint8Array(96)), { ok: false, reason: "dead" }, about);
  }
  {
    const i = core(IK, true);
    const r = core(IK, false);
    const [ti] = await pair(IK, i, r);
    await assert.rejects(i.writeMessage(), /the handshake is over/);
    await assert.rejects(r.readMessage(new Uint8Array(96)), /the handshake is over/);
    assert.ok(ti.send(Uint8Array.of(1)).ok, "the transport lives on");
  }
  {
    const r = core(IK, false);
    await assert.rejects(r.readMessage("00".repeat(48) as unknown as Uint8Array), TypeError, "96 characters, not bytes");
    assert.deepEqual(await r.readMessage(new Uint8Array(96)), { ok: false, reason: "dead" });
    const r2 = core(IK, false);
    await assert.rejects(r2.readMessage(new Uint16Array(96) as unknown as Uint8Array), TypeError, "96 elements, not bytes");
    assert.deepEqual(await r2.readMessage(new Uint8Array(96)), { ok: false, reason: "dead" });
  }
  {
    const i = core(IK, true);
    await assert.rejects(i.writeMessage(Uint8Array.of(1)), TypeError, "a payload where PiRC carries none");
    assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dead" });
  }
  // A transport: too long a plaintext, not bytes.
  for (const bad of [new Uint8Array(MAX_PLAINTEXT + 1), "x" as unknown as Uint8Array]) {
    const [ti, tr] = await pair(IK);
    assert.throws(() => ti.send(bad), TypeError);
    assert.deepEqual(ti.send(new Uint8Array(1)), { ok: false, reason: "dead" });
    assert.deepEqual(ti.receive(new Uint8Array(16)), { ok: false, reason: "dead" });
    if (typeof bad === "string") {
      assert.throws(() => tr.receive(bad), TypeError);
      assert.deepEqual(tr.send(new Uint8Array(1)), { ok: false, reason: "dead" });
    } else assert.deepEqual(tr.receive(new Uint8Array(MAX_PLAINTEXT + 17)), { ok: false, reason: "length" }, "too long a message is a result");
  }
  {
    const [ti] = await pair(IK);
    assert.ok(ti.send(new Uint8Array(MAX_PLAINTEXT)).ok, "65,519 bytes is not too long");
  }
});

test("random messages through real handshakes, by the public API", async () => {
  const ik = async () => {
    const i = noise.ikInitiator({ staticKey: CLIENT, responderKey: COMPUTER.publicKey, accountId: ACCOUNT });
    const r = noise.ikResponder({ staticKey: COMPUTER, accountId: ACCOUNT });
    const m1 = await i.writeMessage();
    assert.ok(m1.ok && m1.message.length === 96 && !m1.transport);
    assert.ok((await r.readMessage(m1.message)).ok);
    const m2 = await r.writeMessage();
    assert.ok(m2.ok && m2.message.length === 48 && m2.transport);
    const done = await i.readMessage(m2.message);
    assert.ok(done.ok && done.transport);
    return { m1: m1.message, ti: done.transport, tr: m2.transport };
  };
  const a = await ik();
  const b = await ik();
  assert.notDeepEqual(a.m1, b.m1, "a fresh ephemeral key per handshake");
  assert.deepEqual(a.ti.handshakeHash, a.tr.handshakeHash);
  assert.deepEqual(a.tr.remoteStatic, CLIENT.publicKey);
  assert.deepEqual(a.ti.remoteStatic, COMPUTER.publicKey);
  for (let n = 0; n < 50; n++) {
    const size = n === 49 ? MAX_PLAINTEXT : sodium.randombytes_uniform(2000);
    const p = sodium.randombytes_buf(size);
    const [from, to]: PublicTransport[] = n % 2 === 0 ? [a.ti, a.tr] : [a.tr, a.ti];
    const m = from.send(p);
    assert.ok(m.ok);
    assert.equal(m.message.length, size + 16);
    assert.deepEqual(to.receive(m.message), { ok: true, plaintext: p });
  }

  const xi = noise.xxpsk3Initiator({ staticKey: CLIENT, prologue: PROLOGUE, psk: PSK });
  const xr = noise.xxpsk3Responder({ staticKey: COMPUTER, prologue: PROLOGUE, psk: PSK });
  const x1 = await xi.writeMessage();
  assert.ok(x1.ok && x1.message.length === 48);
  assert.ok((await xr.readMessage(x1.message)).ok);
  const x2 = await xr.writeMessage();
  assert.ok(x2.ok && x2.message.length === 96);
  assert.ok((await xi.readMessage(x2.message)).ok);
  assert.deepEqual(xi.remoteStatic, COMPUTER.publicKey);
  const x3 = await xi.writeMessage();
  assert.ok(x3.ok && x3.message.length === 64 && x3.transport);
  const xd = await xr.readMessage(x3.message);
  assert.ok(xd.ok && xd.transport);
  assert.deepEqual(xd.transport.remoteStatic, CLIENT.publicKey);
  assert.deepEqual(xd.transport.handshakeHash, x3.transport.handshakeHash);
  const xa: PublicTransport = x3.transport;
  const xb: PublicTransport = xd.transport;
  for (let n = 0; n < 20; n++) {
    const p = sodium.randombytes_buf(sodium.randombytes_uniform(500));
    const [from, to] = n % 2 === 0 ? [xb, xa] : [xa, xb];
    const m: ReturnType<PublicTransport["send"]> = from.send(p);
    assert.ok(m.ok);
    assert.deepEqual(to.receive(m.message), { ok: true, plaintext: p });
  }
});

test("the messages' fixed lengths: IK 96 and 48, XXpsk3 48, 96 and 64", async () => {
  const file = read<ChannelFile>("../../cases/e2e/channel.json");
  const main = (about: string) => file.cases.find((c) => c.about.startsWith(about));
  for (const [about, lengths] of [
    ["IK: both messages", [96, 48]],
    ["XXpsk3: three messages", [48, 96, 64]],
  ] as const) {
    const c = main(about);
    assert.ok(c && c.check !== "prologue");
    assert.deepEqual(
      c.steps.filter((s) => s.call === "write").map((s) => ("bytes" in s ? s.bytes.length / 2 : -1)),
      lengths,
    );
  }
});

test("secrets zeroed: when a handshake finishes, when it dies, and the DH outputs it is given", async () => {
  const outputs: Uint8Array[] = [];
  const keeping = (inner: StaticKey): StaticKey => ({ publicKey: inner.publicKey, dh: async (p) => {
    const o = await inner.dh(p);
    outputs.push(o);
    return o;
  } });
  for (const pattern of [IK, XXPSK3]) {
    const i = core(pattern, true, { staticKey: keeping(CLIENT), ephemeral: secret("ephemeral i") });
    const r = core(pattern, false, { staticKey: keeping(COMPUTER), ephemeral: secret("ephemeral r") });
    const held = [i, r].flatMap((h) => [h.eSecret!, h.symmetric.ck, ...(h.psk ? [h.psk] : [])]);
    assert.ok(!held.some(isZero));
    const keys: Uint8Array[] = [];
    let n = 0;
    for (let k = 0; k < pattern.messages.length; k++) {
      const [w, rd] = k % 2 === 0 ? [i, r] : [r, i];
      const m = await w.writeMessage();
      assert.ok(m.ok);
      for (const h of [i, r]) if (h.symmetric.cipher.k) keys.push(h.symmetric.cipher.k);
      held.push(i.symmetric.ck, r.symmetric.ck);
      assert.ok((await rd.readMessage(m.message)).ok);
      n++;
    }
    assert.equal(n, pattern.messages.length);
    for (const b of [...held, ...keys, ...outputs]) assert.ok(isZero(b), pattern.name);
    assert.ok(isZero(i.eSecret!) && isZero(r.eSecret!));
  }
  // Dying: a failure zeroes the same.
  const i = core(IK, true, { ephemeral: secret("ephemeral i") });
  assert.ok((await i.writeMessage()).ok);
  const held = [i.eSecret!, i.symmetric.ck, i.symmetric.cipher.k!];
  assert.ok(!held.some(isZero));
  assert.deepEqual(await i.readMessage(new Uint8Array(48).fill(9)), { ok: false, reason: "decrypt" });
  assert.ok(held.every(isZero));
});

test("secrets zeroed: every HMAC output, ephemeral key and ephemeral DH output once the handshake ends, the transport's keys once closed", async () => {
  for (const pattern of [IK, XXPSK3]) {
    const made: Uint8Array[] = [];
    const keep = <A extends unknown[]>(f: (...a: A) => Uint8Array) => (...a: A) => {
      const out = f(...a);
      made.push(out);
      return out;
    };
    const spy = Object.create(sodium) as typeof sodium;
    Object.assign(spy, {
      crypto_auth_hmacsha512_final: keep((st: never) => sodium.crypto_auth_hmacsha512_final(st)),
      crypto_scalarmult: keep((a: Uint8Array, b: Uint8Array) => sodium.crypto_scalarmult(a, b)),
      randombytes_buf: keep((n: number) => sodium.randombytes_buf(n)),
    });
    const at = (initiator: boolean) => new Handshake(spy, { pattern, initiator, staticKey: initiator ? CLIENT : COMPUTER, ...(pattern === IK && initiator ? { remoteStatic: COMPUTER.publicKey } : {}), prologue: PROLOGUE, ...(pattern === IK ? {} : { psk: PSK }), payloads: false });
    const [ti, tr] = await pair(pattern, at(true), at(false));
    assert.ok(made.length > 20, pattern.name);
    assert.ok(made.every(isZero), `${pattern.name}: ${made.filter((b) => !isZero(b)).length} of ${made.length} not zeroed`);
    for (const t of [ti, tr]) {
      const keys = [t.sendCipher.k!, t.receiveCipher.k!];
      assert.ok(!keys.some(isZero));
      t.close();
      assert.ok(keys.every(isZero));
    }
  }
});

test("an exception from libsodium inside a call is passed on, and kills the handshake", async () => {
  const spy = Object.create(sodium) as typeof sodium;
  Object.assign(spy, {
    crypto_aead_chacha20poly1305_ietf_encrypt: () => {
      throw new Error("out of memory");
    },
  });
  const i = new Handshake(spy, { pattern: IK, initiator: true, staticKey: CLIENT, remoteStatic: COMPUTER.publicKey, prologue: PROLOGUE, payloads: false });
  await assert.rejects(i.writeMessage(), /out of memory/);
  assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dead" });
  assert.ok(isZero(i.symmetric.ck));
});

test("a pending call killed by another gives dead even when its DH then rejects", async () => {
  let fail = () => {};
  const gate = new Promise<void>((r) => (fail = r));
  const key: StaticKey = { publicKey: COMPUTER.publicKey, dh: async () => {
    await gate;
    throw new Error("gone");
  } };
  const i = core(IK, true);
  const r = core(IK, false, { staticKey: key });
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  const pending = r.readMessage(m1.message);
  await assert.rejects(r.readMessage(m1.message), TypeError);
  fail();
  assert.deepEqual(await pending, { ok: false, reason: "dead" });
});

test("with payloads (the vectors' way): a message's length from its tokens up to 65,535 bytes, and a payload past that the caller's mistake", async () => {
  const at = (initiator: boolean) => core(IK, initiator, { payloads: true });
  {
    const i = at(true);
    const r = at(false);
    const m = await i.writeMessage(new Uint8Array(65_535 - 96));
    assert.ok(m.ok && m.message.length === 65_535);
    const got = await r.readMessage(m.message);
    assert.ok(got.ok && got.payload.length === 65_535 - 96);
  }
  {
    const i = at(true);
    const r = at(false);
    const m = await i.writeMessage();
    assert.ok(m.ok && m.message.length === 96);
    assert.ok((await r.readMessage(m.message)).ok, "an empty payload at exactly the tokens' length");
  }
  {
    const r = at(false);
    assert.deepEqual(await r.readMessage(new Uint8Array(65_536)), { ok: false, reason: "length" });
    assert.deepEqual(await at(false).readMessage(new Uint8Array(95)), { ok: false, reason: "length" });
  }
  {
    const i = at(true);
    await assert.rejects(i.writeMessage(new Uint8Array(65_535 - 95)), TypeError);
    assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dead" });
  }
  {
    const i = at(true);
    await assert.rejects(i.writeMessage("x" as unknown as Uint8Array), TypeError);
    assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dead" });
  }
});

test("the protocol names are under 64 bytes", () => {
  for (const p of [IK, XXPSK3]) assert.ok(new TextEncoder().encode(p.name).length < 64, p.name);
});

// --------------------------------------------- calls racing, through the public API

/** Two calls of a side without awaiting the first: the second throws, the first gives dead, never a transport. */
async function race(what: string, first: () => Promise<{ ok: boolean }>, second: () => Promise<unknown>): Promise<void> {
  const a = first();
  await assert.rejects(second(), TypeError, what);
  assert.deepEqual(await a, { ok: false, reason: "dead" }, what);
}

test("calls racing: the IK responder's write of message 2, the IK initiator's read of message 2", async () => {
  {
    const i = noise.ikInitiator({ staticKey: CLIENT, responderKey: COMPUTER.publicKey, accountId: ACCOUNT });
    const r = noise.ikResponder({ staticKey: COMPUTER, accountId: ACCOUNT });
    const m1 = await i.writeMessage();
    assert.ok(m1.ok);
    assert.ok((await r.readMessage(m1.message)).ok);
    await race("IK responder, write", () => r.writeMessage(), () => r.writeMessage());
    assert.deepEqual(await r.writeMessage(), { ok: false, reason: "dead" });
    assert.equal(r.remoteStatic, null);
  }
  {
    const i = noise.ikInitiator({ staticKey: CLIENT, responderKey: COMPUTER.publicKey, accountId: ACCOUNT });
    const r = noise.ikResponder({ staticKey: COMPUTER, accountId: ACCOUNT });
    const m1 = await i.writeMessage();
    assert.ok(m1.ok);
    assert.ok((await r.readMessage(m1.message)).ok);
    const m2 = await r.writeMessage();
    assert.ok(m2.ok);
    await race("IK initiator, read", () => i.readMessage(m2.message), () => i.readMessage(m2.message));
  }
});

test("calls racing: the XXpsk3 initiator's write of message 1 and read of message 2, the responder's read of message 3", async () => {
  {
    const i = noise.xxpsk3Initiator({ staticKey: CLIENT, prologue: PROLOGUE, psk: PSK });
    await race("XXpsk3 initiator, write 1", () => i.writeMessage(), () => i.writeMessage());
  }
  {
    const i = noise.xxpsk3Initiator({ staticKey: CLIENT, prologue: PROLOGUE, psk: PSK });
    const r = noise.xxpsk3Responder({ staticKey: COMPUTER, prologue: PROLOGUE, psk: PSK });
    const m1 = await i.writeMessage();
    assert.ok(m1.ok);
    assert.ok((await r.readMessage(m1.message)).ok);
    const m2 = await r.writeMessage();
    assert.ok(m2.ok);
    await race("XXpsk3 initiator, read 2", () => i.readMessage(m2.message), () => i.readMessage(m2.message));
  }
  {
    // Message 3 from an initiator holding another PSK: never accepted, raced or not.
    const i = noise.xxpsk3Initiator({ staticKey: CLIENT, prologue: PROLOGUE, psk: secret("another psk") });
    const r = noise.xxpsk3Responder({ staticKey: COMPUTER, prologue: PROLOGUE, psk: PSK });
    const m1 = await i.writeMessage();
    assert.ok(m1.ok);
    assert.ok((await r.readMessage(m1.message)).ok);
    const m2 = await r.writeMessage();
    assert.ok(m2.ok);
    assert.ok((await i.readMessage(m2.message)).ok);
    const m3 = await i.writeMessage();
    assert.ok(m3.ok);
    await race("XXpsk3 responder, read 3", () => r.readMessage(m3.message), () => r.readMessage(m3.message));
  }
});

test("a transport built by a call killed meanwhile is closed, its keys zeroed", async () => {
  const spy = Object.create(sodium) as typeof sodium;
  const built: Uint8Array[] = [];
  const i = core(IK, true);
  const r = new Handshake(spy, { pattern: IK, initiator: false, staticKey: COMPUTER, prologue: channelPrologue(ACCOUNT), payloads: false });
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  assert.ok((await r.readMessage(m1.message)).ok);
  // Every cipher key the transport takes is a slice of HKDF's output.
  const slice = Uint8Array.prototype.slice;
  Uint8Array.prototype.slice = function (this: Uint8Array, ...a: [number?, number?]) {
    const out = slice.apply(this, a);
    if (a[0] === 0 && a[1] === 32) built.push(out);
    return out;
  };
  try {
    const a = r.writeMessage();
    await assert.rejects(r.writeMessage(), TypeError);
    assert.deepEqual(await a, { ok: false, reason: "dead" });
  } finally {
    Uint8Array.prototype.slice = slice;
  }
  assert.ok(built.length >= 2);
  assert.ok(built.every(isZero), "every cipher key zeroed, the transport's among them");
});

test("the public transport: only its methods and getters, frozen, none of the core's state reachable", async () => {
  const i = noise.ikInitiator({ staticKey: CLIENT, responderKey: COMPUTER.publicKey, accountId: ACCOUNT });
  const r = noise.ikResponder({ staticKey: COMPUTER, accountId: ACCOUNT });
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  assert.ok((await r.readMessage(m1.message)).ok);
  const m2 = await r.writeMessage();
  assert.ok(m2.ok && m2.transport);
  const done = await i.readMessage(m2.message);
  assert.ok(done.ok && done.transport);
  for (const t of [m2.transport, done.transport]) {
    assert.deepEqual(Object.keys(t).sort(), ["close", "confirmed", "handshakeHash", "receive", "remoteStatic", "send"]);
    assert.ok(Object.isFrozen(t));
    assert.equal(Object.getPrototypeOf(t), Object.prototype);
    for (const k of ["sendCipher", "receiveCipher", "confirmed_", "dead", "gated", "remote", "hash"]) assert.ok(!(k in t), k);
    assert.throws(() => ((t as unknown as Record<string, unknown>).confirmed = true), TypeError);
    assert.throws(() => ((t as unknown as Record<string, unknown>).sendCipher = {}), TypeError);
  }
  const responder = m2.transport;
  assert.equal(responder.confirmed, false);
  assert.throws(() => responder.send(Uint8Array.of(1)), TypeError, "the gate holds through the facade");
  for (const h of [i, r]) {
    assert.ok(Object.isFrozen(h));
    assert.deepEqual(Object.keys(h).sort(), ["readMessage", "remoteStatic", "writeMessage"]);
  }
});

test("the public API carries no handshake payload: each message with an authentic payload of 1 byte fails with length", async () => {
  const craft = (pattern: Pattern, initiator: boolean) => core(pattern, initiator, { payloads: true });
  const x = Uint8Array.of(0x78);
  // IK message 1, to a public responder.
  {
    const m1 = await craft(IK, true).writeMessage(x);
    assert.ok(m1.ok && m1.message.length === 97);
    const r = noise.ikResponder({ staticKey: COMPUTER, accountId: ACCOUNT });
    assert.deepEqual(await r.readMessage(m1.message), { ok: false, reason: "length" });
    assert.deepEqual(await r.readMessage(m1.message.subarray(0, 96)), { ok: false, reason: "dead" });
  }
  // IK message 2, to a public initiator.
  {
    const i = noise.ikInitiator({ staticKey: CLIENT, responderKey: COMPUTER.publicKey, accountId: ACCOUNT });
    const c = craft(IK, false);
    const m1 = await i.writeMessage();
    assert.ok(m1.ok);
    assert.ok((await c.readMessage(m1.message)).ok);
    const m2 = await c.writeMessage(x);
    assert.ok(m2.ok && m2.message.length === 49);
    assert.deepEqual(await i.readMessage(m2.message), { ok: false, reason: "length" });
  }
  // XXpsk3 messages 1 and 3 to a public responder, 2 to a public initiator.
  {
    const m1 = await craft(XXPSK3, true).writeMessage(x);
    assert.ok(m1.ok && m1.message.length === 49);
    assert.deepEqual(await noise.xxpsk3Responder({ staticKey: COMPUTER, prologue: PROLOGUE, psk: PSK }).readMessage(m1.message), { ok: false, reason: "length" });
  }
  {
    const i = noise.xxpsk3Initiator({ staticKey: CLIENT, prologue: PROLOGUE, psk: PSK });
    const c = craft(XXPSK3, false);
    const m1 = await i.writeMessage();
    assert.ok(m1.ok);
    assert.ok((await c.readMessage(m1.message)).ok);
    const m2 = await c.writeMessage(x);
    assert.ok(m2.ok && m2.message.length === 97);
    assert.deepEqual(await i.readMessage(m2.message), { ok: false, reason: "length" });
  }
  {
    const r = noise.xxpsk3Responder({ staticKey: COMPUTER, prologue: PROLOGUE, psk: PSK });
    const c = craft(XXPSK3, true);
    const m1 = await c.writeMessage();
    assert.ok(m1.ok);
    assert.ok((await r.readMessage(m1.message)).ok);
    const m2 = await r.writeMessage();
    assert.ok(m2.ok);
    assert.ok((await c.readMessage(m2.message)).ok);
    const m3 = await c.writeMessage(x);
    assert.ok(m3.ok && m3.message.length === 65);
    assert.deepEqual(await r.readMessage(m3.message), { ok: false, reason: "length" });
  }
});

test("remoteStatic is null once a handshake or a transport is dead", async () => {
  // An XXpsk3 responder failing message 3 from an initiator with another PSK.
  const i = noise.xxpsk3Initiator({ staticKey: CLIENT, prologue: PROLOGUE, psk: secret("another psk") });
  const r = noise.xxpsk3Responder({ staticKey: COMPUTER, prologue: PROLOGUE, psk: PSK });
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  assert.ok((await r.readMessage(m1.message)).ok);
  const m2 = await r.writeMessage();
  assert.ok(m2.ok);
  assert.ok((await i.readMessage(m2.message)).ok);
  assert.deepEqual(i.remoteStatic, COMPUTER.publicKey);
  const m3 = await i.writeMessage();
  assert.ok(m3.ok && m3.transport);
  assert.deepEqual(await r.readMessage(m3.message), { ok: false, reason: "decrypt" });
  assert.equal(r.remoteStatic, null);
  // A transport: after a failure, and after close().
  const t = m3.transport;
  assert.deepEqual(t.remoteStatic, COMPUTER.publicKey);
  assert.deepEqual(t.receive(new Uint8Array(16)), { ok: false, reason: "decrypt" });
  assert.equal(t.remoteStatic, null);
  const [ti] = await pair(IK);
  ti.close();
  assert.equal(ti.remoteStatic, null);
});

test("a static key's DH output is zeroed on every path: used, too long, zeros, or arriving after the handshake died", async () => {
  const given: Uint8Array[] = [];
  const giving = (make: () => Uint8Array, gate?: Promise<void>): StaticKey => ({
    publicKey: CLIENT.publicKey,
    dh: async () => {
      if (gate) await gate;
      const o = make();
      given.push(o);
      return o;
    },
  });
  for (const make of [() => new Uint8Array(33).fill(7), () => new Uint8Array(31).fill(7)]) {
    const i = core(IK, true, { staticKey: giving(make) });
    assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dh" });
  }
  let release = () => {};
  const gate = new Promise<void>((res) => (release = res));
  const r = core(IK, false, { staticKey: giving(() => new Uint8Array(32).fill(7), gate) });
  const m1 = await core(IK, true).writeMessage();
  assert.ok(m1.ok);
  const a = r.readMessage(m1.message);
  await assert.rejects(r.readMessage(m1.message), TypeError);
  release();
  assert.deepEqual(await a, { ok: false, reason: "dead" });
  assert.equal(given.length, 3);
  assert.ok(given.every(isZero));
});

test("a message changed by its caller while the handshake waits is read as it was given", async () => {
  const slow = slowKey(COMPUTER);
  const r = core(IK, false, { staticKey: slow.key });
  const m1 = await core(IK, true).writeMessage();
  assert.ok(m1.ok);
  const buffer = m1.message.slice();
  const a = r.readMessage(buffer);
  await new Promise((res) => setTimeout(res, 0));
  buffer.fill(0);
  slow.release();
  assert.ok((await a).ok);
});

test("copies: a static key's secret and public key, the keys and hash a handshake and a transport give out", async () => {
  const s = secret("copied");
  const key = noise.staticKey(s);
  const peer = COMPUTER.publicKey;
  const before = await key.dh(peer);
  s.fill(0);
  assert.deepEqual(await key.dh(peer), before, "the caller's buffer zeroed changes nothing");
  key.publicKey.fill(0);
  assert.deepEqual(key.publicKey, sodium.crypto_scalarmult_base(secret("copied")));
  const i = core(IK, true);
  i.remoteStatic!.fill(0);
  assert.deepEqual(i.remoteStatic, COMPUTER.publicKey);
  const [ti] = await pair(IK, i);
  const hash = ti.handshakeHash.slice();
  ti.handshakeHash.fill(0);
  ti.remoteStatic!.fill(0);
  assert.deepEqual(ti.handshakeHash, hash);
  assert.deepEqual(ti.remoteStatic, COMPUTER.publicKey);
});

test("an ephemeral DH of zeros fails with dh, even from a library that gives them", async () => {
  const spy = Object.create(sodium) as typeof sodium;
  Object.assign(spy, { crypto_scalarmult: () => new Uint8Array(32) });
  const i = new Handshake(spy, { pattern: IK, initiator: true, staticKey: CLIENT, remoteStatic: COMPUTER.publicKey, prologue: PROLOGUE, payloads: false });
  assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dh" });
});

test("dispose() zeroes a libsodium static key's secret, and its DH then fails the handshake with dh", async () => {
  const s = secret("disposed");
  const key = noise.staticKey(s);
  const zeroed: string[] = [];
  const memzero = sodium.memzero;
  sodium.memzero = (b: Uint8Array) => {
    zeroed.push(toHex(b));
    memzero(b);
  };
  try {
    key.dispose();
  } finally {
    sodium.memzero = memzero;
  }
  assert.deepEqual(zeroed, [toHex(s)], "the secret's copy zeroed");
  await assert.rejects(key.dh(COMPUTER.publicKey));
  const i = noise.ikInitiator({ staticKey: key, responderKey: COMPUTER.publicKey, accountId: ACCOUNT });
  assert.deepEqual(await i.writeMessage(), { ok: false, reason: "dh" });
});

test("once(): one start for every call, and another after a failure", async () => {
  let starts = 0;
  const load2 = once(async () => {
    starts++;
    if (starts === 1) throw new Error("no start");
    return starts;
  });
  await assert.rejects(load2(), /no start/);
  assert.equal(await load2(), 2);
  assert.equal(await load2(), 2);
  assert.equal(starts, 2);
});

/** A copy of bytes as another realm's Uint8Array, as a frame or a worker gives. */
const otherRealm = (b: Uint8Array): Uint8Array => {
  const out = runInNewContext(`new Uint8Array(${b.length})`) as Uint8Array;
  out.set(b);
  return out;
};
/** A copy of bytes whose own slice() gives zeros. */
const badSlice = (b: Uint8Array): Uint8Array => {
  const out = b.slice();
  Object.defineProperty(out, "slice", { value: () => new Uint8Array(out.length) });
  return out;
};

test("another realm's arrays, or an overridden slice(), in every input: the handshake and transport work as with this realm's", async () => {
  for (const foreign of [otherRealm, badSlice]) {
    const key = (k: StaticKey): StaticKey => ({ publicKey: foreign(k.publicKey), dh: async (p) => foreign(await k.dh(p)) });
    const i = core(IK, true, { staticKey: key(CLIENT), remoteStatic: foreign(COMPUTER.publicKey), prologue: foreign(channelPrologue(ACCOUNT)) });
    const r = core(IK, false, { staticKey: key(COMPUTER), prologue: foreign(channelPrologue(ACCOUNT)) });
    const m1 = await i.writeMessage();
    assert.ok(m1.ok, foreign.name);
    assert.deepEqual(await r.readMessage(foreign(m1.message)), { ok: true, payload: new Uint8Array(0) }, foreign.name);
    const m2 = await r.writeMessage();
    assert.ok(m2.ok && m2.transport);
    const done = await i.readMessage(foreign(m2.message));
    assert.ok(done.ok && done.transport, foreign.name);
    const sent = done.transport.send(foreign(Uint8Array.of(1, 2, 3)));
    assert.ok(sent.ok);
    assert.deepEqual(m2.transport.receive(foreign(sent.message)), { ok: true, plaintext: Uint8Array.of(1, 2, 3) }, foreign.name);
    const x = core(XXPSK3, true, { psk: foreign(PSK), payloads: true });
    const w = await x.writeMessage(foreign(Uint8Array.of(9)));
    assert.ok(w.ok && w.message.length === 49, foreign.name);
    // The libsodium static key, from a secret of another realm.
    const sk = noise.staticKey(foreign(secret("client")));
    assert.deepEqual(sk.publicKey, CLIENT.publicKey, foreign.name);
  }
});

test("the core zeroes its own copy of a static key's DH output, used or refused", async () => {
  for (const [about, make, want] of [
    ["used", () => new Uint8Array(32).fill(7), "ok"],
    ["33 bytes", () => new Uint8Array(33).fill(7), "dh"],
  ] as const) {
    const zeroed: string[] = [];
    const spy = Object.create(sodium) as typeof sodium;
    Object.assign(spy, {
      memzero: (b: Uint8Array) => {
        zeroed.push(toHex(b));
        sodium.memzero(b);
      },
    });
    const key: StaticKey = { publicKey: CLIENT.publicKey, dh: async () => make() };
    const i = new Handshake(spy, { pattern: IK, initiator: true, staticKey: key, remoteStatic: COMPUTER.publicKey, prologue: PROLOGUE, payloads: false });
    const r = await i.writeMessage();
    assert.equal(r.ok ? "ok" : r.reason, want, about);
    assert.ok(zeroed.includes(toHex(make())), `${about}: the copy zeroed`);
  }
});

test("a static key's DH output of another realm is used, and that array zeroed", async () => {
  const given: Uint8Array[] = [];
  const key: StaticKey = { publicKey: CLIENT.publicKey, dh: async (p) => {
    const o = otherRealm(await CLIENT.dh(p));
    given.push(o);
    return o;
  } };
  const i = core(IK, true, { staticKey: key });
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  assert.ok((await core(IK, false).readMessage(m1.message)).ok, "the same message 1 as with this realm's array");
  assert.equal(given.length, 1);
  assert.ok(given[0].every((x) => x === 0));
});

test("the public readMessage result: ok and, after the last message, transport; no payload", async () => {
  const i = noise.ikInitiator({ staticKey: CLIENT, responderKey: COMPUTER.publicKey, accountId: ACCOUNT });
  const r = noise.ikResponder({ staticKey: COMPUTER, accountId: ACCOUNT });
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  assert.deepEqual(Object.keys(m1).sort(), ["message", "ok"]);
  const got1 = await r.readMessage(m1.message);
  assert.deepEqual(Object.keys(got1), ["ok"]);
  const m2 = await r.writeMessage();
  assert.ok(m2.ok);
  assert.deepEqual(Object.keys(m2).sort(), ["message", "ok", "transport"]);
  const got2 = await i.readMessage(m2.message);
  assert.deepEqual(Object.keys(got2).sort(), ["ok", "transport"]);
  assert.deepEqual(Object.keys(await noise.ikResponder({ staticKey: COMPUTER, accountId: ACCOUNT }).readMessage(new Uint8Array(1))).sort(), ["ok", "reason"]);
});

test("an ephemeral key on Object.prototype is never used: the public API makes its own", async () => {
  const pinned = secret("pinned ephemeral");
  const proto = Object.prototype as Record<string, unknown>;
  proto.ephemeral = pinned;
  try {
    const one = await noise.ikInitiator({ staticKey: CLIENT, responderKey: COMPUTER.publicKey, accountId: ACCOUNT }).writeMessage();
    const two = await noise.xxpsk3Initiator({ staticKey: CLIENT, prologue: PROLOGUE, psk: PSK }).writeMessage();
    assert.ok(one.ok && two.ok);
    const e = toHex(sodium.crypto_scalarmult_base(pinned));
    assert.notEqual(toHex(one.message.subarray(0, 32)), e);
    assert.notEqual(toHex(two.message.subarray(0, 32)), e);
  } finally {
    delete proto.ephemeral;
  }
});

test("the internal entry's party handshakes are the public API's prologue and lengths", async () => {
  const file = read<ChannelFile>("../../cases/e2e/channel.json");
  const c = file.cases.find((c) => c.check === "IK" && c.about.startsWith("IK: both messages"));
  assert.ok(c && c.check === "IK");
  const h = await partyHandshake(sodium, "IK", c.parties.initiator, libsodiumKeys);
  const w = await h.writeMessage();
  assert.ok(w.ok);
  assert.equal(toHex(w.message), (c.steps[0] as { bytes: string }).bytes);
});

test("Noise is given only after libsodium has started, the same each time", async () => {
  assert.equal(await load(), noise);
  assert.ok(Object.isFrozen(noise) && Object.isFrozen(IK) && Object.isFrozen(XXPSK3));
});
