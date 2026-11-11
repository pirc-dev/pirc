// End to end: the Go relay, an interactive pi (in tmux) with the extension
// and a fake model, and a test client speaking the protocol.
//
//   node --experimental-transform-types extension/test/e2e.ts
//
// Needs go, tmux and pi on PATH. Leaves nothing running; with
// PIRC_E2E_KEEP=1 it keeps its temporary directory and prints it.
import { fromBinary, create, toBinary } from "@bufbuild/protobuf";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  Delivery,
  ErrorCode,
  FrameSchema,
  SessionAnnouncementSchema,
  NoticeKind,
  SessionMessageSchema,
  SessionOrigin,
  StopReason,
  ThinkingLevel,
  type ConversationItem,
  type SessionAnnouncement,
  type Frame,
  type SessionEvent,
  type SessionMessage,
  type SessionRef,
} from "@pirc/protocol";
import { loadOrCreateKey, RelayConnection } from "@pirc/relay-client";

import { Harness, repo, sleep, startPi, startRelay, step } from "../../test/harness.ts";

const h = new Harness();
const T = h.dir;
// pi runs a copy of the built package, which a step updates in place: the
// release's or deployment's build, else one built from the tree.
const pkg = join(T, "extension");
if (process.env.PIRC_E2E_EXTENSION) cpSync(process.env.PIRC_E2E_EXTENSION, pkg, { recursive: true });
else execFileSync(join(repo, "sh/build.sh"), ["extension", pkg], { cwd: repo, stdio: ["ignore", "ignore", "inherit"] });
process.env.PIRC_E2E_EXTENSION = pkg;
const relay = await startRelay(h);
const relayURL = relay.url;
const hostToken = relay.cmd("add-host", "--label", "e2e-host");
const clientToken = relay.cmd("add-client", "--label", "e2e-client");
const pi = await startPi(h, relay, hostToken);
const work = pi.work;
const keys = pi.keys;
const screen = pi.screen;

// --- The test client ------------------------------------------------------------

const frames: Frame[] = [];
let wake: (() => void) | undefined;
const client = new RelayConnection({
  url: relayURL,
  role: "client",
  key: loadOrCreateKey(join(T, "client.key")),
  token: clientToken,
  label: "e2e-client",
  software: "pirc-e2e",
  onFrame: (f) => {
    observe(f);
    frames.push(f);
    wake?.();
  },
});
h.onCleanup(() => client.stop());

