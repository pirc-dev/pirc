// A join's shared pieces (docs/e2e.md, section 6): the text a new device
// shows, and its QR code holds; XXpsk3's prologue; and each side's signed
// offer of its keys.
//
// The text is "PIRC1", then the lookup (8 Crockford base32 characters, 40
// bits), then the 256-bit secret in Crockford base32 (52 characters, the
// last 4 bits zero): 65 characters, upper case, no padding. Reading it
// takes lower case too, and ignores spaces and hyphens, and anything up to
// a "#", so that a link carrying it after "#" reads as the text.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { DeviceSchema, JoinOfferSchema, type JoinOffer } from "@pirc/protocol/v1alpha2";
import type sodiumType from "libsodium-wrappers-sumo";

import { equal, isBytes } from "./bytes.ts";
import { framed, framedNumber } from "./framed.ts";
import { isDeviceKeys, ROLE_CLIENT, ROLE_COMPUTER, type DeviceKeys } from "./list.ts";

type Sodium = typeof sodiumType;

export const JOIN_CONTEXT = "pirc-e2e-v2 join";
export const JOIN_VERSION = 1n;
export const JOIN_TEXT_PREFIX = "PIRC1";
export const LOOKUP_CHARS = 8;
export const SECRET_BYTES = 32;
export const JOIN_TEXT_CHARS = JOIN_TEXT_PREFIX.length + LOOKUP_CHARS + 52;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_BYTES = 32;
const utf8 = new TextEncoder();

/** Crockford base32 of bytes, most significant bit first; the last character's spare bits zero. */
export function base32(b: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const x of b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** The bytes of `n` bytes' base32, or undefined for another length, a character outside the alphabet, or spare bits set. */
export function fromBase32(s: string, n: number): Uint8Array | undefined {
  if (s.length !== Math.ceil((n * 8) / 5)) return undefined;
  const out = new Uint8Array(n);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) return undefined;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  return acc === 0 ? out : undefined;
}

/** A random lookup: 5 random bytes, 8 characters. */
export function newLookup(random: (n: number) => Uint8Array): string {
  return base32(random(5));
}

export function joinText(lookup: string, secret: Uint8Array): string {
  if (fromBase32(lookup, 5) === undefined) throw new TypeError("join: the lookup is 8 Crockford base32 characters");
  if (!isBytes(secret) || secret.length !== SECRET_BYTES) throw new TypeError("join: the secret is 32 bytes");
  return JOIN_TEXT_PREFIX + lookup + base32(secret);
}

/** The lookup and secret a join's text, or a link carrying it, holds; undefined if it holds none. */
export function readJoinText(input: string): { lookup: string; secret: Uint8Array } | undefined {
  const hash = input.lastIndexOf("#");
  const s = (hash >= 0 ? input.slice(hash + 1) : input).replace(/[\s-]/g, "").toUpperCase();
  if (s.length !== JOIN_TEXT_CHARS || !s.startsWith(JOIN_TEXT_PREFIX)) return undefined;
  const lookup = s.slice(JOIN_TEXT_PREFIX.length, JOIN_TEXT_PREFIX.length + LOOKUP_CHARS);
  if (fromBase32(lookup, 5) === undefined) return undefined;
  const secret = fromBase32(s.slice(JOIN_TEXT_PREFIX.length + LOOKUP_CHARS), SECRET_BYTES);
  return secret ? { lookup, secret } : undefined;
}

/** XXpsk3's prologue: framed(context, the join's version, the lookup). */
export function joinPrologue(lookup: string): Uint8Array {
  return framed(JOIN_CONTEXT, framedNumber(JOIN_VERSION), utf8.encode(lookup));
}

/** What a side signs: framed(context, its role, its five keys, the handshake's final hash). */
export function offerSigned(d: DeviceKeys, handshakeHash: Uint8Array): Uint8Array {
  return framed(JOIN_CONTEXT, framedNumber(BigInt(d.role)), d.signingKey, d.channelKey, d.boxKey, d.readOnlyKey, d.notificationKey, handshakeHash);
}

/** An offer's bytes, signed with sign. */
export function makeOffer(d: DeviceKeys, handshakeHash: Uint8Array, sign: (m: Uint8Array) => Uint8Array): Uint8Array {
  return toBinary(JoinOfferSchema, create(JoinOfferSchema, { device: create(DeviceSchema, d), signature: sign(offerSigned(d, handshakeHash)) }));
}

export type OfferRefusedReason = "parse" | "role" | "key" | "channel-key" | "signature";
export type OfferResult = { result: "accepted"; device: DeviceKeys } | { result: "refused"; reason: OfferRefusedReason };

const key = (b: Uint8Array) => b.length === KEY_BYTES;

/**
 * The other side's offer, checked: of the role expected, its keys the
 * right sizes, its channel key the static key the handshake proved, and
 * signed by its signing key over this handshake. Verified with libsodium.
 */
export function checkOffer(sodium: Sodium, input: { offer: JoinOffer | Uint8Array; role: number; remoteStatic: Uint8Array; handshakeHash: Uint8Array }): OfferResult {
  const refused = (reason: OfferRefusedReason) => ({ result: "refused", reason }) as const;
  let offer: JoinOffer;
  try {
    offer = isBytes(input.offer) ? fromBinary(JoinOfferSchema, input.offer) : input.offer;
  } catch {
    return refused("parse");
  }
  const d = offer.device;
  if (!d || !isDeviceKeys(d)) return refused("parse");
  if (d.role !== input.role || (d.role !== ROLE_CLIENT && d.role !== ROLE_COMPUTER)) return refused("role");
  const phoneKeys = d.role === ROLE_CLIENT && d.readOnlyKey.length > 0;
  if (!key(d.signingKey) || !key(d.channelKey) || !key(d.boxKey)) return refused("key");
  if (phoneKeys ? !key(d.readOnlyKey) || !key(d.notificationKey) : d.readOnlyKey.length > 0 || d.notificationKey.length > 0) return refused("key");
  if (!equal(d.channelKey, input.remoteStatic)) return refused("channel-key");
  if (offer.signature.length !== 64) return refused("signature");
  let ok = false;
  try {
    ok = sodium.crypto_sign_verify_detached(offer.signature, offerSigned(d, input.handshakeHash), d.signingKey);
  } catch {
    ok = false;
  }
  if (!ok) return refused("signature");
  const device: DeviceKeys = { role: d.role, signingKey: d.signingKey, channelKey: d.channelKey, boxKey: d.boxKey, readOnlyKey: d.readOnlyKey, notificationKey: d.notificationKey };
  return { result: "accepted", device };
}
