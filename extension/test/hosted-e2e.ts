// End to end for a hosted account (docs/design.md, step 14, stage 3): the
// Go relay's hosted mode, an interactive pi (in tmux) with the extension
// from the tree, and a phone of web/core/hosted. pi joins with /pirc join
// and the code it shows, typed into the phone; the phone reads the session
// and prompts it, sealed; a /reload makes new keys and carries on; the
// last release before encryption, run on the same machine, refuses the
// joined host's configuration; /pirc leave ends it. Then, on a
// self-hosted relay, answers kept for repeats survive a /reload from that
// release to this code and back.
//
//   node --experimental-transform-types extension/test/hosted-e2e.ts
//
// Needs go, tmux and pi on PATH, and the network for that release.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FrameSchema, SessionAnnouncementSchema, SessionMessageSchema, type Frame, type SessionRef } from "@pirc/protocol";
import { loadOrCreateKey, RelayConnection } from "@pirc/relay-client";
import { wsSocket } from "@pirc/relay-client/hosted-ws";
import * as ed25519 from "@pirc/crypto/ed25519";

import { HostedClient } from "../../web/core/hosted/account.ts";
import { MemoryStore } from "../../web/core/hosted/store.ts";
import { Harness, repo, sleep, startHostedRelay, startPi, startRelay, step } from "../../test/harness.ts";

// The last release before the hosted relay: what must refuse a joined
// host. Pinned, with its digest, so that a changed download fails.
const LAST_UNENCRYPTED = "0.3.11";
const LAST_UNENCRYPTED_SHA256 = "d9632475902ad0c3aa6c6ae184622cc95c0968438dc0f2be88c6828f7e95674b";

const h = new Harness();

async function until<T>(what: string, find: () => T | undefined | false | "", ms = 20_000, screen?: () => string): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = find();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${screen ? `\n--- screen ---\n${screen()}` : ""}`);
    await sleep(50);
  }
}

async function lastUnencrypted(): Promise<string> {
  const dir = join(h.dir, `pirc-extension-${LAST_UNENCRYPTED}`);
  const tgz = join(h.dir, "old.tar.gz");
  const res = await fetch(`https://github.com/pirc-dev/pirc/releases/download/v${LAST_UNENCRYPTED}/pirc-extension-${LAST_UNENCRYPTED}.tar.gz`);
  if (!res.ok) throw new Error(`downloading release ${LAST_UNENCRYPTED}: ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), LAST_UNENCRYPTED_SHA256, `release ${LAST_UNENCRYPTED}'s digest`);
  writeFileSync(tgz, bytes);
  execFileSync("tar", ["xzf", tgz, "-C", h.dir]);
  return dir;
}

