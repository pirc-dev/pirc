// Exchanges of a hosted account's client (cases/exchanges/hosted/*.json):
// v1alpha2's frames in from the relay, the v1alpha1 frames given to
// web/core's Client (opened), and the v1alpha2 frames sent (sealed). The
// account is fixed: cases/e2e/objects.json's phone, its pre-key and chain,
// so every byte is the same each time; the app's Dart is held to the same
// files.
//
// build() makes the files from objects.json; run() plays a file's inputs
// and returns what the checks must be, which hosted-exchanges.test.ts
// compares with the file.
import { create, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { readFileSync } from "node:fs";

import { FrameSchema as Frame1Schema, SessionMessageSchema, SessionRefSchema, type Frame as Frame1 } from "@pirc/protocol";
import { FrameKind, FrameSchema, SignedObjectSchema, type Frame } from "@pirc/protocol/v1alpha2";
import { hex, unhex } from "@pirc/crypto/bytes";
import { Chain } from "@pirc/crypto/chain";
import * as ed25519 from "@pirc/crypto/ed25519";
import * as hpke from "@pirc/crypto/hpke";
import * as keys from "@pirc/crypto/keys";
import { decode } from "@pirc/crypto/objects";

import { Sessions, type SessionsAccount } from "../core/hosted/sessions.ts";
import { MemoryStore } from "../core/hosted/store.ts";

const OBJECTS = new URL("../../cases/e2e/objects.json", import.meta.url);
const objects = JSON.parse(readFileSync(OBJECTS, "utf8"));

export type Fixture = { me: string; list: string[]; labels: Record<string, string>; ephemerals: string[] };
export type Step =
  | { now: string }
  | { in: JsonValue }
  | { send: JsonValue }
  | { out: JsonValue[] }
  | { sent: JsonValue[] };
export type ExchangeFile = { about: string; fixture: Fixture; steps: Step[] };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** Plays a file's inputs; returns the steps with the checks as the code makes them. */
export async function run(file: ExchangeFile): Promise<Step[]> {
  const f = file.fixture;
  const dev = objects.devices[f.me];
  const signer = await ed25519.fromSeed(unhex(dev.seed));
  const preKey = await hpke.x25519FromPrivate(unhex(dev.pre_key_private));
  const [v1, ...rest] = f.list.map((n) => decode(unhex(objects.objects[n].encoded)));
  const chain = await Chain.start(v1, unhex(objects.account_id));
  await chain.add(rest);
  let now = Number(objects.now_ms);
  const out: Frame1[] = [];
  const sent: Frame[] = [];
  const ephemerals = [...f.ephemerals];
  const account: SessionsAccount = {
    accountId: chain.accountId,
    get latest() {
      return chain.latest;
    },
    list: chain,
    publicKey: signer.publicKey,
    signer,
    myPreKeys: () => [preKey],
    label: (k) => f.labels[hex(k)],
    send2: (body) => {
      sent.push(create(FrameSchema, { body } as never));
      return true;
    },
  };
  const s = new Sessions(account, new MemoryStore(), (x) => out.push(x), () => {}, {
    now: () => now,
    ephemeral: async () => hpke.x25519FromPrivate(unhex(ephemerals.shift() ?? "")),
  });
  s.onState({ kind: "ready", welcome: {} as never });
  const steps: Step[] = [];
  for (const step of file.steps) {
    if ("now" in step) {
      now = Number(step.now);
      steps.push(step);
    } else if ("in" in step) {
      s.onFrame(fromJson(FrameSchema, step.in));
      await s.settled();
      steps.push(step);
    } else if ("send" in step) {
      s.send(fromJson(Frame1Schema, step.send));
      await s.settled();
      steps.push(step);
    } else if ("out" in step) {
      steps.push({ out: out.splice(0).map((x) => toJson(Frame1Schema, x)) });
    } else if ("sent" in step) {
      steps.push({ sent: sent.splice(0).map((x) => toJson(FrameSchema, x)) });
    }
  }
  return steps;
}

/** The files, from objects.json, with their checks recorded by run(). */
export async function build(): Promise<Record<string, ExchangeFile>> {
  const sk = objects.sending_keys;
  const session = objects.frames.session;
  const fr = objects.frames.frames;
  const bundle = toJson(SignedObjectSchema, decode(unhex(objects.objects.bundle.encoded)));
  const keysOf = (counter: string) => ({ keyId: b64(unhex(sk.key_id)), counter, listVersion: "3" });
  const entry = { session, keys: keysOf(fr[0].counter), payload: b64(unhex(fr[0].ciphertext)), announcedAt: new Date(Number(objects.now_ms)).toISOString(), bundles: [bundle] };
  const routed = (i: number, over: Record<string, unknown> = {}) => ({ routed: { session, clientKey: fr[i].recipient ? b64(unhex(fr[i].recipient)) : "", keys: keysOf(fr[i].counter), payload: b64(unhex(fr[i].ciphertext)), ...over } });
  // A broadcast at counter 3, sealed here: the bundle's 26 hours pass first.
  const ref = fromJson(SessionRefSchema, session);
  const late = await keys.sealFrame(unhex(sk.conversation), { accountId: unhex(objects.account_id), keyId: unhex(sk.key_id), session: ref, kind: FrameKind.BROADCAST, recipient: new Uint8Array(0), listVersion: 3n, counter: 3n }, unhex(fr[1].plaintext));
  const request = toBinary(SessionMessageSchema, create(SessionMessageSchema, { body: { case: "prompt", value: { requestId: "id-1", text: "hello" } } }));
  const labels = { [objects.devices.laptop.public_key]: "laptop" };
  const ephemerals = [hex((await hpke.sha256(new TextEncoder().encode("pirc-e2e cases: exchange ephemeral 1"))))];
  const files: Record<string, ExchangeFile> = {
    "sessions.json": {
      about:
        "A hosted account's phone (cases/e2e/objects.json, list at version 3): the session list's sealed announcement opened under the bundle it came with; " +
        "the stored announcement again with its counter; a broadcast and an answer to this phone opened; a replay, an answer moved to another client and a frame with a counter it was not sealed with, dropped; " +
        "a request in its envelope, sealed to the bundle's request key; and nothing read under a bundle past its 26 hours.",
      fixture: { me: "phone", list: ["v1", "v2", "v3"], labels, ephemerals },
      steps: [
        { in: { sessionList: { sessions: [entry] } } },
        { out: [] },
        { in: { sessionUpdated: { entry } } },
        { out: [] },
        { in: routed(1) },
        { in: routed(1) },
        { in: routed(2) },
        { in: routed(2, { clientKey: b64(unhex(objects.devices.tablet.public_key)) }) },
        { in: routed(1, { keys: keysOf("5") }) },
        { out: [] },
        { send: { routed: { session, payload: b64(request) } } },
        { sent: [] },
        { now: String(Number(objects.now_ms) + 27 * 3600_000) },
        { in: { routed: { session, keys: keysOf("3"), payload: b64(late) } } },
        { out: [] },
      ],
    },
    "off-the-list.json": {
      about: "The same bundle once the phone's list is at version 4a, which removes the tablet the bundle wraps for: every recipient must be on the list, so the phone reads nothing under it.",
      fixture: { me: "phone", list: ["v1", "v2", "v3", "v4a"], labels, ephemerals: [] },
      steps: [{ in: { sessionList: { sessions: [entry] } } }, { out: [] }],
    },
  };
  for (const f of Object.values(files)) f.steps = await run(f);
  return files;
}
