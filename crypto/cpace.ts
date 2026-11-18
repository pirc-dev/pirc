// CPACE-X25519-SHA512 as in draft-irtf-cfrg-cpace-21, sections 6-8 and
// appendix A. The X25519 and SHA-512 functions are passed in (join.ts's
// env, on WebCrypto), so the same code runs in Node and in browsers. Not constant time: the map
// to the curve uses BigInt.
//
// Only erasable TypeScript syntax, so Node and Node's stripTypeScriptTypes
// run it as is.

/** X25519(scalar, u) per RFC 7748. May throw where the platform refuses. */
export type X25519 = (scalar: Uint8Array, u: Uint8Array) => Promise<Uint8Array>;
export type Sha512 = (data: Uint8Array) => Promise<Uint8Array>;
export type Env = { x25519: X25519; sha512: Sha512; random: (n: number) => Uint8Array };

export const DSI = utf8("CPace255");
const S_IN_BYTES = 128; // SHA-512's input block size
const FIELD_BYTES = 32;
const P = (1n << 255n) - 19n;
const A = 486662n;
const Z = 2n; // RFC 9380's non-square for curve25519
export const IDENTITY = new Uint8Array(32); // G_X25519.I

/** The protocol was aborted: K was the identity, or the platform refused the point. */
export class CPaceAbort extends Error {
  readonly platformError: unknown;
  constructor(message: string, platformError?: unknown) {
    super(message);
    this.name = "CPaceAbort";
    this.platformError = platformError;
  }
}

// --- strings (section 6.3, appendix A.1-A.3) ---

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

function leb128(n: number): Uint8Array {
  const out: number[] = [];
  do {
    out.push(n < 128 ? n : (n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  } while (n > 0);
  return Uint8Array.from(out);
}

export function prependLen(data: Uint8Array): Uint8Array {
  return concat(leb128(data.length), data);
}

export function lvCat(...args: Uint8Array[]): Uint8Array {
  return concat(...args.map(prependLen));
}

function lexLarger(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return a.length > b.length;
}

export function oCat(a: Uint8Array, b: Uint8Array): Uint8Array {
  return lexLarger(a, b) ? concat(utf8("oc"), a, b) : concat(utf8("oc"), b, a);
}

export function transcriptIr(ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array {
  return concat(lvCat(ya, ada), lvCat(yb, adb));
}

export function transcriptOc(ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Uint8Array {
  return oCat(lvCat(ya, ada), lvCat(yb, adb));
}

export function generatorString(dsi: Uint8Array, prs: Uint8Array, ci: Uint8Array, sid: Uint8Array, sInBytes: number): Uint8Array {
  const zpad = Math.max(0, sInBytes - 1 - prependLen(prs).length - prependLen(dsi).length);
  return lvCat(dsi, prs, new Uint8Array(zpad), ci, sid);
}

// --- field and Elligator2 (RFC 9380 6.7.1, J = A, K = 1) ---

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function pow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = mod(b);
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
}

const inv0 = (x: bigint) => pow(x, P - 2n); // 0 for 0, as RFC 9380 wants
const isSquare = (x: bigint) => pow(x, (P - 1n) / 2n) !== P - 1n;

/** decodeUCoordinate of RFC 7748 for 255 bits: little endian, bit 255 masked, mod p. */
export function decodeU(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(i === 31 ? b[i] & 0x7f : b[i]);
  return mod(n);
}

export function encodeU(u: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0, n = mod(u); i < 32; i++, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

/** map_to_curve_elligator2 for curve25519; returns the u coordinate. */
export function elligator2(r: bigint): bigint {
  let x1 = mod(-A * inv0(1n + Z * r * r));
  if (x1 === 0n) x1 = mod(-A);
  const gx1 = mod(x1 * x1 * x1 + A * x1 * x1 + x1);
  return isSquare(gx1) ? x1 : mod(-x1 - A);
}

// --- CPace (sections 7.2 and 8.2) ---

export async function calculateGenerator(env: Env, prs: Uint8Array, ci: Uint8Array, sid: Uint8Array) {
  const genStr = generatorString(DSI, prs, ci, sid, S_IN_BYTES);
  const hash = (await env.sha512(genStr)).slice(0, FIELD_BYTES);
  const u = decodeU(hash);
  return { genStr, hash, u: encodeU(u), g: encodeU(elligator2(u)) };
}

function isIdentity(k: Uint8Array): boolean {
  return k.length === 32 && k.every((x) => x === 0);
}

/**
 * G_X25519.scalar_mult_vfy, with the abort folded in: returns K, or throws
 * CPaceAbort when K is the identity. Platforms that refuse low-order input
 * (an error, not zeros) abort here too; the all-zero check below is what
 * catches it on platforms that return zeros.
 *
 * The peer's u is passed on in canonical form (bit 255 cleared, reduced mod
 * p), which is what RFC 7748's X25519 computes on anyway: Firefox refuses at
 * importKey twelve exact encodings, five of which X25519 maps to ordinary
 * points (draft B.1.10 u6, u8, u9, ua, ub). The transcript keeps the bytes
 * as received.
 */
export async function scalarMultVfy(env: Env, y: Uint8Array, g: Uint8Array, canonical = true): Promise<Uint8Array> {
  let k: Uint8Array;
  try {
    k = await env.x25519(y, canonical ? encodeU(decodeU(g)) : g);
  } catch (e) {
    throw new CPaceAbort("X25519 refused the peer's point", e);
  }
  if (isIdentity(k)) throw new CPaceAbort("K is the identity");
  return k;
}

export type Party = { y: Uint8Array; Y: Uint8Array; ad: Uint8Array; sid: Uint8Array };

/** One side's message: Y = X25519(y, g). y is random unless given (test vectors). */
export async function start(env: Env, o: { prs: Uint8Array; ci: Uint8Array; sid: Uint8Array; ad: Uint8Array; y?: Uint8Array }): Promise<Party> {
  const { g } = await calculateGenerator(env, o.prs, o.ci, o.sid);
  const y = o.y ?? env.random(FIELD_BYTES); // G_X25519.sample_scalar
  return { y, Y: await env.x25519(y, g), ad: o.ad, sid: o.sid };
}

/** ISK for the initiator/responder setting (transcript_ir). */
export async function finish(env: Env, me: Party, role: "initiator" | "responder", Yother: Uint8Array, adOther: Uint8Array): Promise<{ K: Uint8Array; isk: Uint8Array; sidOutput: Uint8Array }> {
  const k = await scalarMultVfy(env, me.y, Yother);
  const t = role === "initiator" ? transcriptIr(me.Y, me.ad, Yother, adOther) : transcriptIr(Yother, adOther, me.Y, me.ad);
  const isk = await env.sha512(concat(lvCat(concat(DSI, utf8("_ISK")), me.sid, k), t));
  return { K: k, isk, sidOutput: await env.sha512(concat(utf8("CPaceSidOutput"), t)) };
}

/** ISK for parallel execution (transcript_oc), used only to check B.1.6. */
export async function iskOc(env: Env, sid: Uint8Array, k: Uint8Array, ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array) {
  const t = transcriptOc(ya, ada, yb, adb);
  return {
    isk: await env.sha512(concat(lvCat(concat(DSI, utf8("_ISK")), sid, k), t)),
    sidOutput: await env.sha512(concat(utf8("CPaceSidOutput"), t)),
  };
}
