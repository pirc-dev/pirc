// The primitives against cases/e2e's vectors: Ed25519 as every verifier
// must decide it, the CFRG's HPKE vector, and CPace's draft-21 vectors.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hex, unhex } from "../bytes.ts";
import * as cp from "../cpace.ts";
import * as ed25519 from "../ed25519.ts";
import * as hpke from "../hpke.ts";
import { env } from "../join.ts";

const cases = (name: string) => JSON.parse(readFileSync(new URL(`../../cases/e2e/${name}`, import.meta.url), "utf8"));

test("Ed25519: every vector decided as the rule says", async () => {
  for (const v of cases("ed25519.json").vectors) {
    const got = await ed25519.verify(unhex(v.public_key), unhex(v.message), unhex(v.signature));
    assert.equal(got, v.valid, v.name);
  }
});

test("Ed25519: a key from its seed signs what verifies", async () => {
  const s = await ed25519.fromSeed(new Uint8Array(32).fill(7));
  const m = new TextEncoder().encode("m");
  assert.ok(await ed25519.verify(s.publicKey, m, await s.sign(m)));
});

test("HPKE: the CFRG's vector, schedule and single-shot seal", async () => {
  const v = cases("hpke.json").vector;
  const e = await hpke.x25519FromPrivate(unhex(v.skEm));
  const r = await hpke.x25519FromPrivate(unhex(v.skRm));
  assert.equal(hex(e.publicKey), v.pkEm);
  assert.equal(hex(r.publicKey), v.pkRm);
  const dh = await hpke.x25519(e.privateKey, r.publicKey);
  const s = await hpke.testSchedule(dh, e.publicKey, r.publicKey, unhex(v.info));
  assert.equal(hex(s.sharedSecret), v.shared_secret);
  assert.equal(hex(s.key), v.key);
  assert.equal(hex(s.baseNonce), v.base_nonce);
  const first = v.encryptions[0];
  const sealed = await hpke.seal(r.publicKey, unhex(v.info), unhex(first.aad), unhex(first.pt), e);
  assert.equal(hex(sealed), v.enc + first.ct);
  const opened = await hpke.open(r, unhex(v.info), unhex(first.aad), sealed);
  assert.equal(hex(opened!), first.pt);
  assert.equal(await hpke.open(r, unhex(v.info), unhex("00"), sealed), null);
});

test("CPace: draft 21's generator and exchange", async () => {
  const c = cases("cpace.json");
  const g = c.calculate_generator;
  const gen = await cp.calculateGenerator(env, unhex(g.PRS), unhex(g.CI), unhex(g.sid));
  assert.equal(hex(gen.g), g["generator g"]);
  const x = c.exchange;
  const a = await cp.start(env, { prs: unhex(x.PRS), ci: unhex(x.CI), sid: unhex(x.sid), ad: unhex(x.ADa), y: unhex(x.ya) });
  const b = await cp.start(env, { prs: unhex(x.PRS), ci: unhex(x.CI), sid: unhex(x.sid), ad: unhex(x.ADb), y: unhex(x.yb) });
  assert.equal(hex(a.Y), x.Ya);
  assert.equal(hex(b.Y), x.Yb);
  const ia = await cp.finish(env, a, "initiator", b.Y, b.ad);
  const ib = await cp.finish(env, b, "responder", a.Y, a.ad);
  assert.equal(hex(ia.isk), x.ISK_IR);
  assert.equal(hex(ib.isk), x.ISK_IR);
});

test("CPace: every low-order point ends the exchange; the others give draft 21's K", async () => {
  const c = cases("cpace.json").scalar_mult_vfy_low_order;
  const y = unhex(c.s);
  for (const [name, u] of Object.entries(c) as [string, string][]) {
    if (!name.startsWith("Invalid Y")) continue;
    if (c.must_abort.includes(name)) await assert.rejects(cp.scalarMultVfy(env, y, unhex(u)), cp.CPaceAbort, name);
    else assert.equal(hex(await cp.scalarMultVfy(env, y, unhex(u))), c.q[name], name);
  }
});
