// The join's code and keys (docs/e2e.md, section 5, "The join's bytes"):
// nine Crockford base32 characters, four for the relay's lookup and five
// for CPace's password; CPace's key confirmed both ways, then one sealing
// key per direction, each message's additional data the transcript so far.

import { concat, equal, framed, random, u64, utf8 } from "./bytes.ts";
import * as cp from "./cpace.ts";
import * as hpke from "./hpke.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new code: nine characters, shown as K7QM-2XRP9. */
export function newCode(): { lookup: string; secret: string; shown: string } {
  const chars = Array.from(randomBelow32(9), (i) => ALPHABET[i]).join("");
  return { lookup: chars.slice(0, 4), secret: chars.slice(4), shown: `${chars.slice(0, 4)}-${chars.slice(4)}` };
}

function randomBelow32(n: number): number[] {
  return Array.from(random(n), (b) => b & 31);
}

/**
 * A typed code in Crockford's reading: case and hyphens ignored, I and L
 * read as 1, O as 0. Null unless it is nine characters.
 */
export function readCode(typed: string): { lookup: string; secret: string } | null {
  const s = typed.toUpperCase().replace(/[-\s]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  if (s.length !== 9 || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return { lookup: s.slice(0, 4), secret: s.slice(4) };
}

/** CPace on WebCrypto: the platform's X25519, which may refuse a point or give zeros (cpace.ts handles both). */
export const env: cp.Env = {
  x25519: async (scalar, u) => hpke.x25519Raw((await hpke.x25519FromPrivate(scalar)).privateKey, u),
  sha512: hpke.sha512,
  random,
};

export const channelId = (origin: string, lookup: string): Uint8Array => cp.lvCat(utf8("pirc-join-v1"), utf8(origin), utf8(lookup));

export type JoinKeys = {
  transcript: Uint8Array;
  deviceConfirm: Uint8Array;
  clientConfirm: Uint8Array;
  deviceSeal: Uint8Array;
  clientSeal: Uint8Array;
};

/** From CPace's ISK and the four values of its exchange. */
export async function keys(isk: Uint8Array, ci: Uint8Array, nonce: Uint8Array, ya: Uint8Array, yb: Uint8Array): Promise<JoinKeys> {
  const transcript = await hpke.sha256(framed("pirc-join-v1 transcript", ci, nonce, ya, yb));
  const okm = await hpke.hkdf(isk, new Uint8Array(0), framed("pirc-join-v1 keys", transcript), 128);
  return {
    transcript,
    deviceConfirm: okm.slice(0, 32),
    clientConfirm: okm.slice(32, 64),
    deviceSeal: okm.slice(64, 96),
    clientSeal: okm.slice(96, 128),
  };
}

export const confirmation = (confirmKey: Uint8Array, transcript: Uint8Array): Promise<Uint8Array> => hpke.hmacSha256(confirmKey, transcript);

export async function confirmed(confirmKey: Uint8Array, transcript: Uint8Array, given: Uint8Array): Promise<boolean> {
  return equal(await confirmation(confirmKey, transcript), given);
}

/** One side's sealing: its key, how many it has sealed, and the transcript both sides track. */
export class Channel {
  private sent = 0n;
  private received = 0n;
  transcript: Uint8Array;
  constructor(
    private readonly sealKey: Uint8Array,
    private readonly openKey: Uint8Array,
    transcript: Uint8Array,
  ) {
    this.transcript = transcript;
  }

  async seal(plaintext: Uint8Array): Promise<Uint8Array> {
    const ct = await hpke.aesSeal(this.sealKey, concat(new Uint8Array(4), u64(this.sent++)), this.transcript, plaintext);
    await this.advance(ct);
    return ct;
  }

  /** Null when it does not open, which ends the join. */
  async open(ciphertext: Uint8Array): Promise<Uint8Array | null> {
    const pt = await hpke.aesOpen(this.openKey, concat(new Uint8Array(4), u64(this.received++)), this.transcript, ciphertext);
    if (pt) await this.advance(ciphertext);
    return pt;
  }

  private async advance(ciphertext: Uint8Array): Promise<void> {
    this.transcript = await hpke.sha256(framed("pirc-join-v1 transcript", this.transcript, ciphertext));
  }
}

export const deviceChannel = (k: JoinKeys) => new Channel(k.deviceSeal, k.clientSeal, k.transcript);
export const clientChannel = (k: JoinKeys) => new Channel(k.clientSeal, k.deviceSeal, k.transcript);
