// The new device's side of a join (relay-client/join.ts) for a client: a
// browser, its keys in WebCrypto, joined by the test phone (join-phone.ts)
// over the Go relay; and each role refused where the list holds the other.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { ROLE_CLIENT, ROLE_COMPUTER, type DeviceKeys } from "@pirc/e2e";
import { webCryptoStaticKey } from "@pirc/e2e/noise";
import { wsSocket } from "@pirc/relay-client/hosted-ws";
import { DeviceJoin } from "@pirc/relay-client/join";

import { device as keysOf } from "../../e2e/test/make.ts";
import { accountId, phone, version } from "./account-fixture.ts";
import { computerJoin, e2e, nextCounter, noise, phoneJoins, relay, running } from "./join-phone.ts";

// A browser's keys as a page holds them: signing and channel keys in
// WebCrypto, their private halves not exportable.
async function browserJoin() {
  const subtle = globalThis.crypto.subtle;
  const signing = (await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const channel = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const staticKey = await webCryptoStaticKey(channel);
  const self: DeviceKeys = {
    role: ROLE_CLIENT,
    signingKey: new Uint8Array(await subtle.exportKey("raw", signing.publicKey)),
    channelKey: staticKey.publicKey,
    boxKey: keysOf("browser", ROLE_CLIENT, false).boxKey,
    readOnlyKey: new Uint8Array(0),
    notificationKey: new Uint8Array(0),
  };
  const sign = async (m: Uint8Array) => new Uint8Array(await subtle.sign("Ed25519", signing.privateKey, m as Uint8Array<ArrayBuffer>));
  const j = new DeviceJoin({ origin: relay.origin, e2e, noise, open: wsSocket, random: (n) => new Uint8Array(randomBytes(n)), log: () => {}, self, staticKey, sign });
  running.push({ stop: () => j.cancel() });
  return { j, self };
}

test("a browser joins as a client: its keys in WebCrypto, the list holding it as a client", async () => {
  const { j, self } = await browserJoin();
  const done = j.start();
  const offered = await phoneJoins(j.text, { role: ROLE_CLIENT, list: (c) => version(nextCounter(), [phone, c]) });
  assert.deepEqual(offered, self);
  const joined = await done;
  assert.deepEqual(joined.accountId, accountId);
  assert.deepEqual(joined.phoneKey, phone.signingKey);
  assert.equal(joined.phoneName, "Pixel 9");
});

test("refused: a browser listed as a computer, a computer listed as a client", async () => {
  const b = await browserJoin();
  const done = b.j.start().then(
    () => assert.fail("the browser joined as a computer"),
    (e: Error) => assert.match(e.message, /refused \(self\)/),
  );
  await phoneJoins(b.j.text, { role: ROLE_CLIENT, publish: false, list: (c) => version(nextCounter(), [phone, { ...c, role: ROLE_COMPUTER }]) });
  await done;

  const cj = computerJoin();
  const settled = cj.start().then(
    () => assert.fail("the computer joined as a client"),
    (e: Error) => assert.match(e.message, /refused \(self\)/),
  );
  await phoneJoins(cj.text, { publish: false, list: (c) => version(nextCounter(), [phone, { ...c, role: ROLE_CLIENT }]) });
  await settled;
});
