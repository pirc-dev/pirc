// The WebCrypto static key under Node's WebCrypto: libsodium's bytes on the
// published vectors and on every case of channel.json, dh for every
// low-order key, and libsodium's bytes or dh for a non-canonical one
// (webcrypto.ts, which browsers run too).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import sodium from "libsodium-wrappers-sumo";

import { load, webCryptoStaticKey } from "../noise.ts";
import { type ChannelFile, type VectorFile } from "./channel.ts";
import { checkWebCrypto, LOW_ORDER } from "./webcrypto.ts";

await sodium.ready;
const noise = await load();
const read = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as T;

test("WebCrypto static keys: the vectors, channel.json, low-order and non-canonical keys", async (t) => {
  const channel = read<ChannelFile>("../../cases/e2e/channel.json");
  const vectors = ["cacophony", "snow"].map((f) => read<VectorFile>(`../../cases/noise/${f}.json`));
  const report = await checkWebCrypto(sodium, globalThis.crypto.subtle, channel, vectors);
  assert.deepEqual(report.problems, []);
  assert.equal(report.vectors, vectors.reduce((n, f) => n + f.vectors.length, 0));
  assert.equal(report.cases, channel.cases.length);
  assert.equal(report.lowOrder.length, 14);
  assert.equal(new Set(LOW_ORDER.map(([, k]) => k)).size, 14);
  for (const x of report.lowOrder) t.diagnostic(`low-order ${x.name}: ${x.treatment}`);
  for (const x of report.nonCanonical) t.diagnostic(`non-canonical ${x.name}: ${x.treatment}, ${x.outcome}`);
});

test("a WebCrypto key pair made by the engine, its private key not extractable, through the public API", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  assert.equal(pair.privateKey.extractable, false);
  const client = await webCryptoStaticKey(pair);
  const computer = noise.staticKey(sodium.randombytes_buf(32));
  const accountId = sodium.randombytes_buf(32);
  const i = noise.ikInitiator({ staticKey: client, responderKey: computer.publicKey, accountId });
  const r = noise.ikResponder({ staticKey: computer, accountId });
  const m1 = await i.writeMessage();
  assert.ok(m1.ok);
  assert.ok((await r.readMessage(m1.message)).ok);
  assert.deepEqual(r.remoteStatic, client.publicKey);
  const m2 = await r.writeMessage();
  assert.ok(m2.ok && m2.transport);
  const done = await i.readMessage(m2.message);
  assert.ok(done.ok && done.transport);
  const sent = done.transport.send(Uint8Array.of(1, 2, 3));
  assert.ok(sent.ok);
  assert.deepEqual(m2.transport.receive(sent.message), { ok: true, plaintext: Uint8Array.of(1, 2, 3) });
});

test("a WebCrypto key: frozen, its public key a copy each time", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const key = await webCryptoStaticKey(pair);
  assert.ok(Object.isFrozen(key));
  assert.throws(() => ((key as unknown as Record<string, unknown>).dh = async () => new Uint8Array(32)), TypeError);
  const first = key.publicKey;
  key.publicKey.fill(0);
  assert.deepEqual(key.publicKey, first);
  assert.deepEqual(key.publicKey, new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
});

test("a WebCrypto key whose public key is not 32 bytes is refused", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const subtle = { exportKey: async () => new ArrayBuffer(31) } as unknown as SubtleCrypto;
  await assert.rejects(webCryptoStaticKey(pair, subtle), TypeError);
});

test("an engine's result of zeros, or not 32 bytes, makes dh() reject", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  for (const bits of [new ArrayBuffer(32), new ArrayBuffer(31), new Uint8Array(33).fill(1).buffer]) {
    const subtle = {
      exportKey: (f: "raw", k: CryptoKey) => crypto.subtle.exportKey(f, k),
      importKey: async () => pair.publicKey,
      deriveBits: async () => bits,
    } as unknown as SubtleCrypto;
    const key = await webCryptoStaticKey(pair, subtle);
    await assert.rejects(key.dh(new Uint8Array(32).fill(9)), Error, `${bits.byteLength} bytes`);
  }
  const subtle = { exportKey: (f: "raw", k: CryptoKey) => crypto.subtle.exportKey(f, k), importKey: async () => pair.publicKey, deriveBits: async () => new Uint8Array(32).fill(1).buffer } as unknown as SubtleCrypto;
  const key = await webCryptoStaticKey(pair, subtle);
  assert.deepEqual(await key.dh(new Uint8Array(32).fill(9)), new Uint8Array(32).fill(1));
});
