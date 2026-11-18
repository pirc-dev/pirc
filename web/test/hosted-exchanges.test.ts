// cases/exchanges/hosted: each file is what hosted-exchange.ts builds from
// cases/e2e/objects.json, and playing its inputs gives its checks.
//
//   node --experimental-transform-types --no-warnings web/test/hosted-exchanges.test.ts --record
//
// writes the files again.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { build, run, type ExchangeFile } from "./hosted-exchange.ts";

const dir = new URL("../../cases/exchanges/hosted/", import.meta.url);

if (process.argv.includes("--record")) {
  mkdirSync(dir, { recursive: true });
  for (const [name, f] of Object.entries(await build())) writeFileSync(new URL(name, dir), JSON.stringify(f, null, 2) + "\n");
}

test("the files are what hosted-exchange.ts builds", async () => {
  const built = await build();
  assert.deepEqual(readdirSync(dir).sort(), Object.keys(built).sort());
  for (const [name, f] of Object.entries(built)) assert.deepEqual(JSON.parse(readFileSync(new URL(name, dir), "utf8")), JSON.parse(JSON.stringify(f)), name);
});

test("playing each file gives its checks", async () => {
  for (const name of readdirSync(dir)) {
    const f = JSON.parse(readFileSync(new URL(name, dir), "utf8")) as ExchangeFile;
    assert.deepEqual(JSON.parse(JSON.stringify(await run(f))), f.steps, name);
  }
});

test("the recorded envelope opens with the host's request key, and is the phone's request", async () => {
  const { unhex } = await import("@pirc/crypto/bytes");
  const hpke = await import("@pirc/crypto/hpke");
  const keys = await import("@pirc/crypto/keys");
  const { decode, open } = await import("@pirc/crypto/objects");
  const objects = JSON.parse(readFileSync(new URL("../../cases/e2e/objects.json", import.meta.url), "utf8"));
  const f = JSON.parse(readFileSync(new URL("sessions.json", dir), "utf8")) as ExchangeFile;
  const sent = f.steps.find((s) => "sent" in s && s.sent.length) as { sent: { routed: { payload: string } }[] };
  const rk = await hpke.x25519FromPrivate(unhex(objects.bundle.request_key_private));
  const plain = await keys.openEnvelope(rk, unhex(objects.account_id), unhex(objects.sending_keys.host_key), unhex(objects.sending_keys.key_id), Buffer.from(sent.sent[0].routed.payload, "base64"));
  assert.ok(plain);
  const env = await open("request", unhex(objects.account_id), decode(plain));
  assert.ok(env);
  assert.equal(Buffer.from(env.signer).toString("hex"), objects.devices.phone.public_key);
  assert.equal(env.counter, 1n);
  assert.equal(env.sentAt?.seconds, BigInt(Number(objects.now_ms) / 1000));
});