// Waits for the first frame that pick() accepts, consuming it and every
// frame before it; with keep, only it, leaving the others to read later.
async function next<T>(what: string, pick: (f: Frame) => T | undefined, timeoutMs = 15_000, keep = false): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let scanned = 0;
  for (;;) {
    if (keep) {
      for (; scanned < frames.length; scanned++) {
        const v = pick(frames[scanned]);
        if (v !== undefined) {
          frames.splice(scanned, 1);
          return v;
        }
      }
    }
    while (!keep && frames.length > 0) {
      const v = pick(frames.shift()!);
      if (v !== undefined) return v;
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out waiting for ${what}\n--- screen ---\n${screen()}`);
    await new Promise<void>((r) => {
      wake = r;
      setTimeout(r, Math.min(left, 200));
    });
  }
}

// The last event of each session to arrive: every event must follow the
// one before it, with no gap. Checked on arrival, whatever later consumes
// or discards the frame.
const lastSeq = new Map<string, bigint>();
let observeError: unknown;

function observe(f: Frame): void {
  if (f.body.case !== "routed") return;
  const s = f.body.value.session!;
  const m = fromBinary(SessionMessageSchema, f.body.value.payload);
  try {
    checkSeq(s, m);
  } catch (e) {
    observeError ??= e;
  }
}

function checkSeq(s: SessionRef, m: SessionMessage): void {
  if (m.body.case === "event") {
    const prev = lastSeq.get(s.sessionId);
    if (prev !== undefined) assert.equal(m.body.value.seq, prev + 1n, `seq after ${prev}`);
    lastSeq.set(s.sessionId, m.body.value.seq);
  }
  if (m.body.case === "history") {
    // History reflects exactly the events sent before it.
    const prev = lastSeq.get(s.sessionId);
    if (prev !== undefined) assert.equal(m.body.value.seq, prev, "history is as of the last event before it");
    lastSeq.set(s.sessionId, m.body.value.seq);
  }
}

function payloadOf(f: Frame, ref: SessionRef): SessionMessage | undefined {
  if (observeError) throw observeError;
  if (f.body.case !== "routed") return undefined;
  const s = f.body.value.session;
  if (!s || s.sessionId !== ref.sessionId || s.instanceId !== ref.instanceId) return undefined;
  return fromBinary(SessionMessageSchema, f.body.value.payload);
}

// The next event of the session.
async function event(ref: SessionRef, what: string): Promise<SessionEvent> {
  return next(what, (f) => {
    const m = payloadOf(f, ref);
    return m?.body.case === "event" ? m.body.value : undefined;
  });
}

// Events until an item matching pick, returning every item on the way.
async function itemsUntil(ref: SessionRef, what: string, done: (i: ConversationItem) => boolean): Promise<{ items: ConversationItem[]; events: SessionEvent[] }> {
  const items: ConversationItem[] = [];
  const events: SessionEvent[] = [];
  for (;;) {
    const ev = await event(ref, what);
    events.push(ev);
    if (ev.body.case === "item") {
      items.push(ev.body.value);
      if (done(ev.body.value)) return { items, events };
    }
  }
}

// The next reply to a request, leaving the events around it to be read.
async function reply(ref: SessionRef, what: string): Promise<SessionMessage> {
  return next(what, (f) => {
    if (f.body.case === "error") throw new Error(`relay error: ${f.body.value.message}`);
    const m = payloadOf(f, ref);
    return m && m.body.case !== "event" ? m : undefined;
  }, 15_000, true);
}

// Events until working ends.
async function settled(ref: SessionRef): Promise<void> {
  let ev = await event(ref, "working to end");
  while (!(ev.body.case === "workingChanged" && !ev.body.value.working)) ev = await event(ref, "working to end");
}

function send(ref: SessionRef, m: SessionMessage) {
  assert.ok(client.send(create(FrameSchema, { body: { case: "routed", value: { session: ref, payload: toBinary(SessionMessageSchema, m) } } })), "send");
}

const prompt = (requestId: string, text: string, delivery = Delivery.UNSPECIFIED) =>
  create(SessionMessageSchema, { body: { case: "prompt", value: { requestId, text, delivery } } });

const requestId = (m: SessionMessage) => (m.body.value as { requestId?: string } | undefined)?.requestId;

const text = (i: ConversationItem) =>
  i.body.case === "assistantMessage"
    ? i.body.value.content.map((b) => (b.body.case === "text" ? b.body.value : "")).join("")
    : i.body.case === "userMessage"
      ? i.body.value.text
      : "";

try {
  step("client logs in and subscribes");
  client.start();
  for (let i = 0; i < 100 && client.current.kind !== "ready"; i++) await sleep(100);
  assert.equal(client.current.kind, "ready", JSON.stringify(client.current));
  assert.ok(client.send(create(FrameSchema, { body: { case: "subscribeSessions", value: {} } })));

  step("pi's session appears, announced");
  const first = await next("the session to be announced", (f) => {
    if (f.body.case === "sessionList") return f.body.value.sessions[0];
    if (f.body.case === "sessionUpdated") return f.body.value.entry;
    return undefined;
  }, 30_000);
  const ref = first.session!;
  let ann = fromBinary(SessionAnnouncementSchema, first.payload);
  assert.equal(first.hostLabel, "e2e-host");
  assert.equal(ann.cwd, work);
  assert.equal(ann.model?.id, "fake-1");
  assert.equal(ann.origin, SessionOrigin.STARTUP);
  assert.equal(ann.working, false);
  assert.match(ann.piVersion, /^\d+\.\d+\.\d+/);
  // A release's package must be the one pi loaded, not the source.
  assert.equal(ann.extensionVersion, process.env.PIRC_E2E_VERSION ?? JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version);

  step("attach, and the history is empty");
  assert.ok(client.send(create(FrameSchema, { body: { case: "attach", value: { session: ref } } })));
  await sleep(100);
  send(ref, create(SessionMessageSchema, { body: { case: "historyRequest", value: { requestId: "h0" } } }));
  let r = await reply(ref, "history");
  assert.equal(r.body.case, "history");
  assert.equal(r.body.value.items.length, 0);

  step("a prompt streams back with one turn ID");
  send(ref, prompt("p1", "hello"));
  r = await reply(ref, "accepted p1");
  assert.deepEqual([r.body.case, requestId(r)], ["accepted", "p1"]);
  let { items, events } = await itemsUntil(ref, "the assistant's reply", (i) => i.body.case === "assistantMessage");
  const user = items.find((i) => i.body.case === "userMessage")!;
  assert.ok(user, "user message item");
  assert.equal(user.body.case === "userMessage" && user.body.value.requestId, "p1");
  assert.ok(user.entryId, "user message has its entry ID");
  assert.equal(user.turnId, user.entryId, "the turn is named after the user message");
  const deltas = events.filter((e) => e.body.case === "assistantDelta").map((e) => e.body.value as { turnId: string; messageId: string });
  assert.ok(deltas.length > 0, "streamed deltas");
  assert.ok(deltas.every((d) => d.turnId === user.entryId), "deltas carry the turn ID while streaming");
  const answer = items.at(-1)!;
  assert.equal(text(answer), "Hi there, from the fake model.");
  assert.ok(answer.entryId && answer.turnId === user.entryId);
  assert.equal(answer.body.case === "assistantMessage" && answer.body.value.messageId, deltas[0].messageId);
  assert.ok(events.some((e) => e.body.case === "workingChanged" && e.body.value.working));
  // A subscriber learns of it from the session list, as a phone woken does.
  const notice = await next("the turn's notice in the session list", (f) => {
    const e = f.body.case === "sessionUpdated" ? f.body.value.entry : undefined;
    if (!e || e.session?.sessionId !== ref.sessionId) return undefined;
    return fromBinary(SessionAnnouncementSchema, e.payload).notice;
  }, 15_000, true);
  assert.deepEqual([notice.kind, notice.text], [NoticeKind.FINISHED, "Hi there, from the fake model."]);
  assert.ok(Math.abs(Number(notice.number) - Date.now()) < 60_000, "numbered by the time");
  await settled(ref);

  step("the same request again is answered, not run again");
  send(ref, prompt("p1", "hello"));
  r = await reply(ref, "repeated accepted");
  assert.deepEqual([r.body.case, requestId(r)], ["accepted", "p1"]);

  step("a tool call and its result, in the same turn");
  send(ref, prompt("p2", "use a tool"));
  await reply(ref, "accepted p2");
  ({ items } = await itemsUntil(ref, "the reply after the tool", (i) => i.body.case === "assistantMessage" && text(i).startsWith("done")));
  const u2 = items.find((i) => i.body.case === "userMessage")!;
  const call = items.find((i) => i.body.case === "toolCall")!;
  const result = items.find((i) => i.body.case === "toolResult")!;
  assert.ok(call && result, "tool call and result");
  assert.equal(call.body.case === "toolCall" && call.body.value.toolName, "bash");
  assert.match(result.body.case === "toolResult" ? result.body.value.text : "", /pirc-tool-output/);
  assert.ok(items.every((i) => i.turnId === u2.entryId), "one turn ID for the whole turn");

  step("history matches what streamed");
  await sleep(300);
  send(ref, create(SessionMessageSchema, { body: { case: "historyRequest", value: { requestId: "h1" } } }));
  r = await reply(ref, "history h1");
  assert.equal(r.body.case, "history");
  const hist = r.body.value.items;
  const hUsers = hist.filter((i) => i.body.case === "userMessage");
  assert.deepEqual(hUsers.map((i) => i.entryId), [user.entryId, u2.entryId]);
  assert.ok(hist.every((i) => i.turnId === user.entryId || i.turnId === u2.entryId));
  const limited = await (async () => {
    send(ref, create(SessionMessageSchema, { body: { case: "historyRequest", value: { requestId: "h2", limit: 2 } } }));
    return reply(ref, "history h2");
  })();
  assert.equal(limited.body.case === "history" && limited.body.value.items.length, 2);
  assert.equal(limited.body.case === "history" && limited.body.value.truncated, true);

  step("abort stops a running turn");
  send(ref, prompt("p3", "go slow"));
  await reply(ref, "accepted p3");
  await next("streaming to start", (f) => {
    const m = payloadOf(f, ref);
    return m?.body.case === "event" && m.body.value.body.case === "assistantDelta" ? true : undefined;
  });
  send(ref, create(SessionMessageSchema, { body: { case: "abort", value: { requestId: "a1" } } }));
  ({ items } = await itemsUntil(ref, "the aborted reply", (i) => i.body.case === "assistantMessage"));
  const aborted = items.at(-1)!;
  assert.equal(aborted.body.case === "assistantMessage" && aborted.body.value.stopReason, StopReason.ABORTED);
  await settled(ref);

  step("prompts sent mid-run: a steer and a follow-up are accepted at once and run");
  send(ref, prompt("p6", "go medium"));
  await reply(ref, "accepted p6");
  await next("streaming to start", (f) => {
    const m = payloadOf(f, ref);
    return m?.body.case === "event" && m.body.value.body.case === "assistantDelta" ? true : undefined;
  });
  send(ref, prompt("p7", "and after that", Delivery.FOLLOW_UP));
  send(ref, prompt("p8", "change course", Delivery.STEER));
  for (const id of ["p7", "p8"]) {
    r = await reply(ref, `accepted ${id}`);
    assert.equal(r.body.case, "accepted", `${id}: ${JSON.stringify(r.body.value)}`);
  }
  const echoed = new Set<string>();
  ({ items } = await itemsUntil(ref, "both queued prompts to run", (i) => {
    if (i.body.case === "userMessage" && i.body.value.requestId) echoed.add(i.body.value.requestId);
    return echoed.has("p7") && echoed.has("p8");
  }));
  await settled(ref);

  step("a prompt with an image");
  // A 1x1 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  send(ref, create(SessionMessageSchema, { body: { case: "prompt", value: { requestId: "p9", text: "what is this", images: [{ mimeType: "image/png", data: png }] } } }));
  r = await reply(ref, "accepted p9");
  assert.equal(r.body.case, "accepted", JSON.stringify(r.body.value));
  ({ items } = await itemsUntil(ref, "the image prompt's reply", (i) => i.body.case === "assistantMessage"));
  const withImage = items.find((i) => i.body.case === "userMessage")!;
  assert.equal(withImage.body.case === "userMessage" && withImage.body.value.requestId, "p9");
  assert.equal(withImage.body.case === "userMessage" && withImage.body.value.images.length, 1);
  await settled(ref);

  step("a prompt with an image and no text");
  send(ref, create(SessionMessageSchema, { body: { case: "prompt", value: { requestId: "p9i", text: "", images: [{ mimeType: "image/png", data: png }] } } }));
  r = await reply(ref, "accepted p9i");
  assert.equal(r.body.case, "accepted", JSON.stringify(r.body.value));
  ({ items } = await itemsUntil(ref, "the image-only prompt's reply", (i) => i.body.case === "assistantMessage"));
  const onlyImage = items.find((i) => i.body.case === "userMessage")!;
  assert.equal(onlyImage.body.case === "userMessage" && onlyImage.body.value.requestId, "p9i");
  await settled(ref);

  // --- Actions --------------------------------------------------------------

  const act = (body: SessionMessage["body"]) => create(SessionMessageSchema, { body } as never);
  // The next announcement event of the session that pick() accepts.
  const announced = (what: string, pick: (a: SessionAnnouncement) => boolean) =>
    next(what, (f) => {
      const m = payloadOf(f, ref);
      return m?.body.case === "event" && m.body.value.body.case === "announcement" && pick(m.body.value.body.value) ? m.body.value.body.value : undefined;
    });
  const errorOf = (m: SessionMessage) => (m.body.case === "error" ? m.body.value.code : undefined);

  step("actions: the models pi can use, and the current one");
  await sleep(300);
  frames.length = 0;
  send(ref, act({ case: "listModels", value: { requestId: "m1" } } as never));
  r = await reply(ref, "models");
  assert.ok(r.body.case === "models");
  assert.deepEqual(r.body.value.models.filter((m) => m.model?.provider === "fake").map((m) => [m.model?.id, m.model?.name, m.reasoning, m.contextWindow, m.images]), [
    ["fake-1", "fake-1", false, 128000n, true],
    ["fake-2", "Fake Two", true, 64000n, false],
  ]);
  assert.equal(r.body.value.current?.model?.id, "fake-1");

  step("actions: set the model, announced before the answer");
  send(ref, act({ case: "setModel", value: { requestId: "m2", model: { provider: "fake", id: "nope" } } } as never));
  r = await reply(ref, "unknown model refused");
  assert.equal(errorOf(r), ErrorCode.INVALID);
  send(ref, act({ case: "setModel", value: { requestId: "m3", model: { provider: "fake", id: "fake-2" } } } as never));
  r = await reply(ref, "model set");
  assert.deepEqual([r.body.case, requestId(r)], ["accepted", "m3"]);
  ann = await announced("the new model", (a) => a.model?.id === "fake-2");
  assert.equal(ann.model?.name, "Fake Two");

  step("actions: a thinking level, and one pi clamps");
  send(ref, act({ case: "setThinkingLevel", value: { requestId: "t1", level: ThinkingLevel.HIGH } } as never));
  r = await reply(ref, "thinking set");
  assert.equal(r.body.case, "accepted");
  await announced("thinking high", (a) => a.thinkingLevel === ThinkingLevel.HIGH);
  send(ref, act({ case: "setModel", value: { requestId: "m4", model: { provider: "fake", id: "fake-1" } } } as never));
  await reply(ref, "model back");
  send(ref, act({ case: "setThinkingLevel", value: { requestId: "t2", level: ThinkingLevel.MEDIUM } } as never));
  r = await reply(ref, "thinking clamped");
  assert.equal(r.body.case, "accepted");
  ann = await announced("thinking off, for a model without reasoning", (a) => a.model?.id === "fake-1" && a.thinkingLevel === ThinkingLevel.OFF);
  assert.ok(ann);

  step("actions: rename, stats and commands");
  send(ref, act({ case: "rename", value: { requestId: "n1", name: "named remotely" } } as never));
  r = await reply(ref, "renamed");
  assert.equal(r.body.case, "accepted");
  await announced("the new name", (a) => a.name === "named remotely");
  send(ref, act({ case: "statsRequest", value: { requestId: "s1" } } as never));
  r = await reply(ref, "stats");
  assert.ok(r.body.case === "stats");
  assert.ok(r.body.value.total!.inputTokens > 0n && r.body.value.total!.outputTokens > 0n, "tokens counted");
  assert.equal(r.body.value.contextWindow, 128000n);
  send(ref, act({ case: "listCommands", value: { requestId: "l1" } } as never));
  r = await reply(ref, "commands");
  assert.ok(r.body.case === "commands");
  assert.ok(!r.body.value.commands.some((c) => c.name.startsWith("pirc")), "PiRC's own commands are not listed");
  for (const [id, t] of [["x1", "/pirc status"], ["x2", "/tree"]]) {
    send(ref, prompt(id, t));
    r = await reply(ref, `${t} refused`);
    assert.equal(errorOf(r), ErrorCode.INVALID, t);
  }

  step("actions: compact is refused while the agent works");
  send(ref, prompt("p10", "go slow"));
  await reply(ref, "accepted p10");
  await next("streaming to start", (f) => {
    const m = payloadOf(f, ref);
    return m?.body.case === "event" && m.body.value.body.case === "assistantDelta" ? true : undefined;
  });
  send(ref, act({ case: "compact", value: { requestId: "c1" } } as never));
  r = await reply(ref, "compact refused");
  assert.equal(errorOf(r), ErrorCode.BUSY);
  send(ref, create(SessionMessageSchema, { body: { case: "abort", value: { requestId: "a2" } } }));
  await settled(ref);

  step("actions: compact, shown compacting, answered after its item");
  await sleep(300);
  frames.length = 0;
  send(ref, act({ case: "compact", value: { requestId: "c2" } } as never));
  await announced("compacting", (a) => a.compacting);
  const compacted = await itemsUntil(ref, "the compaction item", (i) => i.body.case === "compaction");
  assert.ok(compacted.items.at(-1)!.entryId);
  await announced("compacting over", (a) => !a.compacting);
  r = await reply(ref, "compacted");
  assert.deepEqual([r.body.case, requestId(r)], ["accepted", "c2"]);
  send(ref, act({ case: "compact", value: { requestId: "c3" } } as never));
  r = await reply(ref, "nothing more to compact");
  assert.equal(errorOf(r), ErrorCode.PI_FAILED);
  assert.match(r.body.case === "error" ? r.body.value.message : "", /Already compacted/);

  step("prompts sent while pi compacts are accepted at once and run after it");
  send(ref, prompt("p11", "hello"));
  await reply(ref, "accepted p11");
  await settled(ref);
  await sleep(300);
  frames.length = 0;
  // The fake model takes its time over a summary asked to.
  send(ref, act({ case: "compact", value: { requestId: "c4", instructions: "this takes time" } } as never));
  await announced("compacting", (a) => a.compacting);
  send(ref, prompt("p12", "hello"));
  send(ref, prompt("p13", "go medium", Delivery.FOLLOW_UP));
  for (const id of ["p12", "p13", "c4"]) {
    r = await reply(ref, `accepted ${id}`);
    assert.deepEqual([r.body.case, requestId(r)], ["accepted", id]);
  }
  const held: string[] = [];
  await itemsUntil(ref, "both held prompts to run", (i) => {
    if (i.body.case === "compaction") held.push("compaction");
    if (i.body.case === "userMessage") held.push(i.body.value.requestId);
    return held.includes("p13");
  });
  assert.deepEqual(held, ["compaction", "p12", "p13"]);
  await settled(ref);

  step("a rename is announced");
  await sleep(300);
  frames.length = 0;
  keys("/name e2e renamed", "Enter");
  const renamed = await next("the renamed announcement", (f) =>
    f.body.case === "sessionUpdated" && fromBinary(SessionAnnouncementSchema, f.body.value.entry!.payload).name === "e2e renamed" ? true : undefined);
  assert.ok(renamed);

  step("/reload keeps the session live");
  frames.length = 0;
  keys("/reload", "Enter");
  await sleep(2000);
  assert.ok(!frames.some((f) => f.body.case === "sessionEnded"), "no SessionEnded on reload");
  send(ref, prompt("p5", "hello"));
  await reply(ref, "accepted after reload");
  await itemsUntil(ref, "a reply after reload", (i) => i.body.case === "assistantMessage");

  step("actions: reload, answered as pi starts it; the session carries on");
  frames.length = 0;
  send(ref, act({ case: "reload", value: { requestId: "rl1" } } as never));
  r = await reply(ref, "reload");
  assert.equal(r.body.case, "accepted", "reload accepted");
  await next("the session announced again", (f) => (f.body.case === "sessionUpdated" && f.body.value.entry?.session?.sessionId === ref.sessionId ? true : undefined));
  assert.ok(!frames.some((f) => f.body.case === "sessionEnded"), "no SessionEnded on a reload");
  send(ref, prompt("p5r", "hello"));
  await reply(ref, "accepted after a client's reload");
  await itemsUntil(ref, "a reply after a client's reload", (i) => i.body.case === "assistantMessage");

  step("an update, then /reload, runs the new code and keeps the session");
  // The same code under another version, as an update leaves it.
  const version = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version as string;
  const bundle = readFileSync(join(pkg, "pirc.js"), "utf8");
  assert.ok(bundle.includes(JSON.stringify(version)), "the bundle names its version");
  writeFileSync(join(pkg, "pirc.js"), bundle.replaceAll(JSON.stringify(version), JSON.stringify(`${version}-updated`)));
  frames.length = 0;
  keys("/reload", "Enter");
  const updated = `software=pirc-extension/${version}-updated`;
  for (let i = 0; i < 50 && !relay.log().includes(updated); i++) await sleep(200);
  assert.ok(relay.log().includes(updated), "the new code connects");
  // The old connection closes 2 seconds after the new one announces.
  const disconnects = () => relay.log().split("\n").filter((l) => l.includes("msg=disconnected role=host")).length;
  const before = disconnects();
  for (let i = 0; i < 50 && disconnects() === before; i++) await sleep(200);
  assert.equal(disconnects(), before + 1, "the old code's connection closes");
  assert.ok(!frames.some((f) => f.body.case === "sessionEnded"), "no SessionEnded on an update");
  send(ref, prompt("p5u", "hello"));
  await reply(ref, "accepted after the update");
  await itemsUntil(ref, "a reply after the update", (i) => i.body.case === "assistantMessage");

  step("a relay restart: pi reconnects and announces again");
  await relay.kill();
  relay.start();
  const state = () => client.current.kind;
  for (let i = 0; i < 100 && state() === "ready"; i++) await sleep(50);
  for (let i = 0; i < 200 && state() !== "ready"; i++) await sleep(100);
  assert.equal(state(), "ready", "client back");
  frames.length = 0;
  assert.ok(client.send(create(FrameSchema, { body: { case: "subscribeSessions", value: {} } })));
  await next("the session to be announced again", (f) => {
    if (f.body.case === "sessionList" && f.body.value.sessions.some((e) => e.session?.sessionId === ref.sessionId)) return true;
    if (f.body.case === "sessionUpdated" && f.body.value.entry?.session?.sessionId === ref.sessionId) return true;
    return undefined;
  }, 30_000);
  assert.ok(client.send(create(FrameSchema, { body: { case: "attach", value: { session: ref } } })));
  await sleep(100);

  step("/new ends the session and announces its successor");
  keys("/new", "Enter");
  await next("the old session to end", (f) => (f.body.case === "sessionEnded" && f.body.value.session?.sessionId === ref.sessionId ? true : undefined));
  const second = await next("the new session", (f) => (f.body.case === "sessionUpdated" && f.body.value.entry!.session!.sessionId !== ref.sessionId ? f.body.value.entry : undefined));
  ann = fromBinary(SessionAnnouncementSchema, second!.payload);
  assert.equal(second!.session!.instanceId, ref.instanceId, "same process, same instance ID");
  assert.equal(ann.replacesSessionId, ref.sessionId);
  assert.equal(ann.origin, SessionOrigin.NEW);

  step("the old session is gone");
  send(ref, prompt("p4", "hello"));
  const gone = await next("an error", (f) => (f.body.case === "error" ? f.body.value : undefined));
  assert.equal(gone.code, ErrorCode.SESSION_NOT_FOUND);

  step("actions: a new session, answered by the old one before it ends");
  const ref2 = second!.session!;
  assert.ok(client.send(create(FrameSchema, { body: { case: "attach", value: { session: ref2 } } })));
  await sleep(300);
  frames.length = 0;
  send(ref2, act({ case: "newSession", value: { requestId: "ns1" } } as never));
  const order: string[] = [];
  const third = await next("the third session", (f) => {
    const m = payloadOf(f, ref2);
    if (m && m.body.case !== "event") order.push(`${m.body.case}:${requestId(m)}`);
    if (f.body.case === "sessionEnded" && f.body.value.session?.sessionId === ref2.sessionId) order.push("ended");
    return f.body.case === "sessionUpdated" && f.body.value.entry!.session!.sessionId !== ref2.sessionId ? f.body.value.entry : undefined;
  }, 30_000);
  assert.deepEqual(order, ["accepted:ns1", "ended"]);
  ann = fromBinary(SessionAnnouncementSchema, third!.payload);
  assert.equal(ann.replacesSessionId, ref2.sessionId);
  assert.equal(ann.origin, SessionOrigin.NEW);

  // Replaces the session ref through request m, and returns the new one,
  // once it is announced as replacing ref.
  const replaced = async (ref: SessionRef, m: SessionMessage, id: string, origin = SessionOrigin.FORK) => {
    send(ref, m);
    const r = await reply(ref, `the answer to ${id}`);
    assert.deepEqual([r.body.case, requestId(r)], ["accepted", id]);
    const entry = await next(`the session after ${id}`, (f) => (f.body.case === "sessionUpdated" && f.body.value.entry!.session!.sessionId !== ref.sessionId ? f.body.value.entry : undefined), 30_000);
    const a = fromBinary(SessionAnnouncementSchema, entry!.payload);
    assert.equal(a.replacesSessionId, ref.sessionId);
    assert.equal(a.origin, origin);
    assert.ok(client.send(create(FrameSchema, { body: { case: "attach", value: { session: entry!.session! } } })));
    await sleep(300);
    return entry!.session!;
  };
  const historyOf = async (ref: SessionRef, id: string) => {
    send(ref, create(SessionMessageSchema, { body: { case: "historyRequest", value: { requestId: id } } }));
    const h = await reply(ref, `history ${id}`);
    assert.equal(h.body.case, "history");
    return h.body.case === "history" ? h.body.value.items : [];
  };

  step("actions: clone copies the session; fork keeps what came before a message");
  const ref3 = third!.session!;
  assert.ok(client.send(create(FrameSchema, { body: { case: "attach", value: { session: ref3 } } })));
  await sleep(300);
  send(ref3, act({ case: "clone", value: { requestId: "k0" } } as never));
  r = await reply(ref3, "clone of an empty session");
  assert.equal(r.body.case === "error" && r.body.value.code, ErrorCode.INVALID, "nothing to clone yet");
  const turns: ConversationItem[] = [];
  for (const [id, words] of [["p8", "first"], ["p9", "second"]]) {
    send(ref3, prompt(id, words));
    turns.push(...(await itemsUntil(ref3, `the reply to ${words}`, (i) => i.body.case === "assistantMessage")).items);
    await settled(ref3);
  }
  const secondUser = turns.filter((i) => i.body.case === "userMessage")[1];
  const answerItem = turns.find((i) => i.body.case === "assistantMessage")!;
  send(ref3, act({ case: "fork", value: { requestId: "f0", entryId: answerItem.entryId } } as never));
  r = await reply(ref3, "a fork before a reply");
  assert.equal(r.body.case === "error" && r.body.value.code, ErrorCode.INVALID, "only before a user message");
  const clone = await replaced(ref3, act({ case: "clone", value: { requestId: "k1" } } as never), "k1");
  const userTexts = (items: ConversationItem[]) => items.flatMap((i) => (i.body.case === "userMessage" ? [i.body.value.text] : []));
  assert.deepEqual(userTexts(await historyOf(clone, "h-clone")), ["first", "second"], "the clone has the whole conversation");
  const fork = await replaced(clone, act({ case: "fork", value: { requestId: "f1", entryId: secondUser.entryId } } as never), "f1");
  const forked = await historyOf(fork, "h-fork");
  assert.deepEqual(userTexts(forked), ["first"], "the fork stops before the message");
  assert.equal(forked.at(-1)!.body.case, "assistantMessage");
  // pi puts the message forked before back in its editor, as its /fork does.
  for (let i = 0; i < 50 && !/^\s*second\s*$/m.test(pi.screen()); i++) await sleep(100);
  assert.match(pi.screen(), /^\s*second\s*$/m, "the message is back in pi's editor");

  step("actions: past sessions are this folder's saved ones; resume goes back to one");
  const pastOf = async (ref: SessionRef, id: string, allFolders: boolean) => {
    send(ref, act({ case: "listPastSessions", value: { requestId: id, allFolders } } as never));
    const p = await reply(ref, `past sessions ${id}`);
    assert.equal(p.body.case, "pastSessions");
    return p.body.case === "pastSessions" ? p.body.value.sessions : [];
  };
  const past = await pastOf(fork, "l1", false);
  const ids = past.map((p) => p.sessionId);
  assert.ok(ids.includes(ref3.sessionId) && ids.includes(clone.sessionId), "the folder's saved sessions");
  assert.ok(!ids.includes(fork.sessionId), "not the session pi has open");
  const original = past.find((p) => p.sessionId === ref3.sessionId)!;
  assert.equal(original.firstPrompt, "first");
  assert.ok((await pastOf(fork, "l2", true)).some((p) => p.sessionId === ref3.sessionId), "and among every folder's");
  send(fork, act({ case: "resume", value: { requestId: "u0", path: original.path + ".nope" } } as never));
  r = await reply(fork, "a resume of no saved session");
  assert.equal(r.body.case === "error" && r.body.value.code, ErrorCode.INVALID, "only a listed session");
  const resumed = await replaced(fork, act({ case: "resume", value: { requestId: "u1", path: original.path } } as never), "u1", SessionOrigin.RESUME);
  assert.equal(resumed.sessionId, ref3.sessionId, "the session resumed");
  assert.deepEqual(userTexts(await historyOf(resumed, "h-resumed")), ["first", "second"]);

  step("actions: going back to a message, with a summary of what is left; the branch left is listed, and switching back to it");
  const treeOf = async (ref: SessionRef, id: string) => {
    send(ref, act({ case: "listTree", value: { requestId: id } } as never));
    const t = await reply(ref, `the tree ${id}`);
    assert.equal(t.body.case, "tree");
    return t.body.case === "tree" ? t.body.value.branches : [];
  };
  let branches = await treeOf(resumed, "t0");
  assert.deepEqual(branches.map((b) => [b.current, b.prompt, b.messageCount]), [[true, "second", 4]]);
  // pi's editor is empty after the resume, and the chat it shows will
  // not have the message once pi has gone back before it.
  frames.length = 0;
  send(resumed, act({ case: "navigateTree", value: { requestId: "g1", entryId: secondUser.entryId, summarize: true } } as never));
  const seen: string[] = [];
  await next("going back to be answered", (f) => {
    const m = payloadOf(f, resumed);
    if (!m) return undefined;
    if (m.body.case === "event") {
      const b = m.body.value.body;
      if (b.case === "branchChanged") seen.push("branchChanged");
      if (b.case === "announcement") seen.push(`compacting:${b.value.compacting}`);
      return undefined;
    }
    seen.push(`${m.body.case}:${requestId(m)}`);
    return true;
  }, 30_000);
  assert.deepEqual(seen, ["compacting:true", "branchChanged", "compacting:false", "accepted:g1"]);
  let back = await historyOf(resumed, "h-back");
  assert.deepEqual(userTexts(back), ["first"], "back to before the message");
  const summary = back.at(-1)!;
  // pi writes its own preamble before the model's summary.
  assert.ok(summary.body.case === "branchSummary" && summary.body.value.summary.endsWith("\n\nSummary of the session so far."), JSON.stringify(summary.body));
  for (let i = 0; i < 50 && !/^\s*second\s*$/m.test(pi.screen()); i++) await sleep(100);
  assert.match(pi.screen(), /^\s*second\s*$/m, "the message is back in pi's editor");
  branches = await treeOf(resumed, "t1");
  assert.deepEqual(branches.map((b) => [b.current, b.prompt, b.messageCount]), [[true, "first", 2], [false, "second", 2]]);
  send(resumed, act({ case: "navigateTree", value: { requestId: "g2", entryId: branches[1].leafId } } as never));
  assert.equal((await event(resumed, "the move back")).body.case, "branchChanged");
  r = await reply(resumed, "switching back");
  assert.deepEqual([r.body.case, requestId(r)], ["accepted", "g2"]);
  back = await historyOf(resumed, "h-again");
  assert.deepEqual(userTexts(back), ["first", "second"], "the branch left, again");

  step("quitting pi ends its session");
  // Ctrl+C clears the editor; Ctrl+D quits only from an empty one.
  keys("C-c");
  await sleep(200);
  keys("C-d");
  await next("the session to end on quit", (f) => (f.body.case === "sessionEnded" && f.body.value.session?.sessionId === resumed.sessionId ? true : undefined));

  step("a host without a token waits for approval, then joins");
  const pi2 = await startPi(h, relay, "", "pi2");
  let pendingLine: string | undefined;
  for (let i = 0; i < 100 && !pendingLine; i++) {
    await sleep(200);
    pendingLine = relay.cmd("pending").split("\n").find((l) => l.startsWith("e2e-pi2 "));
  }
  assert.ok(pendingLine, "pi2 awaits approval");
  for (let i = 0; i < 50 && !pi2.screen().includes("pirc: awaiting approval"); i++) await sleep(200);
  assert.match(pi2.screen(), /pirc: awaiting approval/);
  const pi2Key = pendingLine.split(/\s+/)[1];
  // A key may begin with "-".
  relay.cmd("approve", "--", pi2Key);
  const joined = await next("pi2's session", (f) => (f.body.case === "sessionUpdated" && f.body.value.entry!.hostLabel === "e2e-pi2" ? f.body.value.entry : undefined), 30_000);
  assert.equal(Buffer.from(joined!.session!.hostKey).toString("base64url"), pi2Key);
  assert.equal(relay.cmd("pending").split("\n").length, 1, "no request left");
  // Online takes no footer line.
  for (let i = 0; i < 50 && pi2.screen().includes("pirc:"); i++) await sleep(200);
  assert.doesNotMatch(pi2.screen(), /pirc:/, "online shows nothing in the footer");

  step("a host removed stops asking to join, until enrolled again");
  relay.cmd("remove", "--", pi2Key);
  await next("pi2's session to end", (f) => (f.body.case === "sessionEnded" && f.body.value.session?.sessionId === joined!.session!.sessionId ? true : undefined), 30_000);
  for (let i = 0; i < 50 && !pi2.screen().includes("pirc: removed from the relay"); i++) await sleep(200);
  assert.match(pi2.screen(), /pirc: removed from the relay/);
  assert.match(readFileSync(join(T, "pi2-host.json"), "utf8"), /"removed":/);
  // Longer than a reconnect, or a request's repeat, would take.
  await sleep(3000);
  assert.equal(relay.cmd("pending").split("\n").length, 1, "the removed host does not ask to join");
  pi2.keys(`/pirc enrol ${relayURL}`, "Enter");
  for (let i = 0; i < 100 && !relay.cmd("pending").includes("e2e-pi2 "); i++) await sleep(200);
  assert.match(relay.cmd("pending"), /e2e-pi2 /, "enrolled again, it asks");
  assert.doesNotMatch(readFileSync(join(T, "pi2-host.json"), "utf8"), /"removed":/);

  if (observeError) throw observeError;
  console.log("ok: end to end");
} catch (e) {
  console.error(String((e as Error).stack ?? e));
  try {
    console.error("--- extension log ---\n" + readFileSync(pi.logFile, "utf8"));
  } catch {
    // No log.
  }
  console.error("--- relay log ---\n" + relay.log());
  process.exitCode = 1;
} finally {
  await h.close();
}
