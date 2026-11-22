// What a computer seals for the relay to keep (docs/e2e.md, section 5): a
// session's announcement, one copy per client, and its notice, one copy per
// phone, each with crypto_box from the computer's box key. Opening checks
// the copy against the slot the relay names it by and the caller's newest
// list. No input bytes make opening throw; only a caller's mistake does.
// Sealing throws only for the caller's mistakes it names: inputs of the
// wrong shape, a session ID that is not 1 to 128 bytes of UTF-8, an
// ordering value outside 0 to 2^63-1, and a box secret key that is not the
// computer's.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AnnouncementSchema, NoticeSchema } from "@pirc/protocol/v1alpha2";
import type sodiumType from "libsodium-wrappers-sumo";

import { concat, equal, isBytes, utf8Cut, utf8Text } from "./bytes.ts";
import { framed, framedNumber } from "./framed.ts";
import { isDeviceKeys, ROLE_CLIENT, ROLE_COMPUTER, type DeviceKeys } from "./list.ts";

type Sodium = typeof sodiumType;

export const ANNOUNCEMENT_CONTEXT = "pirc-e2e-v2 announcement";
export const NOTICE_CONTEXT = "pirc-e2e-v2 notice";
export const SEALED_MAX_BYTES = 65_536;
export const SESSION_ID_MAX_BYTES = 128;
/** How far ahead of now an ordering value may be. */
export const FUTURE_MS = 86_400_000n;

export const NONCE_BYTES = 24;
export const MAC_BYTES = 16;
const KEY_BYTES = 32;
const ORDERING_LIMIT = 1n << 63n;

export type Kind = "announcement" | "notice";

/** The slot a sealed copy is kept in: whose, from which computer, for which session, of which kind. */
export interface Slot {
  accountId: Uint8Array;
  /** The computer's signing key. */
  computerKey: Uint8Array;
  /** The session ID's UTF-8 bytes exactly as the protocol carries them. */
  sessionId: Uint8Array;
  kind: Kind;
}

/** What sealing and opening read of the caller's newest list; an accepted ListBody is one. */
export interface ListView {
  counter: bigint;
  devices: DeviceKeys[];
}

export interface AnnouncementText {
  sessionName: string;
  folder: string;
  model: string;
  computerName: string;
  notice: string;
}

export interface NoticeText {
  sessionName: string;
  computerName: string;
  notice: string;
}

/** Each field's cap in bytes of UTF-8. */
export const CAPS = Object.freeze({
  announcement: Object.freeze({ sessionName: 200, folder: 1024, model: 200, computerName: 200, notice: 4096 }),
  notice: Object.freeze({ sessionName: 200, computerName: 200, notice: 4096 }),
} as const);

const SCHEMAS = { announcement: AnnouncementSchema, notice: NoticeSchema } as const;
const CONTEXTS = { announcement: ANNOUNCEMENT_CONTEXT, notice: NOTICE_CONTEXT } as const;

export interface SealInput {
  list: ListView;
  /** The computer's own box secret key. */
  boxSecretKey: Uint8Array;
  slot: Slot;
  /** Kept by the caller (docs/e2e.md, section 5); below 2^63. */
  ordering: bigint;
  /** An AnnouncementText for an announcement, a NoticeText for a notice. */
  body: AnnouncementText | NoticeText;
}

export interface SealedCopy {
  /** The recipient device's signing key. */
  signingKey: Uint8Array;
  /** The key it is sealed to: the client's box key, or the phone's notification key. */
  recipientKey: Uint8Array;
  /** The nonce, then the ciphertext. */
  sealed: Uint8Array;
}

export interface Sealed {
  copies: SealedCopy[];
  /** Recipient keys libsodium refuses, by key, for the caller to log. */
  skipped: Uint8Array[];
}

export interface OpenInput {
  sealed: Uint8Array;
  slot: Omit<Slot, "kind">;
  /** The recipient's secret key: a box secret key for an announcement. */
  recipientSecretKey: Uint8Array;
  list: ListView;
  /** The highest ordering value seen for the slot, or null if none. */
  highest: bigint | null;
  /** The time now, in milliseconds. */
  now: bigint;
}

