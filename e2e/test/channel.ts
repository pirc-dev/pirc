// The form of cases/noise/ and cases/e2e/channel.json (cases/README.md),
// and running them over the Noise core: shared by the generator (gen.ts),
// the runners (noise.test.ts, noise-webcrypto.test.ts) and the browsers'
// run of the WebCrypto key. It uses nothing of Node's, so a page can run it.
// A run gives the problems it found; none means the case passed.
import type sodiumType from "libsodium-wrappers-sumo";

import { channelPrologue } from "../noise.ts";
import { Handshake, IK, XXPSK3, type Failure, type Pattern, type Reason, type StaticKey, type Transport } from "../noise-core.ts";

type Sodium = typeof sodiumType;

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export function fromHex(s: string): Uint8Array {
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error(`not hex: ${s.slice(0, 40)}`);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// ------------------------------------------------------------ cases/noise/

/** A published vector, as its file holds it. */
export interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_psks?: string[];
  init_static: string;
  init_ephemeral: string;
  init_remote_static?: string;
  resp_prologue: string;
  resp_psks?: string[];
  resp_static: string;
  resp_ephemeral: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

export interface VectorFile {
  about: string;
  source: string;
  commit: string;
  licence: string;
  vectors: Vector[];
}

export const PATTERNS: Record<string, Pattern> = {
  Noise_IK_25519_ChaChaPoly_SHA512: IK,
  Noise_XXpsk3_25519_ChaChaPoly_SHA512: XXPSK3,
};

export const VECTOR_KEYS = ["protocol_name", "init_prologue", "init_static", "init_ephemeral", "resp_prologue", "resp_static", "resp_ephemeral", "messages"];
export const VECTOR_OPTIONAL = ["init_psks", "init_remote_static", "resp_psks", "handshake_hash"];

export type KeyMaker = (secret: Uint8Array) => Promise<StaticKey>;

/** A vector through the core with payloads, both sides, every message: what differs from the file. */
export async function runVector(sodium: Sodium, v: Vector, keyOf: KeyMaker): Promise<string[]> {
  const problems: string[] = [];
  const pattern = PATTERNS[v.protocol_name];
  if (!pattern) return [`${v.protocol_name}: not a pattern here`];
  const psk = (p?: string[]) => (p && p.length > 0 ? { psk: fromHex(p[0]) } : {});
  const init = new Handshake(sodium, {
    pattern,
    initiator: true,
    staticKey: await keyOf(fromHex(v.init_static)),
    ...(v.init_remote_static ? { remoteStatic: fromHex(v.init_remote_static) } : {}),
    prologue: fromHex(v.init_prologue),
    ...psk(v.init_psks),
    ephemeral: fromHex(v.init_ephemeral),
    payloads: true,
  });
  const resp = new Handshake(sodium, {
    pattern,
    initiator: false,
    staticKey: await keyOf(fromHex(v.resp_static)),
    prologue: fromHex(v.resp_prologue),
    ...psk(v.resp_psks),
    ephemeral: fromHex(v.resp_ephemeral),
    payloads: true,
  });
  let ti: Transport | undefined;
  let tr: Transport | undefined;
  for (const [i, m] of v.messages.entries()) {
    const fromInit = i % 2 === 0;
    const where = `${v.protocol_name}, message ${i}`;
    const payload = fromHex(m.payload);
    let sent: Uint8Array;
    let got: Uint8Array;
    if (i < pattern.messages.length) {
      const w = await (fromInit ? init : resp).writeMessage(payload);
      if (!w.ok) return [...problems, `${where}: writing failed, ${w.reason}`];
      sent = w.message;
      if (w.transport) fromInit ? (ti = w.transport) : (tr = w.transport);
      const r = await (fromInit ? resp : init).readMessage(fromHex(m.ciphertext));
      if (!r.ok) return [...problems, `${where}: reading failed, ${r.reason}`];
      got = r.payload;
      if (r.transport) fromInit ? (tr = r.transport) : (ti = r.transport);
    } else {
      if (!ti || !tr) return [...problems, `${where}: no transport`];
      const w = (fromInit ? ti : tr).send(payload);
      if (!w.ok) return [...problems, `${where}: sending failed, ${w.reason}`];
      sent = w.message;
      const r = (fromInit ? tr : ti).receive(fromHex(m.ciphertext));
      if (!r.ok) return [...problems, `${where}: receiving failed, ${r.reason}`];
      got = r.plaintext;
    }
    if (toHex(sent) !== m.ciphertext) problems.push(`${where}: ciphertext ${toHex(sent)}`);
    if (toHex(got) !== m.payload) problems.push(`${where}: payload ${toHex(got)}`);
  }
  if (!ti || !tr) return [...problems, `${v.protocol_name}: the handshake did not finish`];
  if (v.handshake_hash !== undefined) {
    if (toHex(ti.handshakeHash) !== v.handshake_hash) problems.push(`${v.protocol_name}: the initiator's handshake hash`);
    if (toHex(tr.handshakeHash) !== v.handshake_hash) problems.push(`${v.protocol_name}: the responder's handshake hash`);
  }
  return problems;
}

// ------------------------------------------------------- cases/e2e/channel.json

export interface PartyJson {
  role: "initiator" | "responder";
  /** The X25519 static secret key. */
  staticKey: string;
  /** The ephemeral secret key its handshake uses. */
  ephemeralKey: string;
  /** IK's initiator: the computer's channel key. */
  responderKey?: string;
  /** IK: the prologue built from the account ID, as the public API does. */
  accountId?: string;
  /** XXpsk3, or IK through the core with a prologue of the test's own. */
  prologue?: string;
  /** XXpsk3's PSK. */
  psk?: string;
}

export interface DoneJson {
  handshakeHash: string;
  remoteStatic: string;
  confirmed: boolean;
}

export type StepJson =
  | { party: string; call: "write"; bytes: string; done?: DoneJson }
  | { party: string; call: "write"; fails: Reason }
  | { party: string; call: "read"; bytes: string; done?: DoneJson }
  | { party: string; call: "read"; bytes: string; fails: Reason }
  | { party: string; call: "send"; plaintext: string; bytes: string }
  | { party: string; call: "send"; plaintext: string; fails: Reason }
  | { party: string; call: "send"; plaintext: string; throws: true }
  | { party: string; call: "receive"; bytes: string; plaintext: string }
  | { party: string; call: "receive"; bytes: string; fails: Reason };

export type ChannelCase =
  | { check: "prologue"; about: string; needs: string[]; accountId: string; bytes: string }
  | { check: "IK" | "XXpsk3"; about: string; needs: string[]; parties: Record<string, PartyJson>; steps: StepJson[] };

export interface ChannelFile {
  about: string;
  cases: ChannelCase[];
}

export const CHECK_PATTERNS: Record<string, Pattern> = { IK, XXpsk3: XXPSK3 };

/** A party's handshake through the core, PiRC's way: no payloads. */
export async function partyHandshake(sodium: Sodium, check: "IK" | "XXpsk3", p: PartyJson, keyOf: KeyMaker): Promise<Handshake> {
  const prologue = p.accountId !== undefined ? channelPrologue(fromHex(p.accountId)) : fromHex(p.prologue!);
  return new Handshake(sodium, {
    pattern: CHECK_PATTERNS[check],
    initiator: p.role === "initiator",
    staticKey: await keyOf(fromHex(p.staticKey)),
    ...(p.responderKey !== undefined ? { remoteStatic: fromHex(p.responderKey) } : {}),
    prologue,
    ...(p.psk !== undefined ? { psk: fromHex(p.psk) } : {}),
    ephemeral: fromHex(p.ephemeralKey),
    payloads: false,
  });
}

function doneOf(t: Transport): DoneJson {
  return { handshakeHash: toHex(t.handshakeHash), remoteStatic: toHex(t.remoteStatic!), confirmed: t.confirmed };
}

/** JSON with every object's keys sorted, so that two values compare whatever their keys' order. */
function canonical(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** A channel case, every step in order: what differs from the file. */
export async function runChannel(sodium: Sodium, c: ChannelCase, keyOf: KeyMaker): Promise<string[]> {
  if (c.check === "prologue") {
    const got = toHex(channelPrologue(fromHex(c.accountId)));
    return got === c.bytes ? [] : [`${c.about}: prologue ${got}`];
  }
  const problems: string[] = [];
  const hs = new Map<string, Handshake>();
  const ts = new Map<string, Transport>();
  for (const [name, p] of Object.entries(c.parties)) hs.set(name, await partyHandshake(sodium, c.check, p, keyOf));
  for (const [i, s] of c.steps.entries()) {
    const where = `${c.about}, step ${i} (${s.party} ${s.call})`;
    const h = hs.get(s.party);
    if (!h) return [...problems, `${where}: no such party`];
    let got: Record<string, unknown>;
    if (s.call === "write" || s.call === "read") {
      const r: { ok: true; message?: Uint8Array; transport?: Transport } | Failure = s.call === "write" ? await h.writeMessage() : await h.readMessage(fromHex(s.bytes));
      if (!r.ok) got = { fails: r.reason };
      else {
        got = s.call === "write" ? { bytes: toHex(r.message!) } : {};
        if (r.transport) {
          ts.set(s.party, r.transport);
          got.done = doneOf(r.transport);
        }
      }
      const want: Record<string, unknown> = { ...s };
      delete want.party;
      delete want.call;
      if (s.call === "read") delete want.bytes;
      if (!same(got, want)) problems.push(`${where}: got ${JSON.stringify(got)}`);
      continue;
    }
    const t = ts.get(s.party);
    if (!t) return [...problems, `${where}: no transport`];
    if (s.call === "send") {
      try {
        const r = t.send(fromHex(s.plaintext));
        got = r.ok ? { bytes: toHex(r.message) } : { fails: r.reason };
      } catch {
        got = { throws: true };
      }
    } else {
      const r = t.receive(fromHex(s.bytes));
      got = r.ok ? { plaintext: toHex(r.plaintext) } : { fails: r.reason };
      if (r.ok && !t.confirmed) problems.push(`${where}: not confirmed after a message decrypted`);
    }
    const want: Record<string, unknown> = { ...s };
    delete want.party;
    delete want.call;
    if (s.call === "send") delete want.plaintext;
    else delete want.bytes;
    if (!same(got, want)) problems.push(`${where}: got ${JSON.stringify(got).slice(0, 200)}`);
  }
  return problems;
}
