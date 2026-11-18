// HKDF-SHA256 (RFC 5869) and HPKE's base mode with DHKEM(X25519,
// HKDF-SHA256), HKDF-SHA256 and AES-256-GCM (RFC 9180), single-shot, from
// WebCrypto's primitives, since neither Node nor browsers have HPKE.
// Held to the CFRG's vector in cases/e2e/hpke.json.

import { buf, concat, equal, utf8 } from "./bytes.ts";

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}

export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Promise<Uint8Array> => hmac(key, data);

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(data)));
}

export async function sha512(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-512", buf(data)));
}

export async function extract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmac(salt.length ? salt : new Uint8Array(32), ikm);
}

export async function expand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  if (length > 255 * 32) throw new RangeError("HKDF output too long");
  const out = new Uint8Array(length);
  let t: Uint8Array = new Uint8Array(0);
  for (let i = 1, n = 0; n < length; i++) {
    t = await hmac(prk, concat(t, info, Uint8Array.of(i)));
    out.set(t.subarray(0, Math.min(32, length - n)), n);
    n += 32;
  }
  return out;
}

export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  return expand(await extract(salt, ikm), info, length);
}

// --- AES-256-GCM ---

export async function aesSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", buf(key), "AES-GCM", false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(aad) }, k, buf(plaintext)));
}

/** Null when it does not open. */
export async function aesOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array | null> {
  const k = await crypto.subtle.importKey("raw", buf(key), "AES-GCM", false, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(aad) }, k, buf(ciphertext)));
  } catch {
    return null;
  }
}

// --- X25519 ---

// PKCS #8 for an X25519 private key (RFC 8410): this prefix, then the 32 bytes.
const X25519_PKCS8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

export type X25519Pair = { privateKey: CryptoKey; publicKey: Uint8Array };

export async function x25519Generate(extractable = false): Promise<X25519Pair> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, extractable, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** From 32 private bytes: the tests' fixed keys, and CPace's scalars. */
export async function x25519FromPrivate(sk: Uint8Array): Promise<X25519Pair> {
  const privateKey = await crypto.subtle.importKey("pkcs8", concat(X25519_PKCS8, sk) as Uint8Array<ArrayBuffer>, { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const publicKey = Uint8Array.from(atob(jwk.x!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return { privateKey, publicKey };
}

/** X25519(sk, pk) as the platform computes it: it may throw on a low-order point, or return zeros. */
export async function x25519Raw(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array> {
  const pk = await crypto.subtle.importKey("raw", buf(publicKey), { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pk }, privateKey, 256));
}

/** X25519(sk, pk), refusing an all-zero result on every platform. */
export async function x25519(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Uint8Array> {
  const out = await x25519Raw(privateKey, publicKey);
  if (equal(out, new Uint8Array(32))) throw new Error("X25519 gave the all-zero value");
  return out;
}

// --- HPKE (RFC 9180, sections 4, 5.1 and 7.1) ---

const KEM_SUITE = concat(utf8("KEM"), Uint8Array.of(0x00, 0x20));
const HPKE_SUITE = concat(utf8("HPKE"), Uint8Array.of(0x00, 0x20, 0x00, 0x01, 0x00, 0x02));
const V1 = utf8("HPKE-v1");

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(salt, concat(V1, suite, utf8(label), ikm));

const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number) =>
  expand(prk, concat(Uint8Array.of(length >> 8, length & 0xff), V1, suite, utf8(label), info), length);

async function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Promise<Uint8Array> {
  const prk = await labeledExtract(KEM_SUITE, new Uint8Array(0), "eae_prk", dh);
  return labeledExpand(KEM_SUITE, prk, "shared_secret", kemContext, 32);
}

async function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): Promise<{ key: Uint8Array; baseNonce: Uint8Array }> {
  const empty = new Uint8Array(0);
  const pskIdHash = await labeledExtract(HPKE_SUITE, empty, "psk_id_hash", empty);
  const infoHash = await labeledExtract(HPKE_SUITE, empty, "info_hash", info);
  const context = concat(Uint8Array.of(0x00), pskIdHash, infoHash);
  const secret = await labeledExtract(HPKE_SUITE, sharedSecret, "secret", empty);
  return {
    key: await labeledExpand(HPKE_SUITE, secret, "key", context, 32),
    baseNonce: await labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12),
  };
}

/** enc (32 bytes) followed by the ciphertext. `ephemeral` only for test vectors. */
export async function seal(recipient: Uint8Array, info: Uint8Array, aad: Uint8Array, plaintext: Uint8Array, ephemeral?: X25519Pair): Promise<Uint8Array> {
  const e = ephemeral ?? (await x25519Generate());
  const dh = await x25519(e.privateKey, recipient);
  const shared = await extractAndExpand(dh, concat(e.publicKey, recipient));
  const { key, baseNonce } = await keySchedule(shared, info);
  return concat(e.publicKey, await aesSeal(key, baseNonce, aad, plaintext));
}

/** Null when it does not open. */
export async function open(recipient: X25519Pair, info: Uint8Array, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array | null> {
  if (sealed.length < 32 + 16) return null;
  const enc = sealed.subarray(0, 32);
  let dh: Uint8Array;
  try {
    dh = await x25519(recipient.privateKey, enc);
  } catch {
    return null;
  }
  const shared = await extractAndExpand(dh, concat(enc, recipient.publicKey));
  const { key, baseNonce } = await keySchedule(shared, info);
  return aesOpen(key, baseNonce, aad, sealed.subarray(32));
}

/** The key schedule's outputs, for the test vector. */
export async function testSchedule(dh: Uint8Array, enc: Uint8Array, pkR: Uint8Array, info: Uint8Array) {
  const sharedSecret = await extractAndExpand(dh, concat(enc, pkR));
  return { sharedSecret, ...(await keySchedule(sharedSecret, info)) };
}
