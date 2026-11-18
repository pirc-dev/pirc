// The join's code and keys (docs/e2e.md, section 5, "The join's bytes"):
// nine Crockford base32 characters, four for the relay's lookup and five
// for CPace's password; CPace's key confirmed both ways, then one sealing
// key per direction, each message's additional data the transcript so far.

import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  DeviceRole,
  JoinDeviceBodySchema,
  JoinDeviceSchema,
  JoinResultSchema,
  JoinStepSchema,
  type JoinResult,
  type JoinStep,
  type SignedObject,
} from "@pirc/protocol/v1alpha2";
import { concat, equal, framed, random, u64, utf8 } from "./bytes.ts";
import * as cp from "./cpace.ts";
import type { Signer } from "./ed25519.ts";
import * as hpke from "./hpke.ts";
import { open, sign } from "./objects.ts";

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

// --- the two sides of a join, step by step (relay.proto's JoinMessage
// carries each step, encoded) ---

/** Why a join ended: a wrong code, a relay that changed something, or a step out of order. */
export class JoinFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JoinFailed";
  }
}

const step = (s: MessageInitShape<typeof JoinStepSchema>["step"]): Uint8Array => toBinary(JoinStepSchema, create(JoinStepSchema, { step: s }));

function readStep(b: Uint8Array): JoinStep["step"] {
  try {
    return fromBinary(JoinStepSchema, b).step;
  } catch {
    throw new JoinFailed("an undecodable step");
  }
}

const NONE = new Uint8Array(0);
const MAX_NAME_BYTES = 128;

/**
 * The device that shows the code: it offers CPace's first share, checks
 * the client's confirmation, sends its own with what it is, and reads
 * the approval. Forgets the code at the first failure.
 */
export class DeviceJoin {
  private channel: Channel | undefined;
  private constructor(
    private readonly ci: Uint8Array,
    private readonly nonce: Uint8Array,
    private readonly party: cp.Party,
    private readonly me: { role: DeviceRole; signer: Signer; name: string },
  ) {}

  /** The join and its first step, for a code from newCode. */
  static async start(origin: string, code: { lookup: string; secret: string }, me: { role: DeviceRole; signer: Signer; name: string }): Promise<{ join: DeviceJoin; offer: Uint8Array }> {
    const ci = channelId(origin, code.lookup);
    const nonce = random(16);
    const party = await cp.start(env, { prs: utf8(code.secret), ci, sid: nonce, ad: NONE });
    return { join: new DeviceJoin(ci, nonce, party, me), offer: step({ case: "offer", value: { nonce, share: party.Y } }) };
  }

  /** The client's answer: its share and confirmation. Gives the confirm step. */
  async onAnswer(b: Uint8Array): Promise<Uint8Array> {
    const s = readStep(b);
    if (s.case !== "answer" || this.channel) throw new JoinFailed("expected the client's answer");
    let isk: Uint8Array;
    try {
      isk = (await cp.finish(env, this.party, "initiator", s.value.share, NONE)).isk;
    } catch {
      throw new JoinFailed("the client's share is not a point to use");
    }
    const k = await keys(isk, this.ci, this.nonce, this.party.Y, s.value.share);
    if (!(await confirmed(k.clientConfirm, k.transcript, s.value.confirmation))) throw new JoinFailed("the code does not match");
    this.channel = deviceChannel(k);
    const name = cutName(this.me.name);
    const device = await sign("join", NONE, this.me.signer, create(JoinDeviceBodySchema, { transcript: k.transcript, role: this.me.role, publicKey: this.me.signer.publicKey, name }));
    const sealed = await this.channel.seal(toBinary(JoinDeviceSchema, create(JoinDeviceSchema, { device })));
    return step({ case: "confirm", value: { confirmation: await confirmation(k.deviceConfirm, k.transcript), device: { ciphertext: sealed } } });
  }

  /** The client's sealed result. */
  async onResult(b: Uint8Array): Promise<JoinResult["result"]> {
    const s = readStep(b);
    if (s.case !== "sealed" || !this.channel) throw new JoinFailed("expected the client's result");
    const plain = await this.channel.open(s.value.ciphertext);
    if (!plain) throw new JoinFailed("the result does not open");
    try {
      return fromBinary(JoinResultSchema, plain).result;
    } catch {
      throw new JoinFailed("an undecodable result");
    }
  }
}

/** Cuts a name to 128 bytes of UTF-8, on a character boundary. */
export function cutName(s: string): string {
  const b = utf8(s);
  if (b.length <= MAX_NAME_BYTES) return s;
  let end = MAX_NAME_BYTES;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(b.subarray(0, end));
}

export type JoiningDevice = { role: DeviceRole.HOST | DeviceRole.CLIENT; publicKey: Uint8Array; name: string };

/**
 * The client that types the code: it answers the offer, checks the
 * device's confirmation and what the device says it is, and seals the
 * person's decision.
 */
export class ClientJoin {
  private constructor(
    private readonly k: JoinKeys,
    private readonly channel: Channel,
  ) {}

  /** The join and the answer step, from the code as typed and the device's offer. */
  static async answer(origin: string, code: { lookup: string; secret: string }, offer: Uint8Array): Promise<{ join: ClientJoin; answer: Uint8Array }> {
    const s = readStep(offer);
    if (s.case !== "offer" || s.value.nonce.length !== 16) throw new JoinFailed("expected the device's offer");
    const ci = channelId(origin, code.lookup);
    const me = await cp.start(env, { prs: utf8(code.secret), ci, sid: s.value.nonce, ad: NONE });
    let isk: Uint8Array;
    try {
      isk = (await cp.finish(env, me, "responder", s.value.share, NONE)).isk;
    } catch {
      throw new JoinFailed("the device's share is not a point to use");
    }
    const k = await keys(isk, ci, s.value.nonce, s.value.share, me.Y);
    return {
      join: new ClientJoin(k, clientChannel(k)),
      answer: step({ case: "answer", value: { share: me.Y, confirmation: await confirmation(k.clientConfirm, k.transcript) } }),
    };
  }

  /** The device's confirmation and what it is: a host or a client, its key, its name. */
  async onConfirm(b: Uint8Array): Promise<JoiningDevice> {
    const s = readStep(b);
    if (s.case !== "confirm") throw new JoinFailed("expected the device's confirmation");
    if (!(await confirmed(this.k.deviceConfirm, this.k.transcript, s.value.confirmation))) throw new JoinFailed("the code does not match");
    const plain = await this.channel.open(s.value.device?.ciphertext ?? NONE);
    if (!plain) throw new JoinFailed("the device's message does not open");
    let signed: SignedObject | undefined;
    try {
      signed = fromBinary(JoinDeviceSchema, plain).device;
    } catch {
      throw new JoinFailed("an undecodable device");
    }
    const body = signed && (await open("join", NONE, signed));
    if (!body || !equal(body.transcript, this.k.transcript)) throw new JoinFailed("the device's signature does not check");
    if (body.role !== DeviceRole.HOST && body.role !== DeviceRole.CLIENT) throw new JoinFailed("the device is neither a host nor a client");
    if (utf8(body.name).length > MAX_NAME_BYTES) throw new JoinFailed("the device's name is too long");
    return { role: body.role, publicKey: body.publicKey, name: body.name };
  }

  /** The person's decision, sealed for the device. */
  async result(r: JoinResult["result"]): Promise<Uint8Array> {
    const plain = toBinary(JoinResultSchema, create(JoinResultSchema, { result: r }));
    return step({ case: "sealed", value: { ciphertext: await this.channel.seal(plain) } });
  }
}
