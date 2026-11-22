// Byte and text helpers shared by the checks.

/** A Uint8Array, a Buffer among them, from any realm. */
export function isBytes(x: unknown): x is Uint8Array {
  return ArrayBuffer.isView(x) && Object.prototype.toString.call(x) === "[object Uint8Array]";
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// fatal: malformed UTF-8 is refused, never replaced. ignoreBOM: a leading
// U+FEFF is text like any other, as every language reads it.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The text of valid UTF-8, or undefined. */
export function utf8Text(b: Uint8Array): string | undefined {
  try {
    return decoder.decode(b);
  } catch {
    return undefined;
  }
}

/**
 * A text's UTF-8, cut to at most cap bytes at a code point boundary. A lone
 * surrogate, which has no UTF-8, comes out as U+FFFD: TextEncoder writes it
 * so.
 */
export function utf8Cut(text: string, cap: number): Uint8Array {
  const b = new TextEncoder().encode(text);
  if (b.length <= cap) return b;
  let end = cap;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.slice(0, end);
}