try {
  const relay = await startHostedRelay(h);

  // --- the phone ---
  step("a phone signs up");
  const phoneFrames: Frame[] = [];
  const phone = await HostedClient.signUp(
    { origin: relay.origin, open: wsSocket, store: new MemoryStore(), signer: await ed25519.generate(), name: "Pixel 9", onFrame: (f) => phoneFrames.push(f) },
    { $typeName: "pirc.v1alpha2.Attestation", kind: { case: "test", value: new Uint8Array([1]) }, subscription: "" },
  );
  phone.start();
  h.onCleanup(() => phone.stop());
  await until("the phone's pre-key", () => phone.myPreKeys().length > 0);
  await phone.nameSelf();

  // --- pi joins ---
  step("/pirc join shows a code, which the phone types");
  const pi = await startPi(h, undefined, "", "pi");
  await until("pi's prompt", () => pi.screen().includes("pirc: not enrolled"), 30_000, pi.screen);
  pi.keys(`/pirc join ${relay.origin}`, "Enter");
  const code = await until("the code", () => /type ([0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{5})/.exec(pi.screen().replace(/\s+/g, " "))?.[1], 20_000, pi.screen);
  assert.match(pi.screen().replace(/\s+/g, " "), /full control of this computer/);
  let asked = "";
  const outcome = await phone.join(code, async (d) => {
    asked = d.name;
    return true;
  });
  assert.ok("joined" in outcome);
  assert.equal(asked, "e2e-pi");
  await until("pi says who approved it", () => pi.screen().includes("joined the account, approved by 'Pixel 9'"), 20_000, pi.screen);
  const config = JSON.parse(readFileSync(pi.config, "utf8"));
  assert.equal(config.relay, "pirc-e2e:anchor", "host.json holds what old code refuses");
  assert.ok(existsSync(join(h.dir, "hosted", "account.json")), "the anchor beside host.json");

  // --- the phone reads and prompts the session ---
  step("the phone reads pi's session, sealed, and prompts it");
  phone.sessions.send(create(FrameSchema, { body: { case: "subscribeSessions", value: {} } }));
  const entryOf = (f: Frame) => (f.body.case === "sessionList" ? f.body.value.sessions : f.body.case === "sessionUpdated" && f.body.value.entry ? [f.body.value.entry] : []);
  const entry = await until("pi's session at the phone", () => phoneFrames.flatMap(entryOf).find((e) => e.hostLabel === "e2e-pi"), 20_000, pi.screen);
  const ref = entry.session as SessionRef;
  fromBinary(SessionAnnouncementSchema, entry.payload);
  phone.sessions.send(create(FrameSchema, { body: { case: "attach", value: { session: ref } } }));
  const prompt = async (id: string, text: string, r: SessionRef) => {
    const m = create(SessionMessageSchema, { body: { case: "prompt", value: { requestId: id, text } } });
    assert.ok(phone.sessions.send(create(FrameSchema, { body: { case: "routed", value: { session: r, payload: toBinary(SessionMessageSchema, m) } } })));
    return until(`the answer to ${id}`, () => phoneFrames.find((f) => {
      if (f.body.case !== "routed") return false;
      const msg = fromBinary(SessionMessageSchema, f.body.value.payload);
      return (msg.body.case === "accepted" && msg.body.value.requestId === id) || (msg.body.case === "error" && msg.body.value.requestId === id);
    }), 30_000, pi.screen);
  };
  const a1 = await prompt("p1", "hello from the phone", ref);
  assert.equal(fromBinary(SessionMessageSchema, (a1.body.value as { payload: Uint8Array }).payload).body.case, "accepted");
  await until("the prompt at the model", () => pi.modelRequests.some((r) => JSON.stringify(r).includes("hello from the phone")), 30_000, pi.screen);

  // --- /reload: new keys, and on ---
  step("/reload: a new Host object, new keys, the session carries on");
  await until("the model's reply in pi", () => pi.screen().includes("from the fake model"), 30_000, pi.screen);
  await sleep(500);
  const newKeys = () => readFileSync(pi.logFile, "utf8").split("\n").filter((l) => l.includes("hosted: new keys")).length;
  const before = newKeys();
  pi.keys("/reload", "Enter");
  await until("new keys after the reload", () => newKeys() > before, 30_000, pi.screen);
  await sleep(1000);
  const a2 = await prompt("p2", "after the reload", ref);
  assert.equal(fromBinary(SessionMessageSchema, (a2.body.value as { payload: Uint8Array }).payload).body.case, "accepted");

  // --- the last release before encryption refuses ---
  step(`release ${LAST_UNENCRYPTED}, on the same machine, does not connect`);
  const old = await lastUnencrypted();
  const oldPi = await startPi(h, undefined, "", "old", [], { extension: old, config: pi.config });
  await until("the old release's refusal", () => /relay URL must start with ws:\/\/ or wss:\/\/: pirc-e2e:anchor/.test(existsSync(oldPi.logFile) ? readFileSync(oldPi.logFile, "utf8") : ""), 30_000, oldPi.screen);
  const logins = relay.log().split("\n").filter((l) => l.includes("msg=connected")).length;
  await sleep(2000);
  assert.equal(relay.log().split("\n").filter((l) => l.includes("msg=connected")).length, logins, "no connection from the old release");

  // --- /pirc leave ---
  step("/pirc leave: the session ends at the phone");
  pi.keys("/pirc leave", "Enter");
  await until("the session ended at the phone", () => phoneFrames.some((f) => f.body.case === "sessionEnded" && f.body.value.session?.sessionId === ref.sessionId), 20_000, pi.screen);
  assert.ok(!existsSync(join(h.dir, "hosted", "account.json")));

  // --- answers kept across a /reload, from the old release and back ---
  step("a repeat after a /reload gets the kept answer, from that release to this code and back");
  const selfHosted = await startRelay(h);
  const pkg = join(h.dir, "swapped");
  cpSync(old, pkg, { recursive: true });
  const pi2 = await startPi(h, selfHosted, selfHosted.cmd("add-host", "--label", "e2e-swap"), "swap", [], { extension: pkg });
  const frames: Frame[] = [];
  const client = new RelayConnection({ url: selfHosted.url, role: "client", key: loadOrCreateKey(join(h.dir, "swap-client.key")), token: selfHosted.cmd("add-client", "--label", "swap-client"), software: "e2e", onFrame: (f) => frames.push(f) });
  client.start();
  h.onCleanup(() => client.stop());
  await until("the client connected", () => client.current.kind === "ready");
  client.send(create(FrameSchema, { body: { case: "subscribeSessions", value: {} } }));
  const sref = await until("the swap session", () => frames.flatMap(entryOf).find((e) => e.hostLabel === "e2e-swap")?.session, 30_000, pi2.screen);
  const rename = (id: string, name: string) => client.send(create(FrameSchema, { body: { case: "routed", value: { session: sref, payload: toBinary(SessionMessageSchema, create(SessionMessageSchema, { body: { case: "rename", value: { requestId: id, name } } })) } } }));
  const answered = (id: string, after: number) => until(`the answer to ${id}`, () => frames.slice(after).find((f) => f.body.case === "routed" && (() => {
    const m = fromBinary(SessionMessageSchema, f.body.value.payload);
    return (m.body.case === "accepted" || m.body.case === "error") && m.body.value.requestId === id;
  })()), 20_000, pi2.screen);
  const nameNow = () => frames.flatMap(entryOf).filter((e) => e.session?.sessionId === sref.sessionId).map((e) => fromBinary(SessionAnnouncementSchema, e.payload).name).at(-1);
  rename("n1", "first name");
  await answered("n1", 0);
  await until("the first name", () => nameNow() === "first name");
  // To this code: the extension's package replaced in place, and /reload.
  rmSync(pkg, { recursive: true });
  mkdirSync(pkg);
  execFileSync(join(repo, "sh/build.sh"), ["extension", pkg], { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
  pi2.keys("/reload", "Enter");
  await sleep(3000);
  const mark = frames.length;
  rename("n1", "a repeat must not run");
  await answered("n1", mark);
  await sleep(1000);
  assert.equal(nameNow(), "first name", "the repeat got the kept answer and did not run");
  // And back to the release, which reads nothing new from this code's host.
  rmSync(pkg, { recursive: true });
  cpSync(old, pkg, { recursive: true });
  pi2.keys("/reload", "Enter");
  await sleep(3000);
  const mark2 = frames.length;
  rename("n2", "second name");
  await answered("n2", mark2);
  await until("the second name", () => nameNow() === "second name", 20_000, pi2.screen);
  console.log("ok: hosted end to end");
} finally {
  await h.close();
}
