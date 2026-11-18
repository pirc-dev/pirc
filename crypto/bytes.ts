// Bytes, and the one way PiRC frames strings for signing, hashing, HKDF's
// and HPKE's info and AES-GCM's additional data (docs/e2e.md, section 2,
// "Exact bytes"): the context's ASCII, a NUL byte, then each part
// prefixed by its length as an unsigned LEB128.

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export function leb128(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`bad length ${n}`);
  const out: number[] = [];
  do {
    out.push(n < 128 ? n : (n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  } while (n > 0);
  return Uint8Array.from(out);
}

/** CPace's prepend_len. */
export const prependLen = (data: Uint8Array): Uint8Array => concat(leb128(data.length), data);

export function framed(context: string, ...parts: Uint8Array[]): Uint8Array {
  return concat(utf8(context), Uint8Array.of(0), ...parts.map(prependLen));
}

/** 8 bytes big-endian. */
export function u64(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 64n) throw new RangeError(`not a u64: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Bytewise order, for the lists that are kept sorted by key. */
export function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function unhex(s: string): Uint8Array {
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new SyntaxError("not hex");
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}

export function random(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** A copy WebCrypto takes as a BufferSource whatever the view's buffer. */
export const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(b);
