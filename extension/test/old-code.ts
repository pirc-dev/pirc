// The last release before the hosted relay, beside this code
// (docs/e2e.md, section 9): started on a host.json whose relay is the
// hosted relay's marker, it refuses the value and opens no socket, and
// this code says the computer left the account. Then, on a self-hosted
// relay, answers kept for repeats survive a /reload from that release to
// this code and back.
//
//   node --experimental-transform-types extension/test/old-code.ts
//
// Needs go, tmux and pi on PATH, and the network for that release.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FrameSchema, SessionAnnouncementSchema, SessionMessageSchema, type Frame } from "@pirc/protocol";
import { loadOrCreateKey, RelayConnection } from "@pirc/relay-client";

import { HOSTED_MARKER } from "../src/config.ts";
import { Harness, repo, sleep, startPi, startRelay, step } from "../../test/harness.ts";

// The last release before the hosted relay. Pinned, with its digest, so
// that a changed download fails.
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
  const old = await lastUnencrypted();
  const marked = join(h.dir, "marked-host.json");
  writeFileSync(marked, JSON.stringify({ relay: HOSTED_MARKER, label: "e2e-marked", keyFile: join(h.dir, "marked-host.key") }));

  step(`release ${LAST_UNENCRYPTED}, on host.json with the hosted relay's marker, does not connect`);
  const oldPi = await startPi(h, undefined, "", "old", [], { extension: old, config: marked });
  const oldLog = () => (existsSync(oldPi.logFile) ? readFileSync(oldPi.logFile, "utf8") : "");
  await until("the old release's refusal", () => /relay URL must start with ws:\/\/ or wss:\/\/: pirc-e2e:anchor/.test(oldLog()), 30_000, oldPi.screen);
  await sleep(2000);
  assert.doesNotMatch(oldLog(), /relay (connecting|ready|offline)/, "no socket from the old release");

  step("this code, on the same host.json, says the computer left the account");
  const newPi = await startPi(h, undefined, "", "marked", [], { config: marked });
  await until("the status line", () => newPi.screen().includes("pirc: left the account"), 30_000, newPi.screen);

  step("a repeat after a /reload gets the kept answer, from that release to this code and back");
  const selfHosted = await startRelay(h);
  const pkg = join(h.dir, "swapped");
  cpSync(old, pkg, { recursive: true });
  const pi = await startPi(h, selfHosted, selfHosted.cmd("add-host", "--label", "e2e-swap"), "swap", [], { extension: pkg });
  const frames: Frame[] = [];
  const client = new RelayConnection({ url: selfHosted.url, role: "client", key: loadOrCreateKey(join(h.dir, "swap-client.key")), token: selfHosted.cmd("add-client", "--label", "swap-client"), software: "e2e", onFrame: (f) => frames.push(f) });
  client.start();
  h.onCleanup(() => client.stop());
  await until("the client connected", () => client.current.kind === "ready");
  client.send(create(FrameSchema, { body: { case: "subscribeSessions", value: {} } }));
  const entryOf = (f: Frame) => (f.body.case === "sessionList" ? f.body.value.sessions : f.body.case === "sessionUpdated" && f.body.value.entry ? [f.body.value.entry] : []);
  const sref = await until("the swap session", () => frames.flatMap(entryOf).find((e) => e.hostLabel === "e2e-swap")?.session, 30_000, pi.screen);
  const rename = (id: string, name: string) => client.send(create(FrameSchema, { body: { case: "routed", value: { session: sref, payload: toBinary(SessionMessageSchema, create(SessionMessageSchema, { body: { case: "rename", value: { requestId: id, name } } })) } } }));
  const answered = (id: string, after: number) => until(`the answer to ${id}`, () => frames.slice(after).find((f) => f.body.case === "routed" && (() => {
    const m = fromBinary(SessionMessageSchema, f.body.value.payload);
    return (m.body.case === "accepted" || m.body.case === "error") && m.body.value.requestId === id;
  })()), 20_000, pi.screen);
  const nameNow = () => frames.flatMap(entryOf).filter((e) => e.session?.sessionId === sref.sessionId).map((e) => fromBinary(SessionAnnouncementSchema, e.payload).name).at(-1);
  rename("n1", "first name");
  await answered("n1", 0);
  await until("the first name", () => nameNow() === "first name");
  // To this code: the extension's package replaced in place, and /reload.
  rmSync(pkg, { recursive: true });
  mkdirSync(pkg);
  execFileSync(join(repo, "sh/build.sh"), ["extension", pkg], { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
  pi.keys("/reload", "Enter");
  await sleep(3000);
  const mark = frames.length;
  rename("n1", "a repeat must not run");
  await answered("n1", mark);
  await sleep(1000);
  assert.equal(nameNow(), "first name", "the repeat got the kept answer and did not run");
  // And back to the release, which reads nothing new from this code's host.
  rmSync(pkg, { recursive: true });
  cpSync(old, pkg, { recursive: true });
  pi.keys("/reload", "Enter");
  await sleep(3000);
  const mark2 = frames.length;
  rename("n2", "second name");
  await answered("n2", mark2);
  await until("the second name", () => nameNow() === "second name", 20_000, pi.screen);
  console.log("ok: old code");
} finally {
  await h.close();
}
