// cases/e2e/objects.json, read as another language's runner reads it:
// every body encoded from its JSON to the same bytes, every signature and
// check decided as the file says, and every seal opened. And the file is
// what objects.ts builds now, so it cannot drift from the code.

import { fromBinary, fromJson, toBinary, type DescMessage } from "@bufbuild/protobuf";
import { SessionRefSchema } from "@pirc/protocol";
import { BundleBodySchema, FrameKind, JoinDeviceSchema, JoinResultSchema, LabelsSchema, type SignedObject } from "@pirc/protocol/v1alpha2";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { framed, hex, unhex, utf8 } from "../bytes.ts";
import * as ed25519 from "../ed25519.ts";
import * as cp from "../cpace.ts";
import * as hpke from "../hpke.ts";
import * as join from "../join.ts";
import * as keys from "../keys.ts";
import * as list from "../list.ts";
import { KINDS, decode, hash, open, type Kind } from "../objects.ts";
import { build } from "./objects.ts";

const file = JSON.parse(readFileSync(new URL("../../cases/e2e/objects.json", import.meta.url), "utf8"));
const account = unhex(file.account_id);
const now = BigInt(file.now_ms);
const obj = (name: string): SignedObject => decode(unhex(file.objects[name].encoded));

test("the file is what objects.ts builds", async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(await build())), file);
});

test("framed strings", () => {
  for (const f of file.framed) assert.equal(hex(framed(f.context, ...f.parts.map(unhex))), f.out);
});

test("every body encodes from its JSON to the signed bytes, and every hash", async () => {
  for (const [name, o] of Object.entries(file.objects) as [string, { kind: Kind; json: unknown; body: string; hash: string }][]) {
    const schema = KINDS[o.kind].schema as DescMessage;
    assert.equal(hex(toBinary(schema, fromJson(schema, o.json as never))), o.body, name);
    assert.equal(hex(await hash(obj(name))), o.hash, name);
  }
});

test("every check decided as the file says", async () => {
  const v = async (name: string, prev?: list.Version) => (name === "v1" ? list.checkFirst(obj(name)) : list.checkNext(account, prev!, obj(name)));
  const V: Record<string, list.Version> = {};
  V.v1 = await v("v1");
  V.v2 = await v("v2", V.v1);
  V.v3 = await v("v3", V.v2);
  V.v4a = await v("v4a", V.v3);
  V.v4b = await v("v4b", V.v3);
  for (const c of file.checks) {
    let valid = true;
    try {
      const o = obj(c.object);
      if (c.check === "first") await list.checkFirst(o);
      else if (c.check === "next") await list.checkNext(account, V[c.prev], o);
      else if (c.check === "withdrawal") await list.checkWithdrawal(account, V[c.prev], o);
      else await list.checkPreKey(account, V[c.prev].body, o, now);
    } catch (e) {
      if (!(e instanceof list.Refused)) throw e;
      valid = false;
    }
    assert.equal(valid, c.valid, c.about);
  }
  assert.equal(hex(V.v1.hash), file.account_id);
});

test("every object in refused is refused, though its signature checks", async () => {
  assert.ok(file.refused.length > 0);
  for (const r of file.refused) {
    const o = decode(unhex(r.encoded));
    assert.ok(await ed25519.verify(o.signer, framed(`pirc-e2e-v1 ${r.kind}`, unhex(r.account_id), o.body), o.signature), `${r.about}: its signature checks`);
    assert.equal(await open(r.kind, unhex(r.account_id), o), null, r.about);
  }
});

const dev = (n: string) => file.devices[n];
const preKeyOf = (n: string) => hpke.x25519FromPrivate(unhex(dev(n).pre_key_private));

test("the sending keys, and what each device unwraps from the bundle", async () => {
  const s = file.sending_keys;
  const sk = await keys.sendingKeys(unhex(s.secret), unhex(s.key_id), account, unhex(s.host_key));
  assert.equal(hex(sk.announcement), s.announcement);
  assert.equal(hex(sk.conversation), s.conversation);
  const b = await open("bundle", account, obj("bundle"));
  assert.ok(b);
  const V3 = await list.checkNext(account, await list.checkNext(account, await list.checkFirst(obj("v1")), obj("v2")), obj("v3"));
  for (const u of file.bundle.unwraps) {
    const got = await keys.unwrap(account, b, V3.body, { publicKey: unhex(dev(u.device).public_key), preKey: await preKeyOf(u.device) });
    assert.equal(got && hex(got.announcement), u.announcement, u.device);
    assert.equal(got?.conversation ? hex(got.conversation) : null, u.conversation, u.device);
  }
  // A read-only key's wrap holds the announcement key and nothing else.
  const read = b.recipients.find((r) => hex(r.publicKey) === dev("phone-read").public_key)!;
  assert.equal(read.conversationKey.length, 0);
  // A bundle naming a device off the list gives nobody anything.
  const V4a = await list.checkNext(account, V3, obj("v4a"));
  const phone = { publicKey: unhex(dev("phone").public_key), preKey: await preKeyOf("phone") };
  assert.equal(await keys.unwrap(account, b, V4a.body, phone), null);
  assert.ok(fromBinary(BundleBodySchema, obj("bundle").body));
});

