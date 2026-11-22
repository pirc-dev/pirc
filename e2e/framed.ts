// framed (docs/e2e.md, section 2): how every signed string is built. It
// imports nothing, so code that needs only this, such as the hosted login,
// loads no libsodium.
//
// Nothing parses framed bytes: a reader builds the bytes it expects and
// compares.

const NUMBER_LIMIT = 1n << 63n;

/**
 * A length as an unsigned LEB128, by arithmetic, so that it is right for
 * every safe integer. Exported for the tests, which reach lengths no test
 * can allocate.
 */
export function leb128(n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`leb128: ${n} is not a length`);
  const out: number[] = [];
  do {
    const low = n % 128;
    n = Math.floor(n / 128);
    out.push(n > 0 ? low + 128 : low);
  } while (n > 0);
  return out;
}

/**
 * The context's ASCII, a NUL byte, then each part prefixed by its length as
 * an unsigned LEB128. Throws a RangeError for a context that is empty or
 * holds a character below 0x20 or above 0x7E.
 */
export function framed(context: string, ...parts: Uint8Array[]): Uint8Array {
  if (context.length === 0) throw new RangeError("framed: empty context");
  for (let i = 0; i < context.length; i++) {
    const c = context.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) throw new RangeError(`framed: context character 0x${c.toString(16)} at ${i}`);
  }
  const prefixes = parts.map((p) => leb128(p.length));
  let size = context.length + 1;
  for (let i = 0; i < parts.length; i++) size += prefixes[i].length + parts[i].length;
  const out = new Uint8Array(size);
  for (let i = 0; i < context.length; i++) out[i] = context.charCodeAt(i);
  let at = context.length + 1;
  for (let i = 0; i < parts.length; i++) {
    out.set(prefixes[i], at);
    at += prefixes[i].length;
    out.set(parts[i], at);
    at += parts[i].length;
  }
  return out;
}

/**
 * A number as a framed part holds it: 8 bytes, big-endian. Throws a
 * RangeError for a value below 0 or at 2^63 or above.
 */
export function framedNumber(value: bigint): Uint8Array {
  if (typeof value !== "bigint") throw new TypeError("framedNumber: not a bigint");
  if (value < 0n || value >= NUMBER_LIMIT) throw new RangeError(`framedNumber: ${value} is outside 0 to 2^63-1`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}
