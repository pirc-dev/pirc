// Builds cases/e2e/objects.json from fixed seeds: every signed object's
// exact bytes, what the list's checks decide, a bundle and what each
// device unwraps from it, frames, an envelope, labels and a whole join.
// Every key and every random value is fixed here, and WebCrypto's Ed25519
// is deterministic, so building again gives the same file
// (objects.test.ts checks that). Other languages read the file: they
// encode each body from its JSON and must get the same bytes, verify each
// signature (a randomized signer's are not the same bytes), and decide
// each check alike.

import { create, fromBinary, toBinary, toJson, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { SessionRefSchema } from "@pirc/protocol";
import {
  BundleBodySchema,
  DeviceRole,
  Direction,
  FrameKind,
  JoinApprovalSchema,
  JoinDeviceSchema,
  JoinResultSchema,
  LabelKeyRefSchema,
  LabelsSchema,
  VersionRefSchema,
  type SignedObject,
} from "@pirc/protocol/v1alpha2";
import { framed, hex, utf8 } from "../bytes.ts";
import * as cp from "../cpace.ts";
import * as ed25519 from "../ed25519.ts";
import * as hpke from "../hpke.ts";
import * as join from "../join.ts";
import * as keys from "../keys.ts";
import * as list from "../list.ts";
import { KINDS, encode, hash, sign, type Kind } from "../objects.ts";

const seedOf = (label: string) => hpke.sha256(utf8(`pirc-e2e cases: ${label}`));

/** A fixed source of "random" bytes, in order. */
function fixedRandom(label: string) {
  let n = 0;
  return async (len: number) => (await hpke.sha512(utf8(`pirc-e2e cases: ${label} ${n++}`))).slice(0, len);
}

const NOW = 1795521600000n; // 2026-11-18T12:00:00Z
const ts = (ms: bigint) => timestampFromMs(Number(ms));
const DAY = 24n * 3600n * 1000n;

type Dev = { name: string; role: DeviceRole; signer: ed25519.Signer; seed: Uint8Array; preKey?: hpke.X25519Pair; preKeyPrivate?: Uint8Array };

export async function build() {
  const out: Record<string, unknown> = {
    about:
      "The hosted relay's signed objects, from fixed seeds (crypto/test/objects.ts; docs/e2e.md, sections 2 to 5). " +
      "Each object has its body as JSON (Protocol Buffers' JSON form) and as the bytes that were signed: a runner encodes the JSON and must get those bytes, " +
      "verifies the signature (and may make its own, which need not be the same bytes), and decides every check as `valid` says. Times are ms since 1970.",
    now_ms: String(NOW),
  };

  // --- devices ---
  const devs: Record<string, Dev> = {};
  for (const [name, role] of [
    ["phone", DeviceRole.CLIENT],
    ["tablet", DeviceRole.CLIENT],
    ["laptop", DeviceRole.HOST],
    ["phone-read", DeviceRole.READ_ONLY],
    ["stranger", DeviceRole.CLIENT],
  ] as const) {
    const seed = await seedOf(`device ${name}`);
    const d: Dev = { name, role, seed, signer: await ed25519.fromSeed(seed) };
    if (role !== DeviceRole.HOST) {
      d.preKeyPrivate = await seedOf(`pre-key ${name}`);
      d.preKey = await hpke.x25519FromPrivate(d.preKeyPrivate);
    }
    devs[name] = d;
  }
  out.devices = Object.fromEntries(
    Object.values(devs).map((d) => [
      d.name,
      {
        role: DeviceRole[d.role],
        seed: hex(d.seed),
        public_key: hex(d.signer.publicKey),
        ...(d.preKey ? { pre_key_private: hex(d.preKeyPrivate!), pre_key: hex(d.preKey.publicKey) } : {}),
      },
    ]),
  );
  const key = (n: string) => devs[n].signer.publicKey;

  // --- framed strings, and the login's ---
  out.framed = [
    { context: "pirc-e2e-v1 list", parts: [], out: hex(framed("pirc-e2e-v1 list")) },
    { context: "x", parts: ["", "00", "ff".repeat(200)], out: hex(framed("x", new Uint8Array(0), Uint8Array.of(0), new Uint8Array(200).fill(255))) },
  ];

  // --- objects ---
  const objects: Record<string, unknown> = {};
  const signed: Record<string, SignedObject> = {};
  async function obj<K extends Kind>(name: string, kind: K, accountId: Uint8Array, by: string, init: MessageInitShape<(typeof KINDS)[K]["schema"]>, tamper?: (o: SignedObject) => void) {
    const schema = KINDS[kind].schema as DescMessage;
    const body = create(schema, init as never);
    let o: SignedObject;
    if (tamper) {
      // Signed by `by` over these bytes whatever the body says, then changed.
      const bytes = toBinary(schema, body);
      const s = devs[by].signer;
      o = { $typeName: "pirc.v1alpha2.SignedObject", body: bytes, signer: s.publicKey, signature: await s.sign(framed(`pirc-e2e-v1 ${kind}`, accountId, bytes)) };
      tamper(o);
    } else o = await sign(kind, accountId, devs[by].signer, body as never);
    signed[name] = o;
    objects[name] = {
      kind,
      account_id: hex(accountId),
      json: toJson(schema, body),
      body: hex(o.body),
      signer: hex(o.signer),
      signature: hex(o.signature),
      hash: hex(await hash(o)),
      encoded: hex(encode(o)),
    };
    return o;
  }
  const dev = (n: string, addedBy: string, at: bigint, owner?: string) => ({
    role: devs[n].role,
    publicKey: key(n),
    addedBy: addedBy ? key(addedBy) : new Uint8Array(0),
    addedAt: ts(at),
    owner: owner ? key(owner) : new Uint8Array(0),
  });
  const sorted = <T extends { publicKey: Uint8Array }>(ds: T[]) => [...ds].sort((a, b) => (hex(a.publicKey) < hex(b.publicKey) ? -1 : 1));
  const none = new Uint8Array(0);

  const t1 = NOW - 30n * DAY, t2 = NOW - 20n * DAY, t3 = NOW - 10n * DAY, t4 = NOW - DAY;
  const v1 = await obj("v1", "list", none, "phone", { number: 1n, devices: [dev("phone", "", t1)], signer: key("phone") });
  const account = await hash(v1);
  out.account_id = hex(account);
  const h = async (o: SignedObject) => hash(o);
  const v2 = await obj("v2", "list", account, "phone", { number: 2n, previous: await h(v1), devices: sorted([dev("phone", "", t1), dev("laptop", "phone", t2)]), signer: key("phone") });
  const d3 = sorted([dev("phone", "", t1), dev("laptop", "phone", t2), dev("tablet", "phone", t3), dev("phone-read", "phone", t3, "phone")]);
  const v3 = await obj("v3", "list", account, "phone", { number: 3n, previous: await h(v2), devices: d3, signer: key("phone") });
  const p3 = await h(v3);
  // Two clients change the list at once: phone removes tablet, tablet adds stranger.
  const v4a = await obj("v4a", "list", account, "phone", { number: 4n, previous: p3, devices: sorted([dev("phone", "", t1), dev("laptop", "phone", t2), dev("phone-read", "phone", t3, "phone")]), signer: key("phone") });
  const v4b = await obj("v4b", "list", account, "tablet", { number: 4n, previous: p3, devices: sorted([...d3, dev("stranger", "tablet", t4)]), signer: key("tablet") });
  await obj("w4b", "withdrawal", account, "tablet", { withdrawn: { number: 4n, hash: await h(v4b) }, winner: { number: 4n, hash: await h(v4a) }, signer: key("tablet") });
  await obj("w4b-by-phone", "withdrawal", account, "phone", { withdrawn: { number: 4n, hash: await h(v4b) }, winner: { number: 4n, hash: await h(v4a) }, signer: key("phone") });
  await obj("v5", "list", account, "phone", {
    number: 5n,
    previous: await h(v4a),
    devices: sorted([dev("phone", "", t1), dev("laptop", "phone", t2), dev("phone-read", "phone", t3, "phone"), dev("stranger", "phone", NOW)]),
    withdrawn: [await h(v4b)],
    signer: key("phone"),
  });
  // Refused after v3.
  const next = { number: 4n, previous: p3, signer: key("phone") };
  await obj("x-by-host", "list", account, "laptop", { ...next, devices: sorted([...d3, dev("stranger", "laptop", t4)]), signer: key("laptop") });
  await obj("x-by-read-only", "list", account, "phone-read", { ...next, devices: sorted([...d3, dev("stranger", "phone-read", t4)]), signer: key("phone-read") });
  await obj("x-by-stranger", "list", account, "stranger", { ...next, devices: sorted([...d3, dev("stranger", "stranger", t4)]), signer: key("stranger") });
  await obj("x-keeps-read-only", "list", account, "tablet", { ...next, devices: sorted([dev("laptop", "phone", t2), dev("tablet", "phone", t3), dev("phone-read", "phone", t3, "phone")]), signer: key("tablet") });
  await obj("x-no-client", "list", account, "phone", { ...next, devices: [dev("laptop", "phone", t2)] });
  await obj("x-skips", "list", account, "phone", { ...next, number: 5n, devices: d3 });
  await obj("x-wrong-previous", "list", account, "phone", { ...next, previous: await h(v2), devices: d3 });
  await obj("x-changes-kept", "list", account, "phone", { ...next, devices: d3.map((d) => (d.role === DeviceRole.HOST ? { ...d, role: DeviceRole.CLIENT } : d)) });
  await obj("x-added-by-other", "list", account, "phone", { ...next, devices: sorted([...d3, dev("stranger", "tablet", t4)]) });
  await obj("x-unordered", "list", account, "phone", { ...next, devices: [...sorted(d3)].reverse() });
  await obj("x-bad-signature", "list", account, "phone", { ...next, devices: d3 }, (o) => (o.signature[5] ^= 1));
  await obj("x-signer-not-body", "list", account, "phone", { ...next, devices: d3, signer: key("tablet") }, () => {});
  await obj("x-other-account", "list", new Uint8Array(32).fill(9), "phone", { ...next, devices: d3 });

  // Pre-keys, checked against v3 at now.
  const pk = (n: string, made: bigint, expires: bigint) => ({ signer: key(n), preKey: (devs[n].preKey ?? devs.phone.preKey!).publicKey, madeAt: ts(made), expiresAt: ts(expires) });
  await obj("pk-phone", "pre-key", account, "phone", pk("phone", NOW - DAY, NOW + 6n * DAY));
  await obj("pk-tablet", "pre-key", account, "tablet", pk("tablet", NOW - DAY, NOW + 13n * DAY));
  await obj("pk-phone-read", "pre-key", account, "phone-read", pk("phone-read", NOW - DAY, NOW + 13n * DAY));
  await obj("pk-x-host", "pre-key", account, "laptop", pk("laptop", NOW - DAY, NOW + 13n * DAY));
  await obj("pk-x-stranger", "pre-key", account, "stranger", pk("stranger", NOW - DAY, NOW + 13n * DAY));
  await obj("pk-14-days", "pre-key", account, "phone", pk("phone", NOW - DAY, NOW + 13n * DAY));
  await obj("pk-x-too-long", "pre-key", account, "phone", pk("phone", NOW - DAY, NOW + 13n * DAY + 1n));
  await obj("pk-x-expired", "pre-key", account, "phone", pk("phone", NOW - 15n * DAY, NOW - DAY));
  await obj("pk-x-expires-now", "pre-key", account, "phone", pk("phone", NOW - 14n * DAY, NOW));

  // --- the list's checks ---
  const checks: unknown[] = [];
  const decide = async (about: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      return { about, valid: true };
    } catch (e) {
      if (!(e instanceof list.Refused)) throw e;
      return { about, valid: false, why: e.message };
    }
  };
  const V1 = await list.checkFirst(v1);
  const V2 = await list.checkNext(account, V1, v2);
  const V3 = await list.checkNext(account, V2, v3);
  const V4a = await list.checkNext(account, V3, v4a);
  const V4b = await list.checkNext(account, V3, v4b);
  const chk = async (about: string, check: string, prev: string | null, object: string) => {
    const prevV = { v1: V1, v2: V2, v3: V3, v4a: V4a, v4b: V4b }[prev ?? ""] as list.Version | undefined;
    const r = await decide(about, async () => {
      if (check === "first") await list.checkFirst(signed[object]);
      else if (check === "next") await list.checkNext(account, prevV!, signed[object]);
      else if (check === "withdrawal") await list.checkWithdrawal(account, prevV!, signed[object]);
      else await list.checkPreKey(account, prevV!.body, signed[object], NOW);
    });
    checks.push({ check, prev, object, ...r });
  };
  await chk("version 1, signed by its one client", "first", null, "v1");
  await chk("a version that is not 1 taken as the first", "first", null, "v2");
  await chk("a host added", "next", "v1", "v2");
  await chk("a client and its read-only key added", "next", "v2", "v3");
  await chk("a client removed", "next", "v3", "v4a");
  await chk("the other branch of a fork: valid on its own", "next", "v3", "v4b");
  await chk("after the withdrawal, on the winner", "next", "v4a", "v5");
  await chk("withdrawn by its own signer", "withdrawal", "v4b", "w4b");
  await chk("withdrawn by another client", "withdrawal", "v4b", "w4b-by-phone");
  for (const [o, about] of [
    ["x-by-host", "signed by a host"],
    ["x-by-read-only", "signed by a read-only key"],
    ["x-by-stranger", "signed by a key not on the list"],
    ["x-keeps-read-only", "a client removed, its read-only key kept"],
    ["x-no-client", "no client left"],
    ["x-skips", "a number skipped"],
    ["x-wrong-previous", "chained from an older version"],
    ["x-changes-kept", "a device kept, its role changed"],
    ["x-added-by-other", "a device said to be added by another client than the signer"],
    ["x-unordered", "devices out of order"],
    ["x-bad-signature", "a signature that does not check"],
    ["x-signer-not-body", "signed by one client, the body naming another"],
    ["x-other-account", "signed for another account"],
  ]) await chk(about, "next", "v3", o);
  for (const [o, about] of [
    ["pk-phone", "a client's"],
    ["pk-14-days", "made to last 14 days exactly"],
    ["pk-phone-read", "a read-only key's"],
    ["pk-x-host", "a host's"],
    ["pk-x-stranger", "a device's not on the list"],
    ["pk-x-too-long", "made to last 14 days and a moment"],
    ["pk-x-expired", "expired"],
    ["pk-x-expires-now", "expiring this millisecond"],
  ]) await chk(about, "pre-key", "v3", o);
  out.checks = checks;

  // --- a process's keys, and its bundle on v3 ---
  const hostKey = key("laptop");
  const secret = await seedOf("laptop's secret of the day");
  const keyId = (await seedOf("laptop's key ID")).slice(0, 16);
  const sk = await keys.sendingKeys(secret, keyId, account, hostKey);
  out.sending_keys = { secret: hex(secret), key_id: hex(keyId), host_key: hex(hostKey), announcement: hex(sk.announcement), conversation: hex(sk.conversation) };
  const reqPrivate = await seedOf("laptop's request key");
  const requestKey = await hpke.x25519FromPrivate(reqPrivate);
  const eph = fixedRandom("ephemeral");
  const ephemerals: string[] = [];
  const nextEphemeral = async () => {
    const e = await eph(32);
    ephemerals.push(hex(e));
    return hpke.x25519FromPrivate(e);
  };
  const preKeys = ["phone", "tablet", "phone-read"].map((n) => ({ publicKey: key(n), preKey: devs[n].preKey!.publicKey }));
  const recipients = await keys.wrapFor(V3.body, preKeys, sk, { accountId: account, hostKey, keyId }, nextEphemeral);
  const session = create(SessionRefSchema, { hostKey, sessionId: "019a8f2e-7c41-7d2b-9b6e-3f5c2a1d0e4f", instanceId: "4f7a9c2e" });
  const bundle = await obj("bundle", "bundle", account, "laptop", { hostKey, instanceId: session.instanceId, keyId, madeAt: ts(NOW - 3600_000n), listVersion: { number: 3n, hash: p3 }, requestKey: requestKey.publicKey, recipients });
  out.bundle = {
    object: "bundle",
    list: "v3",
    request_key_private: hex(reqPrivate),
    ephemerals: [...ephemerals],
    unwraps: await Promise.all(
      ["phone", "tablet", "phone-read"].map(async (n) => {
        const got = await keys.unwrap(account, fromBinary(BundleBodySchema, bundle.body), V3.body, { publicKey: key(n), preKey: devs[n].preKey! });
        return { device: n, announcement: got ? hex(got.announcement) : null, conversation: got?.conversation ? hex(got.conversation) : null };
      }),
    ),
  };

  // --- refused whatever its signature: a string that is not UTF-8 ---
  // The bundle's body with its instance ID's last two bytes made 0xff 0xfe,
  // the same length, then signed: every decoder must refuse it (Go's and
  // TypeScript's do as they decode; the Dart and the Swift check).
  const okBody = toBinary(BundleBodySchema, fromBinary(BundleBodySchema, bundle.body));
  const id = utf8(session.instanceId);
  const idAt = okBody.findIndex((_, i) => id.every((b, j) => okBody[i + j] === b));
  const badBody = okBody.slice();
  badBody[idAt + id.length - 2] = 0xff;
  badBody[idAt + id.length - 1] = 0xfe;
  const laptop = devs.laptop.signer;
  const notUtf8: SignedObject = {
    $typeName: "pirc.v1alpha2.SignedObject",
    body: badBody,
    signer: laptop.publicKey,
    signature: await laptop.sign(framed("pirc-e2e-v1 bundle", account, badBody)),
  };
  // The same, its instance ID's key (field 2, bytes, 0x12) written as a
  // five-byte varint over 32 bits: Go's and TypeScript's decoders refuse
  // the key, Dart's keeps its low 32 bits and reads the instance ID, which
  // its check must not take for another field and skip.
  if (badBody[idAt - 2] !== 0x12) throw new Error("the instance ID's key is not where it was");
  const longKeyBody = new Uint8Array([...badBody.subarray(0, idAt - 2), 0x92, 0x80, 0x80, 0x80, 0x10, ...badBody.subarray(idAt - 1)]);
  const longKey: SignedObject = {
    $typeName: "pirc.v1alpha2.SignedObject",
    body: longKeyBody,
    signer: laptop.publicKey,
    signature: await laptop.sign(framed("pirc-e2e-v1 bundle", account, longKeyBody)),
  };
  out.refused = [
    { about: "a bundle whose instance ID is not valid UTF-8, signed by its host", kind: "bundle", account_id: hex(account), encoded: hex(encode(notUtf8)), why: "a string that is not valid UTF-8" },
    { about: "the same, its instance ID's key written as a varint over 32 bits", kind: "bundle", account_id: hex(account), encoded: hex(encode(longKey)), why: "a field key over 32 bits, and a string that is not valid UTF-8" },
  ];

  // --- frames ---
  const sessionJson = toJson(SessionRefSchema, session);
  const announcement = await obj("announcement", "announcement", account, "laptop", {
    session,
    keyId,
    listVersion: { number: 3n, hash: p3 },
    madeAt: ts(NOW - 60_000n),
    announcement: utf8("an encoded SessionAnnouncement"),
  });
  const frames = [];
  const at = (kind: FrameKind, recipient: Uint8Array, counter: bigint): keys.FrameAt => ({ accountId: account, keyId, session, kind, recipient, listVersion: 3n, counter });
  for (const [about, k, f, pt] of [
    ["the stored announcement", sk.announcement, at(FrameKind.ANNOUNCEMENT, none, 0n), encode(announcement)],
    ["a broadcast", sk.conversation, at(FrameKind.BROADCAST, none, 1n), utf8("an encoded SessionMessage, to every attached client")],
    ["an answer to phone", sk.conversation, at(FrameKind.ANSWER, key("phone"), 2n), utf8("an encoded SessionMessage, to phone")],
  ] as const) {
    frames.push({ about, key: k === sk.announcement ? "announcement" : "conversation", kind: FrameKind[f.kind], recipient: hex(f.recipient), list_version: String(f.listVersion), counter: String(f.counter), aad: hex(keys.frameAad(f)), plaintext: hex(pt), ciphertext: hex(await keys.sealFrame(k, f, pt)) });
  }
  out.frames = { session: sessionJson, frames };

  // --- an envelope from phone, to the laptop's request key ---
  const envelope = await obj("envelope", "request", account, "phone", {
    session,
    keyId,
    direction: Direction.CLIENT_TO_HOST,
    sentAt: ts(NOW),
    counter: 1n,
    listVersion: { number: 3n, hash: p3 },
    request: utf8("an encoded SessionMessage, a prompt"),
    signer: key("phone"),
  });
  const envEph = await eph(32);
  out.envelope = { object: "envelope", ephemeral: hex(envEph), sealed: hex(await keys.sealEnvelope(requestKey.publicKey, account, hostKey, keyId, encode(envelope), await hpke.x25519FromPrivate(envEph))) };

  // --- labels: the label key made with version 1, a record, and wraps ---
  const labelKey = await seedOf("label key of version 1");
  const ref = create(LabelKeyRefSchema, { version: create(VersionRefSchema, { number: 1n, hash: account }) });
  const labels = create(LabelsSchema, { labels: [{ publicKey: key("phone"), label: "Pixel 9" }, { publicKey: key("tablet"), label: "iPad" }, { publicKey: hostKey, label: "laptop" }] });
  const labelNonce = (await seedOf("label nonce")).slice(0, 12);
  const sealedLabels = await keys.sealLabels(labelKey, account, ref, 3n, labels, labelNonce);
  await obj("labels", "labels", account, "phone", { labelKey: ref, counter: 3n, listVersion: { number: 3n, hash: p3 }, sealed: sealedLabels, signer: key("phone") });
  const wraps = [];
  for (const n of ["tablet", "phone-read"]) {
    const e = await eph(32);
    const wrap = await keys.wrapLabelKey(devs[n].preKey!.publicKey, account, ref, key(n), labelKey, await hpke.x25519FromPrivate(e));
    await obj(`label-key-${n}`, "label-key", account, "phone", { labelKey: ref, recipient: key(n), preKey: devs[n].preKey!.publicKey, wrap, signer: key("phone") });
    wraps.push({ object: `label-key-${n}`, device: n, ephemeral: hex(e) });
  }
  out.labels = { label_key: hex(labelKey), object: "labels", labels: toJson(LabelsSchema, labels), nonce: hex(labelNonce), wraps };

  // --- a join: a new host shows K7QM-2XRP9, phone types it ---
  const origin = "wss://relay.example";
  const code = { lookup: "K7QM", secret: "2XRP9" };
  const ci = join.channelId(origin, code.lookup);
  const nonce = (await seedOf("join nonce")).slice(0, 16);
  const ya = await seedOf("join device scalar");
  const yb = await seedOf("join client scalar");
  const prs = utf8(code.secret);
  const dParty = await cp.start(join.env, { prs, ci, sid: nonce, ad: none, y: ya });
  const cParty = await cp.start(join.env, { prs, ci, sid: nonce, ad: none, y: yb });
  const iskC = (await cp.finish(join.env, cParty, "responder", dParty.Y, none)).isk;
  const iskD = (await cp.finish(join.env, dParty, "initiator", cParty.Y, none)).isk;
  if (hex(iskC) !== hex(iskD)) throw new Error("CPace keys differ");
  const jk = await join.keys(iskD, ci, nonce, dParty.Y, cParty.Y);
  const clientConfirmation = await join.confirmation(jk.clientConfirm, jk.transcript);
  const deviceConfirmation = await join.confirmation(jk.deviceConfirm, jk.transcript);
  const dCh = join.deviceChannel(jk), cCh = join.clientChannel(jk);
  const newSeed = await seedOf("device new laptop");
  devs["new-laptop"] = { name: "new-laptop", role: DeviceRole.HOST, seed: newSeed, signer: await ed25519.fromSeed(newSeed) };
  const deviceBody = await obj("join-device", "join", none, "new-laptop", { transcript: dCh.transcript, role: DeviceRole.HOST, publicKey: key("new-laptop"), name: "build box" });
  const devicePlain = toBinary(JoinDeviceSchema, create(JoinDeviceSchema, { device: deviceBody }));
  const deviceSealed = await dCh.seal(devicePlain);
  if (!(await cCh.open(deviceSealed))) throw new Error("the client cannot open the device's message");
  const v4join = await obj("v4-join", "list", account, "phone", { number: 4n, previous: p3, devices: sorted([...d3, dev("new-laptop", "phone", NOW)]), signer: key("phone") });
  const result = create(JoinResultSchema, { result: { case: "approval", value: create(JoinApprovalSchema, { accountId: account, version: v4join, approver: key("phone") }) } });
  const resultPlain = toBinary(JoinResultSchema, result);
  const resultSealed = await cCh.seal(resultPlain);
  if (!(await dCh.open(resultSealed))) throw new Error("the device cannot open the approval");
  out.join = {
    origin,
    code: "K7QM-2XRP9",
    lookup: code.lookup,
    secret: code.secret,
    channel_id: hex(ci),
    nonce: hex(nonce),
    device_scalar: hex(ya),
    client_scalar: hex(yb),
    device_share: hex(dParty.Y),
    client_share: hex(cParty.Y),
    isk: hex(iskD),
    transcript: hex(jk.transcript),
    keys: { device_confirm: hex(jk.deviceConfirm), client_confirm: hex(jk.clientConfirm), device_seal: hex(jk.deviceSeal), client_seal: hex(jk.clientSeal) },
    client_confirmation: hex(clientConfirmation),
    device_confirmation: hex(deviceConfirmation),
    new_device: { seed: hex(newSeed), public_key: hex(key("new-laptop")) },
    device_message: { object: "join-device", plaintext: hex(devicePlain), sealed: hex(deviceSealed) },
    approval: { version: "v4-join", plaintext: hex(resultPlain), sealed: hex(resultSealed) },
    transcript_after: hex(dCh.transcript),
  };
  out.objects = objects;
  return out;
}
