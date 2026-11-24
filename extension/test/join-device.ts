// A new device joining, for the app's tests (app/test/hosted_join_test.dart):
// a computer as `/pirc join` makes it, or a browser with its keys in
// WebCrypto, against the relay at the origin given. It prints the code's
// text on one line, then, once the join ends, "joined <account ID in hex>
// <counter> <the phone's name>" or "failed: <why>".
//
//   node --experimental-transform-types --no-warnings extension/test/join-device.ts <origin> computer|browser
import { randomBytes } from "node:crypto";

import { load as loadE2e, ROLE_CLIENT, type DeviceKeys } from "@pirc/e2e";
import { load as loadNoise, webCryptoStaticKey } from "@pirc/e2e/noise";
import { wsSocket } from "@pirc/relay-client/hosted-ws";
import { DeviceJoin } from "@pirc/relay-client/join";

import { ComputerJoin } from "../src/join.ts";

const [origin, role] = process.argv.slice(2);
const e2e = await loadE2e();
const noise = await loadNoise();
const random = (n: number) => new Uint8Array(randomBytes(n));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let join: { text: string; start(): Promise<{ accountId: Uint8Array; counter: bigint; phoneName: string }> };
if (role === "computer") {
  const j = new ComputerJoin({ origin, e2e, noise, open: wsSocket, random, log: () => {} });
  join = { text: j.text, start: async () => {
    const r = await j.start();
    return { accountId: r.info.accountId, counter: r.lists[1].counter, phoneName: r.phoneName };
  } };
} else {
  const subtle = globalThis.crypto.subtle;
  const signing = (await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const channel = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const staticKey = await webCryptoStaticKey(channel);
  const self: DeviceKeys = {
    role: ROLE_CLIENT,
    signingKey: new Uint8Array(await subtle.exportKey("raw", signing.publicKey)),
    channelKey: staticKey.publicKey,
    boxKey: random(32),
    readOnlyKey: new Uint8Array(0),
    notificationKey: new Uint8Array(0),
  };
  const j = new DeviceJoin({ origin, e2e, noise, open: wsSocket, random, log: () => {}, self, staticKey, sign: async (m) => new Uint8Array(await subtle.sign("Ed25519", signing.privateKey, m as Uint8Array<ArrayBuffer>)) });
  join = { text: j.text, start: async () => {
    const r = await j.start();
    return { accountId: r.accountId, counter: r.lists[1].counter, phoneName: r.phoneName };
  } };
}
process.stdout.write(`${join.text}\n`);
try {
  const r = await join.start();
  process.stdout.write(`joined ${hex(r.accountId)} ${r.counter} ${r.phoneName}\n`);
} catch (e) {
  process.stdout.write(`failed: ${(e as Error).message}\n`);
}
process.exit(0);
