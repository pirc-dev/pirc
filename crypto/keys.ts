// A process's keys of the day, and what is sealed under them (docs/e2e.md,
// section 4): sending keys derived from a secret, frames under them,
// bundles that wrap them for every pre-key, envelopes sealed to the
// request key; and the label key's records and wraps (section 3).

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { type SessionRef } from "@pirc/protocol";
import {
  BundleRecipientSchema,
  DeviceRole,
  Direction,
  FrameKind,
  LabelsSchema,
  type BundleBody,
  type LabelKeyRef,
  type Labels,
  type ListVersionBody,
} from "@pirc/protocol/v1alpha2";
import { compare, concat, equal, framed, random, u64, utf8 } from "./bytes.ts";
import * as hpke from "./hpke.ts";
import { device } from "./list.ts";

export type SendingKeys = { announcement: Uint8Array; conversation: Uint8Array };

export async function sendingKeys(secret: Uint8Array, keyId: Uint8Array, accountId: Uint8Array, hostKey: Uint8Array): Promise<SendingKeys> {
  const prk = await hpke.extract(keyId, secret);
  return {
    announcement: await hpke.expand(prk, framed("pirc-e2e-v1 announcement key", accountId, hostKey), 32),
    conversation: await hpke.expand(prk, framed("pirc-e2e-v1 conversation key", accountId, hostKey), 32),
  };
}

// --- frames ---

export type FrameAt = {
  accountId: Uint8Array;
  keyId: Uint8Array;
  session: SessionRef;
  kind: FrameKind;
  /** The client's key for an answer to one client; empty otherwise. */
  recipient: Uint8Array;
  listVersion: bigint;
  counter: bigint;
};

export function frameAad(f: FrameAt): Uint8Array {
  return framed(
    "pirc-e2e-v1 frame",
    f.accountId,
    f.keyId,
    f.session.hostKey,
    utf8(f.session.sessionId),
    utf8(f.session.instanceId),
    Uint8Array.of(Direction.HOST_TO_CLIENT),
    Uint8Array.of(f.kind),
    f.recipient,
    u64(f.listVersion),
    u64(f.counter),
  );
}

const frameNonce = (counter: bigint): Uint8Array => concat(new Uint8Array(4), u64(counter));

export const sealFrame = (key: Uint8Array, f: FrameAt, plaintext: Uint8Array): Promise<Uint8Array> =>
  hpke.aesSeal(key, frameNonce(f.counter), frameAad(f), plaintext);

export const openFrame = (key: Uint8Array, f: FrameAt, ciphertext: Uint8Array): Promise<Uint8Array | null> =>
  hpke.aesOpen(key, frameNonce(f.counter), frameAad(f), ciphertext);

// --- bundles ---

const wrapInfo = (accountId: Uint8Array, hostKey: Uint8Array, keyId: Uint8Array, recipient: Uint8Array) =>
  framed("pirc-e2e-v1 wrap", accountId, hostKey, keyId, recipient);
const ANNOUNCEMENT_AAD = utf8("announcement key");
const CONVERSATION_AAD = utf8("conversation key");

export type PreKeyOf = { publicKey: Uint8Array; preKey: Uint8Array };

/**
 * The recipients of a bundle: for each current pre-key of a client (both
 * keys) or a read-only key (the announcement key) on `list`, ordered by
 * key. Pre-keys of devices not on the list are left out.
 */
export async function wrapFor(
  list: ListVersionBody,
  preKeys: PreKeyOf[],
  keys: SendingKeys,
  at: { accountId: Uint8Array; hostKey: Uint8Array; keyId: Uint8Array },
  ephemeral?: () => Promise<hpke.X25519Pair>,
) {
  const out = [];
  for (const p of [...preKeys].sort((a, b) => compare(a.publicKey, b.publicKey))) {
    const role = device(list, p.publicKey)?.role;
    if (role !== DeviceRole.CLIENT && role !== DeviceRole.READ_ONLY) continue;
    const info = wrapInfo(at.accountId, at.hostKey, at.keyId, p.publicKey);
    out.push(
      create(BundleRecipientSchema, {
        publicKey: p.publicKey,
        preKey: p.preKey,
        announcementKey: await hpke.seal(p.preKey, info, ANNOUNCEMENT_AAD, keys.announcement, await ephemeral?.()),
        conversationKey: role === DeviceRole.CLIENT ? await hpke.seal(p.preKey, info, CONVERSATION_AAD, keys.conversation, await ephemeral?.()) : new Uint8Array(0),
      }),
    );
  }
  return out;
}

/**
 * This device's keys from a bundle whose signature the caller has checked
 * (objects.open): only if every recipient is on `list` and recipients are
 * in order. A read-only key gets the announcement key alone.
 */
