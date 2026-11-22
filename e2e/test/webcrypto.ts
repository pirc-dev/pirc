// The WebCrypto static key (noise-webcrypto.ts) against libsodium's bytes:
// the published vectors and every case of channel.json with each party's
// static key in WebCrypto, the low-order keys, and non-canonical keys. It
// uses nothing of Node's: noise-webcrypto.test.ts runs it under Node's
// WebCrypto, and the same code runs in browsers.
import type sodiumType from "libsodium-wrappers-sumo";

import { Handshake, IK } from "../noise-core.ts";
import { webCryptoStaticKey } from "../noise-webcrypto.ts";
import { fromHex, runChannel, runVector, toHex, type ChannelFile, type KeyMaker, type VectorFile } from "./channel.ts";

type Sodium = typeof sodiumType;

/** PKCS #8 for an X25519 private key, before its 32 bytes (RFC 8410). */
const PKCS8_PREFIX = fromHex("302e020100300506032b656e04220420");

/** Static keys in WebCrypto, from fixed secret keys: the private key imported, not extractable. */
export function webCryptoKeys(sodium: Sodium, subtle: SubtleCrypto): KeyMaker {
  return async (secret) => {
    const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
    pkcs8.set(PKCS8_PREFIX);
    pkcs8.set(secret, PKCS8_PREFIX.length);
    const privateKey = await subtle.importKey("pkcs8", pkcs8 as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, ["deriveBits"]);
    const publicKey = await subtle.importKey("raw", sodium.crypto_scalarmult_base(secret) as Uint8Array<ArrayBuffer>, { name: "X25519" }, true, []);
    return webCryptoStaticKey({ privateKey, publicKey }, subtle);
  };
}

/** The seven low-order encodings, then the same with the top bit set. */
export const LOW_ORDER: [string, string][] = [
  ["u = 0", "0000000000000000000000000000000000000000000000000000000000000000"],
  ["u = 1", "0100000000000000000000000000000000000000000000000000000000000000"],
  ["order 8 (e0eb...)", "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"],
  ["order 8 (5f9c...)", "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"],
  ["u = p - 1", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
  ["u = p", "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
  ["u = p + 1", "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"],
];
for (const [name, k] of [...LOW_ORDER]) LOW_ORDER.push([`${name}, top bit set`, k.slice(0, 62) + (parseInt(k.slice(62), 16) | 0x80).toString(16)]);

/** What an engine did with a peer key. */
export type Treatment = "derived" | "zeros" | "import refused" | "derive refused";

export interface WebCryptoReport {
  /** Every difference from libsodium or from the files; none to pass. */
  problems: string[];
  vectors: number;
  cases: number;
  lowOrder: { name: string; treatment: Treatment }[];
  nonCanonical: { name: string; treatment: Treatment; outcome: "libsodium's bytes" | "dh" | "other" }[];
}

async function treat(subtle: SubtleCrypto, privateKey: CryptoKey, peer: Uint8Array): Promise<{ treatment: Treatment; bits?: Uint8Array }> {
  let key: CryptoKey;
  try {
    key = await subtle.importKey("raw", peer as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, []);
  } catch {
    return { treatment: "import refused" };
  }
  let bits: Uint8Array;
  try {
    bits = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: key }, privateKey, 256));
  } catch {
    return { treatment: "derive refused" };
  }
  return bits.every((b) => b === 0) ? { treatment: "zeros" } : { treatment: "derived", bits };
}

export async function checkWebCrypto(sodium: Sodium, subtle: SubtleCrypto, channel: ChannelFile, vectorFiles: VectorFile[]): Promise<WebCryptoReport> {
  const keyOf = webCryptoKeys(sodium, subtle);
  const report: WebCryptoReport = { problems: [], vectors: 0, cases: 0, lowOrder: [], nonCanonical: [] };
  for (const f of vectorFiles) {
    for (const v of f.vectors) {
      report.problems.push(...(await runVector(sodium, v, keyOf)));
      report.vectors++;
    }
  }
  for (const c of channel.cases) {
    report.problems.push(...(await runChannel(sodium, c, keyOf)));
    report.cases++;
  }

  const secret = fromHex("a8abababababababababababababababababababababababababababababab6b");
  const pkcs8 = new Uint8Array([...PKCS8_PREFIX, ...secret]);
  const privateKey = await subtle.importKey("pkcs8", pkcs8 as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, ["deriveBits"]);
  const key = await keyOf(secret);
  const dhFails = async (peer: Uint8Array) => {
    try {
      await key.dh(peer);
      return false;
    } catch {
      return true;
    }
  };
  for (const [name, k] of LOW_ORDER) {
    const peer = fromHex(k);
    const { treatment } = await treat(subtle, privateKey, peer);
    report.lowOrder.push({ name, treatment });
    if (treatment === "derived") report.problems.push(`low-order ${name}: the engine derived nonzero bits`);
    if (!(await dhFails(peer))) report.problems.push(`low-order ${name}: dh() did not reject`);
    // Through the core: an IK responder whose static key meets it first, at es.
    const responder = new Handshake(sodium, { pattern: IK, initiator: false, staticKey: key, prologue: new Uint8Array(0), payloads: false });
    const m1 = new Uint8Array(96);
    m1.set(peer);
    const r = await responder.readMessage(m1);
    if (r.ok || r.reason !== "dh") report.problems.push(`low-order ${name}: the handshake gave ${r.ok ? "ok" : r.reason}, not dh`);
  }

  // Non-canonical: the top bit of an honest key set, and u at or above p.
  const honest = sodium.crypto_scalarmult_base(fromHex("0900000000000000000000000000000000000000000000000000000000000077"));
  const top = honest.slice();
  top[31] |= 0x80;
  const nonCanonical: [string, Uint8Array][] = [
    ["an honest key with the top bit set", top],
    ["u = p + 9 (the base point, unreduced)", fromHex("f6ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")],
    ["u = 2^255 - 1 (p + 18)", fromHex("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")],
    ["u = 2^256 - 1 (p + 18, the top bit set)", fromHex("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
    ["u = p + 9, the top bit set", fromHex("f6ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")],
  ];
  for (const [name, peer] of nonCanonical) {
    const want = sodium.crypto_scalarmult(secret, peer);
    const { treatment, bits } = await treat(subtle, privateKey, peer);
    const outcome = treatment === "derived" ? (toHex(bits!) === toHex(want) ? "libsodium's bytes" : "other") : "dh";
    report.nonCanonical.push({ name, treatment, outcome });
    if (outcome === "other") report.problems.push(`non-canonical ${name}: the engine derived other bytes than libsodium`);
    let got: string;
    try {
      got = toHex(await key.dh(peer));
    } catch {
      got = "dh";
    }
    if (got !== (outcome === "dh" ? "dh" : toHex(want))) report.problems.push(`non-canonical ${name}: dh() gave ${got}`);
  }
  return report;
}
