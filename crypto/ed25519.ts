// Ed25519, verified strictly and alike on every platform (docs/e2e.md,
// section 2): byte checks first, then WebCrypto's verify, which computes
// the cofactorless equation. The checks are the same in Go
// (relay/internal/e2e), Dart (app/lib/e2e) and Swift (PircNotices), and
// cases/e2e/ed25519.json holds what all of them must decide.

import { buf, equal, unhex } from "./bytes.ts";

// The group order L and the field prime p, little-endian.
const L = unhex("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");
const P = unhex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f");

// Every encoding of a small-order point once y < p is checked: the eight
// canonical ones, and the two with x = 0 and the sign bit set.
const SMALL_ORDER = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  "0100000000000000000000000000000000000000000000000000000000000080",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
].map(unhex);

function lessLE(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 31; i >= 0; i--) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function pointOK(b: Uint8Array): boolean {
  const y = Uint8Array.from(b);
  y[31] &= 0x7f;
  return lessLE(y, P) && !SMALL_ORDER.some((s) => equal(b, s));
}

/** Null if the signature may go to the platform's verify, or why not. */
export function precheck(publicKey: Uint8Array, signature: Uint8Array): string | null {
  if (publicKey.length !== 32 || signature.length !== 64) return "length";
  if (!lessLE(signature.subarray(32), L)) return "S is not below L";
  if (!pointOK(publicKey)) return "the key is non-canonical or of small order";
  if (!pointOK(signature.subarray(0, 32))) return "R is non-canonical or of small order";
  return null;
}

export async function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (precheck(publicKey, signature)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", buf(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, buf(signature), buf(message));
  } catch {
    return false;
  }
}

/** A signing key: the browser's is non-extractable; Node's may come from a seed. */
export type Signer = { publicKey: Uint8Array; sign(message: Uint8Array): Promise<Uint8Array> };

export function signer(privateKey: CryptoKey, publicKey: Uint8Array): Signer {
  return {
    publicKey,
    sign: async (m) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, buf(m))),
  };
}

export async function generate(extractable = false): Promise<Signer & { privateKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, extractable, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { ...signer(pair.privateKey, publicKey), privateKey: pair.privateKey };
}

// PKCS #8 for an Ed25519 seed (RFC 8410): this prefix, then the 32 bytes.
const PKCS8_PREFIX = unhex("302e020100300506032b657004220420");

/** From a 32-byte seed, as the extension's key file and the tests keep it. */
export async function fromSeed(seed: Uint8Array): Promise<Signer> {
  if (seed.length !== 32) throw new RangeError("an Ed25519 seed is 32 bytes");
  const pkcs8 = new Uint8Array([...PKCS8_PREFIX, ...seed]);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = Uint8Array.from(atob(jwk.x!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return signer(privateKey, publicKey);
}