export type SealedRefusedReason =
  | "slot"
  | "size"
  | "computer-not-listed"
  | "box"
  | "prefix"
  | "range"
  | "ordering"
  | "future"
  | "parse"
  | "text";

export type OpenResult<T> = { result: "accepted"; ordering: bigint; body: T } | { result: "refused"; reason: SealedRefusedReason };

function isListView(x: unknown): x is ListView {
  if (typeof x !== "object" || x === null) return false;
  const l = x as Record<string, unknown>;
  return typeof l.counter === "bigint" && Array.isArray(l.devices) && l.devices.every(isDeviceKeys);
}

function goodSessionId(id: Uint8Array): boolean {
  return id.length >= 1 && id.length <= SESSION_ID_MAX_BYTES && utf8Text(id) !== undefined;
}

function isKind(x: unknown): x is Kind {
  return x === "announcement" || x === "notice";
}

/** The plaintext's start for a slot: framed(context, account ID, computer key, session ID), then the ordering part's length. */
function prefix(kind: Kind, slot: Omit<Slot, "kind">): Uint8Array {
  return concat(framed(CONTEXTS[kind], slot.accountId, slot.computerKey, slot.sessionId), Uint8Array.of(8));
}

/**
 * Seals with the nonce nonceFor gives each copy, in the list's order of
 * recipients. Only seal() and the tests call it.
 */
export function sealWithNonces(sodium: Sodium, input: SealInput, nonceFor: (i: number) => Uint8Array): Sealed {
  const { list, boxSecretKey, slot, ordering, body } = input;
  if (!isListView(list)) throw new TypeError("seal: list is a counter and devices");
  if (!isBytes(boxSecretKey) || boxSecretKey.length !== KEY_BYTES) throw new TypeError("seal: the box secret key is 32 bytes");
  if (typeof slot !== "object" || slot === null || !isKind(slot.kind) || !isBytes(slot.accountId) || !isBytes(slot.computerKey) || !isBytes(slot.sessionId)) {
    throw new TypeError("seal: slot is an account ID, a computer key, a session ID and a kind");
  }
  if (!goodSessionId(slot.sessionId)) throw new TypeError("seal: the session ID is 1 to 128 bytes of UTF-8");
  if (typeof ordering !== "bigint" || ordering < 0n || ordering >= ORDERING_LIMIT) throw new TypeError("seal: ordering is a bigint from 0 to 2^63-1");
  const caps: Record<string, number> = CAPS[slot.kind];
  const fields = body as unknown as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Object.keys(caps).some((k) => typeof fields[k] !== "string")) {
    throw new TypeError(`seal: the body is an ${slot.kind}'s text`);
  }

  // A computer not on the list as a computer, such as a removed one, seals nothing.
  const computer = list.devices.find((d) => d.role === ROLE_COMPUTER && equal(d.signingKey, slot.computerKey));
  if (!computer) return { copies: [], skipped: [] };
  if (!equal(sodium.crypto_scalarmult_base(boxSecretKey), computer.boxKey)) throw new TypeError("seal: the box secret key is not this computer's");

  const cut: Record<string, Uint8Array> = {};
  for (const [k, cap] of Object.entries(caps)) cut[k] = utf8Cut(fields[k] as string, cap);
  const encoded = slot.kind === "announcement" ? toBinary(AnnouncementSchema, create(AnnouncementSchema, cut)) : toBinary(NoticeSchema, create(NoticeSchema, cut));
  const plaintext = concat(prefix(slot.kind, slot), framedNumber(ordering), encoded);

  const recipients =
    slot.kind === "announcement"
      ? list.devices.filter((d) => d.role === ROLE_CLIENT).map((d) => ({ d, key: d.boxKey }))
      : list.devices.filter((d) => d.role === ROLE_CLIENT && d.notificationKey.length === KEY_BYTES).map((d) => ({ d, key: d.notificationKey }));
  const out: Sealed = { copies: [], skipped: [] };
  recipients.forEach(({ d, key }, i) => {
    const nonce = nonceFor(i);
    if (!isBytes(nonce) || nonce.length !== NONCE_BYTES) throw new TypeError("seal: a nonce is 24 bytes");
    try {
      const box = sodium.crypto_box_easy(plaintext, nonce, key, boxSecretKey);
      out.copies.push({ signingKey: d.signingKey.slice(), recipientKey: key.slice(), sealed: concat(nonce, box) });
    } catch {
      out.skipped.push(key.slice());
    }
  });
  return out;
}