test("frames open only where they were sealed", async () => {
  const session = fromJson(SessionRefSchema, file.frames.session);
  const s = file.sending_keys;
  for (const f of file.frames.frames) {
    const k = unhex(f.key === "announcement" ? s.announcement : s.conversation);
    const at: keys.FrameAt = { accountId: account, keyId: unhex(s.key_id), session, kind: FrameKind[f.kind as keyof typeof FrameKind], recipient: unhex(f.recipient), listVersion: BigInt(f.list_version), counter: BigInt(f.counter) };
    assert.equal(hex(keys.frameAad(at)), f.aad, f.about);
    assert.equal(hex((await keys.openFrame(k, at, unhex(f.ciphertext)))!), f.plaintext, f.about);
    // Moved to another session, another client, another kind or counter: it fails.
    for (const moved of [
      { ...at, session: { ...session, sessionId: "another" } },
      { ...at, recipient: f.recipient ? new Uint8Array(0) : unhex(dev("tablet").public_key) },
      { ...at, kind: at.kind === FrameKind.BROADCAST ? FrameKind.ANSWER : FrameKind.BROADCAST },
      { ...at, counter: at.counter + 1n },
      { ...at, listVersion: at.listVersion + 1n },
    ])
      assert.equal(await keys.openFrame(k, moved, unhex(f.ciphertext)), null, f.about);
  }
  const ann = file.frames.frames[0];
  assert.ok(await open("announcement", account, decode(unhex(ann.plaintext))));
});

test("the envelope opens with the request key, and is the phone's", async () => {
  const s = file.sending_keys;
  const rk = await hpke.x25519FromPrivate(unhex(file.bundle.request_key_private));
  const plain = await keys.openEnvelope(rk, account, unhex(s.host_key), unhex(s.key_id), unhex(file.envelope.sealed));
  assert.equal(hex(plain!), file.objects.envelope.encoded);
  const e = await open("request", account, decode(plain!));
  assert.equal(hex(e!.signer), dev("phone").public_key);
  assert.equal(await keys.openEnvelope(rk, account, unhex(s.host_key), new Uint8Array(16), unhex(file.envelope.sealed)), null);
});

test("labels and the label key's wraps", async () => {
  const l = file.labels;
  const rec = (await open("labels", account, obj(l.object)))!;
  const got = await keys.openLabels(unhex(l.label_key), account, rec.labelKey!, rec.counter, rec.sealed);
  assert.deepEqual(got, fromJson(LabelsSchema, l.labels));
  for (const w of l.wraps) {
    const body = (await open("label-key", account, obj(w.object)))!;
    assert.equal(hex((await keys.unwrapLabelKey(await preKeyOf(w.device), account, body.labelKey!, unhex(dev(w.device).public_key), body.wrap))!), l.label_key);
    // Not for another device.
    assert.equal(await keys.unwrapLabelKey(await preKeyOf("phone"), account, body.labelKey!, unhex(dev("phone").public_key), body.wrap), null);
  }
});

test("a join, step by step", async () => {
  const j = file.join;
  assert.deepEqual(join.readCode("k7qm 2xrp9"), { lookup: j.lookup, secret: j.secret });
  assert.deepEqual(join.readCode("K7QM-2XRPU"), null);
  assert.equal(hex(join.channelId(j.origin, j.lookup)), j.channel_id);
  const prs = utf8(j.secret), ci = unhex(j.channel_id), sid = unhex(j.nonce), none = new Uint8Array(0);
  const d = await cp.start(join.env, { prs, ci, sid, ad: none, y: unhex(j.device_scalar) });
  const c = await cp.start(join.env, { prs, ci, sid, ad: none, y: unhex(j.client_scalar) });
  assert.equal(hex(d.Y), j.device_share);
  assert.equal(hex(c.Y), j.client_share);
  const isk = (await cp.finish(join.env, c, "responder", d.Y, none)).isk;
  assert.equal(hex(isk), j.isk);
  const k = await join.keys(isk, ci, sid, d.Y, c.Y);
  assert.equal(hex(k.transcript), j.transcript);
  assert.deepEqual({ device_confirm: hex(k.deviceConfirm), client_confirm: hex(k.clientConfirm), device_seal: hex(k.deviceSeal), client_seal: hex(k.clientSeal) }, j.keys);
  assert.ok(await join.confirmed(k.clientConfirm, k.transcript, unhex(j.client_confirmation)));
  assert.ok(await join.confirmed(k.deviceConfirm, k.transcript, unhex(j.device_confirmation)));
  assert.ok(!(await join.confirmed(k.deviceConfirm, k.transcript, unhex(j.client_confirmation))));
  const ch = join.clientChannel(k);
  const devicePlain = (await ch.open(unhex(j.device_message.sealed)))!;
  assert.equal(hex(devicePlain), j.device_message.plaintext);
  const signedDevice = fromBinary(JoinDeviceSchema, devicePlain).device!;
  const body = (await open("join", none, signedDevice))!;
  assert.equal(hex(body.transcript), j.transcript);
  assert.equal(hex(await ch.seal(unhex(j.approval.plaintext))), j.approval.sealed);
  assert.equal(hex(ch.transcript), j.transcript_after);
  assert.equal(fromBinary(JoinResultSchema, unhex(j.approval.plaintext)).result.case, "approval");
  // A wrong code: CPace's keys differ, and the confirmation fails.
  const wrong = await cp.start(join.env, { prs: utf8("2XRP8"), ci, sid, ad: none, y: unhex(j.client_scalar) });
  const iskWrong = (await cp.finish(join.env, wrong, "responder", d.Y, none)).isk;
  const kw = await join.keys(iskWrong, ci, sid, d.Y, wrong.Y);
  assert.ok(!(await join.confirmed(k.clientConfirm, k.transcript, await join.confirmation(kw.clientConfirm, kw.transcript))));
});