export async function unwrap(
  accountId: Uint8Array,
  bundle: BundleBody,
  list: ListVersionBody,
  me: { publicKey: Uint8Array; preKey: hpke.X25519Pair },
): Promise<{ announcement: Uint8Array; conversation: Uint8Array | null } | null> {
  for (let i = 0; i < bundle.recipients.length; i++) {
    const r = bundle.recipients[i];
    const role = device(list, r.publicKey)?.role;
    if (role !== DeviceRole.CLIENT && role !== DeviceRole.READ_ONLY) return null;
    if (i > 0 && compare(bundle.recipients[i - 1].publicKey, r.publicKey) >= 0) return null;
  }
  const mine = bundle.recipients.find((r) => equal(r.publicKey, me.publicKey) && equal(r.preKey, me.preKey.publicKey));
  if (!mine) return null;
  const info = wrapInfo(accountId, bundle.hostKey, bundle.keyId, me.publicKey);
  const announcement = await hpke.open(me.preKey, info, ANNOUNCEMENT_AAD, mine.announcementKey);
  if (!announcement || announcement.length !== 32) return null;
  if (!mine.conversationKey.length) return { announcement, conversation: null };
  const conversation = await hpke.open(me.preKey, info, CONVERSATION_AAD, mine.conversationKey);
  return conversation?.length === 32 ? { announcement, conversation } : null;
}

// --- requests ---

const requestInfo = (accountId: Uint8Array, hostKey: Uint8Array, keyId: Uint8Array) =>
  framed("pirc-e2e-v1 request", accountId, hostKey, keyId);

/** A signed envelope (objects.encode of the "request" kind), sealed to a process's request key. */
export const sealEnvelope = (requestKey: Uint8Array, accountId: Uint8Array, hostKey: Uint8Array, keyId: Uint8Array, signed: Uint8Array, ephemeral?: hpke.X25519Pair) =>
  hpke.seal(requestKey, requestInfo(accountId, hostKey, keyId), new Uint8Array(0), signed, ephemeral);

export const openEnvelope = (requestKey: hpke.X25519Pair, accountId: Uint8Array, hostKey: Uint8Array, keyId: Uint8Array, sealed: Uint8Array) =>
  hpke.open(requestKey, requestInfo(accountId, hostKey, keyId), new Uint8Array(0), sealed);

// --- labels ---

const labelKeyParts = (ref: LabelKeyRef): [Uint8Array, Uint8Array] => [u64(ref.version?.number ?? 0n), ref.version?.hash ?? new Uint8Array(0)];

const labelsAad = (accountId: Uint8Array, ref: LabelKeyRef, counter: bigint) => framed("pirc-e2e-v1 labels", accountId, ...labelKeyParts(ref), u64(counter));

/** A random 12-byte nonce, then the ciphertext: several clients write under one key. */
export async function sealLabels(labelKey: Uint8Array, accountId: Uint8Array, ref: LabelKeyRef, counter: bigint, labels: Labels, nonce = random(12)): Promise<Uint8Array> {
  return concat(nonce, await hpke.aesSeal(labelKey, nonce, labelsAad(accountId, ref, counter), toBinary(LabelsSchema, labels)));
}

export async function openLabels(labelKey: Uint8Array, accountId: Uint8Array, ref: LabelKeyRef, counter: bigint, sealed: Uint8Array): Promise<Labels | null> {
  if (sealed.length < 12 + 16) return null;
  const plain = await hpke.aesOpen(labelKey, sealed.subarray(0, 12), labelsAad(accountId, ref, counter), sealed.subarray(12));
  if (!plain) return null;
  try {
    return fromBinary(LabelsSchema, plain);
  } catch {
    return null;
  }
}

const labelKeyInfo = (accountId: Uint8Array, ref: LabelKeyRef, recipient: Uint8Array) => framed("pirc-e2e-v1 label-key", accountId, ...labelKeyParts(ref), recipient);

export const wrapLabelKey = (preKey: Uint8Array, accountId: Uint8Array, ref: LabelKeyRef, recipient: Uint8Array, labelKey: Uint8Array, ephemeral?: hpke.X25519Pair) =>
  hpke.seal(preKey, labelKeyInfo(accountId, ref, recipient), new Uint8Array(0), labelKey, ephemeral);

export async function unwrapLabelKey(preKey: hpke.X25519Pair, accountId: Uint8Array, ref: LabelKeyRef, me: Uint8Array, wrap: Uint8Array): Promise<Uint8Array | null> {
  const k = await hpke.open(preKey, labelKeyInfo(accountId, ref, me), new Uint8Array(0), wrap);
  return k?.length === 32 ? k : null;
}