/** One copy of a session's announcement or notice for each recipient on the list, each with its own random nonce. */
export function seal(sodium: Sodium, input: SealInput): Sealed {
  return sealWithNonces(sodium, input, () => sodium.randombytes_buf(NONCE_BYTES));
}

function isOpenInput(x: OpenInput): boolean {
  const s = x?.slot;
  return (
    isBytes(x?.sealed) &&
    typeof s === "object" &&
    s !== null &&
    isBytes(s.accountId) &&
    isBytes(s.computerKey) &&
    isBytes(s.sessionId) &&
    isBytes(x.recipientSecretKey) &&
    isListView(x.list) &&
    (x.highest === null || (typeof x.highest === "bigint" && x.highest >= 0n)) &&
    typeof x.now === "bigint"
  );
}

/** Opens a copy of either kind; the package gives openAnnouncement. */
export function openSealed(sodium: Sodium, kind: Kind, input: OpenInput): OpenResult<AnnouncementText | NoticeText> {
  if (!isKind(kind) || !isOpenInput(input)) throw new TypeError("open: the inputs are bytes, a slot, a list, the highest seen (or null) and now");
  const refused = (reason: SealedRefusedReason) => ({ result: "refused", reason }) as const;
  const { sealed, slot } = input;

  // 1. The slot as the relay names it.
  if (!goodSessionId(slot.sessionId)) return refused("slot");
  // 2. Size.
  if (sealed.length > SEALED_MAX_BYTES || sealed.length < NONCE_BYTES + MAC_BYTES) return refused("size");
  // 3. The sender, a computer on the caller's newest list.
  const computer = input.list.devices.find((d) => d.role === ROLE_COMPUTER && equal(d.signingKey, slot.computerKey));
  if (!computer) return refused("computer-not-listed");
  // 4. The box, from that computer's box key.
  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_box_open_easy(sealed.subarray(NONCE_BYTES), sealed.subarray(0, NONCE_BYTES), computer.boxKey, input.recipientSecretKey);
  } catch {
    return refused("box");
  }
  // 5. The slot and kind it was sealed for, then 8 bytes of ordering.
  const start = prefix(kind, slot);
  if (plaintext.length < start.length + 8 || !equal(plaintext.subarray(0, start.length), start)) return refused("prefix");
  // 6. The ordering value.
  const ordering = new DataView(plaintext.buffer, plaintext.byteOffset + start.length, 8).getBigUint64(0);
  if (ordering >= ORDERING_LIMIT) return refused("range");
  if (input.highest !== null && ordering <= input.highest) return refused("ordering");
  if (ordering > input.now + FUTURE_MS) return refused("future");
  // 7. The body, and its text.
  let fields: Record<string, unknown>;
  try {
    fields = fromBinary(SCHEMAS[kind], plaintext.subarray(start.length + 8)) as unknown as Record<string, unknown>;
  } catch {
    return refused("parse");
  }
  const body: Record<string, string> = {};
  for (const [k, cap] of Object.entries(CAPS[kind] as Record<string, number>)) {
    const b = fields[k] as Uint8Array;
    const text = b.length <= cap ? utf8Text(b) : undefined;
    if (text === undefined) return refused("text");
    body[k] = text;
  }
  return { result: "accepted", ordering, body: body as unknown as AnnouncementText | NoticeText };
}

/** Opens a copy of a session's announcement sealed to this client's box key. */
export function openAnnouncement(sodium: Sodium, input: OpenInput): OpenResult<AnnouncementText> {
  return openSealed(sodium, "announcement", input) as OpenResult<AnnouncementText>;
}
