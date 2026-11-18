// A hosted account end to end, without pi: a phone (web/core/hosted) signs
// up on the Go relay's hosted mode, a host joins with the code /pirc join
// shows (extension/src/hosted), and the phone reads the host's
// announcement, sends it a request and gets the answer, all sealed; then
// removes the host, which stops serving and forgets the account.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { after, test } from "node:test";

import { FrameSchema as Frame1Schema, SessionAnnouncementSchema, SessionMessageSchema, type Frame as Frame1 } from "@pirc/protocol";
import { DeviceRole } from "@pirc/protocol/v1alpha2";
import { wsSocket } from "@pirc/relay-client/hosted-ws";
import * as ed25519 from "@pirc/crypto/ed25519";
import { equal } from "@pirc/crypto/bytes";

import { Anchor, type AnchorState } from "../../extension/src/hosted/anchor.ts";
import { join } from "../../extension/src/hosted/join.ts";
import { HostedTransport } from "../../extension/src/hosted/transport.ts";
import { HostedClient, type AccountEvent } from "../core/hosted/account.ts";
import { MemoryStore } from "../core/hosted/store.ts";
import { Harness, startHostedRelay } from "../../test/harness.ts";

const h = new Harness();
// Connections stopped before the relay goes, or they keep retrying.
const stops: (() => void)[] = [];
after(async () => {
  for (const s of stops) s();
  await h.close();
});
const relay = await startHostedRelay(h);

// Waits until find gives something truthy, and returns it.
async function until<T>(what: string, find: () => T | undefined | false | "", ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = find();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a phone signs up, a host joins by its code, and they talk sealed", async () => {
  // --- the phone ---
  const phoneFrames: Frame1[] = [];
  const phoneEvents: AccountEvent[] = [];
  const phone = await HostedClient.signUp(
    { origin: relay.origin, open: wsSocket, store: new MemoryStore(), signer: await ed25519.generate(), name: "Pixel 9", onFrame: (f) => phoneFrames.push(f), onEvent: (e) => phoneEvents.push(e) },
    { $typeName: "pirc.v1alpha2.Attestation", kind: { case: "test", value: new Uint8Array([1]) }, subscription: "" },
  );
  phone.start();
  stops.push(() => phone.stop());
  await until("the phone's pre-key", () => phone.myPreKeys().length > 0);
  await phone.nameSelf();
  assert.equal(phone.label(phone.publicKey), "Pixel 9");

  // --- the host joins ---
  const hostKey = await ed25519.generate();
  const anchorDir = pathJoin(mkdtempSync(pathJoin(tmpdir(), "pirc-anchor-")), "hosted");
  let shown = "";
  const j = join({ origin: relay.origin, signer: hostKey, name: "build box", log: () => {}, anchorDir, onCode: (s) => (shown = s) });
  stops.push(() => j.cancel());
  j.done.catch(() => {});
  await until("the code", () => shown);
  assert.match(shown, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{5}$/);
  let asked: { role: DeviceRole; name: string } | undefined;
  const outcome = await phone.join(shown.toLowerCase(), async (d) => {
    asked = d;
    return true;
  });
  assert.ok("joined" in outcome);
  assert.equal(asked?.role, DeviceRole.HOST);
  assert.equal(asked?.name, "build box");
  const joined = await j.done;
  assert.equal(joined.approverName, "Pixel 9");
  assert.equal(joined.anchor.latest.body.number, 2n);
  assert.ok(phoneEvents.some((e) => e.type === "added" && equal(e.device.publicKey, hostKey.publicKey)), "the addition is shown");
  await until("the host's name in the labels", () => phone.label(hostKey.publicKey) === "build box");
  // A second try with the same code fails: the lookup paired once.
  await assert.rejects(phone.join(shown, async () => true));

  // --- the host serves ---
  const anchor = (await Anchor.read(anchorDir))!;
  const hostFrames: Frame1[] = [];
  const anchorStates: AnchorState[] = [];
  let hostReady = false;
  const transport = new HostedTransport(
    { anchor, signer: hostKey, instanceId: "inst-1" },
    { onFrame: (f) => hostFrames.push(f), onState: (s) => (hostReady = s.kind === "ready"), onAnchor: (s) => anchorStates.push(s), log: () => {}, fail: (w, e) => console.error(w, e) },
  );
  transport.start();
  stops.push(() => transport.stop());
  await until("the host ready, its bundle taken", () => hostReady);
  const ref = { $typeName: "pirc.v1alpha1.SessionRef" as const, hostKey: hostKey.publicKey, sessionId: "s-1", instanceId: "inst-1" };
  const announcement = toBinary(SessionAnnouncementSchema, create(SessionAnnouncementSchema, { name: "fixing the build" }));
  assert.ok(transport.send(create(Frame1Schema, { body: { case: "sessionAnnounce", value: { session: ref, payload: announcement, push: false } } })));

  phone.sessions.send(create(Frame1Schema, { body: { case: "subscribeSessions", value: {} } }));
  const list = await until("the session list with the session", () => {
    for (const f of phoneFrames) {
      const entries = f.body.case === "sessionList" ? f.body.value.sessions : f.body.case === "sessionUpdated" && f.body.value.entry ? [f.body.value.entry] : [];
      const e = entries.find((x) => x.session?.sessionId === "s-1");
      if (e) return e;
    }
  });
  assert.deepEqual(list.payload, announcement, "the announcement, opened");
  assert.equal(fromBinary(SessionAnnouncementSchema, list.payload).name, "fixing the build");
  assert.equal(list.hostLabel, "build box");

  // A request: the host gets it with the phone's key, checked.
  const request = toBinary(SessionMessageSchema, create(SessionMessageSchema, { body: { case: "historyRequest", value: { requestId: "q1", limit: 10 } } }));
  phone.sessions.send(create(Frame1Schema, { body: { case: "attach", value: { session: ref } } }));
  assert.ok(phone.sessions.send(create(Frame1Schema, { body: { case: "routed", value: { session: ref, payload: request } } })));
  const got = await until("the request at the host", () => hostFrames.find((f) => f.body.case === "routed"));
  assert.ok(got.body.case === "routed");
  assert.deepEqual(got.body.value.clientKey, phone.publicKey);
  assert.deepEqual(got.body.value.payload, request);

  // The answer, to the phone alone, and a broadcast.
  const answer = toBinary(SessionMessageSchema, create(SessionMessageSchema, { body: { case: "error", value: { requestId: "q1", message: "an answer" } } }));
  transport.send(create(Frame1Schema, { body: { case: "routed", value: { session: ref, clientKey: phone.publicKey, payload: answer } } }));
  transport.send(create(Frame1Schema, { body: { case: "routed", value: { session: ref, clientKey: new Uint8Array(0), payload: answer } } }));
  await until("both at the phone", () => phoneFrames.filter((f) => f.body.case === "routed" && equal(f.body.value.payload, answer)).length === 2);

  // --- the phone removes the host ---
  await phone.remove(hostKey.publicKey);
  const s = await until("the host's anchor state", () => anchorStates[0]);
  assert.equal(s.kind, "removed");
  transport.stop();
  phone.stop();
});
