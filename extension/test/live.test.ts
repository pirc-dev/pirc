// The session and process logic against a fake pi: no relay, no model.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";

import { Delivery, ErrorCode, FrameSchema, NoticeKind, SessionMessageSchema, type Answer, type Frame, type SessionMessage } from "@pirc/protocol";

import { historyItems, type AgentMessage } from "../src/convert.ts";
import { Host } from "../src/host.ts";
import type { Launcher } from "../src/launch.ts";
import { Questions } from "../src/questions.ts";
import { BUILTIN_COMMANDS, CONFIRM_MS, Live, type Sink } from "../src/live.ts";
import { PHOTO_ENTRY } from "../src/photos.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 0 });
const assistant = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], api: "x", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 0 }) as AgentMessage;

// A pi that persists what the test tells it to, the way pi does: after the
// extension's message_end handler, keeping the message object.
class FakePi {
  entries: SessionEntry[] = [];
  // Undefined for a session kept in memory only.
  sessionFile: string | undefined;
  sent: { content: unknown; options: unknown }[] = [];
  idle = true;
  model: object | undefined = { provider: "p", id: "m" };
  commands: { name: string; source: string; description?: string }[] = [];
  aborted = 0;
  shutdowns = 0;
  thinking = "off";
  // The levels the model supports, as pi clamps to them.
  levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  models = [{ provider: "p", id: "m", name: "Model M", reasoning: true, contextWindow: 1000, input: ["text", "image"] }, { provider: "q", id: "n" }];
  // What setModel does: resolve to a boolean, or reject.
  setModelOutcome: boolean | Error = true;
  setModelCalls = 0;
  name: string | undefined;
  compactions: { customInstructions?: string; onComplete?: (r: unknown) => void; onError?: (e: Error) => void }[] = [];
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined = { tokens: 250, contextWindow: 1000, percent: 25 };
  // The folder pi runs in, and the sessions saved there and elsewhere,
  // newest change first, as pi's SessionManager.list and listAll give them.
  folder = tmpdir();
  saved: { path: string; id: string; cwd: string; name?: string; created: Date; modified: Date; messageCount: number; firstMessage: string }[] = [];
  private n = 0;

  constructor(readonly sessionId = "s1") {}

  persist(message: AgentMessage): string {
    const id = `e${++this.n}`;
    this.entries.push({ type: "message", id, parentId: null, timestamp: "2026-10-22T00:00:00.000Z", message } as SessionEntry);
    return id;
  }

  api(): ExtensionAPI {
    return {
      sendUserMessage: (content: unknown, options: unknown) => void this.sent.push({ content, options }),
      appendEntry: (customType: string, data: unknown) =>
        void this.entries.push({ type: "custom", id: `e${++this.n}`, parentId: null, timestamp: "2026-10-22T00:00:00.000Z", customType, data } as SessionEntry),
      getCommands: () => this.commands,
      getSessionName: () => this.name,
      setSessionName: (n: string) => void (this.name = n),
      getThinkingLevel: () => this.thinking,
      setThinkingLevel: (l: string) => {
        const order = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        const i = order.indexOf(l);
        this.thinking = this.levels.includes(l) ? l : order.slice(i).find((x) => this.levels.includes(x)) ?? order.slice(0, i).reverse().find((x) => this.levels.includes(x)) ?? "off";
      },
      setModel: async (m: object) => {
        this.setModelCalls++;
        if (this.setModelOutcome instanceof Error) throw this.setModelOutcome;
        if (this.setModelOutcome) this.model = m;
        return this.setModelOutcome;
      },
    } as unknown as ExtensionAPI;
  }

  ctx(): ExtensionContext {
    const fake = this;
    // Static, as pi's SessionManager has them; the extension reaches them
    // through the instance's class.
    class SessionManager {
      static async list(cwd: string) {
        return fake.saved.filter((s) => s.cwd === cwd);
      }
      static async listAll() {
        return fake.saved;
      }
    }
    return {
      cwd: "/w",
      mode: "tui",
      get model() {
        return fake.model;
      },
      isIdle: () => this.idle,
      shutdown: () => void this.shutdowns++,
      abort: () => void this.aborted++,
      compact: (o: FakePi["compactions"][number]) => void this.compactions.push(o ?? {}),
      getContextUsage: () => this.contextUsage,
      modelRegistry: {
        getAvailable: () => this.models,
        find: (provider: string, id: string) => this.models.find((m) => m.provider === provider && m.id === id),
      },
      ui: { setStatus() {}, notify() {} },
      sessionManager: Object.assign(new SessionManager(), {
        getCwd: () => this.folder,
        getSessionDir: () => "/sessions",
        usesDefaultSessionDir: () => true,
        getSessionId: () => this.sessionId,
        getEntries: () => this.entries,
        getEntry: (id: string) => this.entries.find((e) => e.id === id),
        getLeafId: () => this.entries.at(-1)?.id ?? null,
        getSessionFile: () => this.sessionFile,
        getBranch: (from?: string) => (from ? this.entries.slice(0, this.entries.findIndex((e) => e.id === from) + 1) : this.entries),
        // One branch: each entry the child of the one before.
        getTree: () => this.entries.reduceRight<object[]>((children, entry) => [{ entry, children }], []),
        getHeader: () => ({ timestamp: "2026-10-22T00:00:00.000Z" }),
      }),
    } as unknown as ExtensionContext;
  }
}

class FakeSink implements Sink {
  out: SessionMessage[] = [];
  failures: string[] = [];
  max = 1 << 20;
  broadcast(_: Live, m: SessionMessage) {
    this.out.push(m);
  }
  reply() {}
  announce() {}
  place() {
    return undefined;
  }
  launched: Parameters<Launcher["launch"]>[0][] = [];
  launchFails: Error | undefined;
  launchId = "";
  canLaunch = true;
  launcher(): Launcher | undefined {
    if (!this.canLaunch) return undefined;
    return {
      name: "tmux",
      launch: async (o) => {
        if (this.launchFails) throw this.launchFails;
        this.launched.push(o);
      },
    };
  }
  dialogs = new Questions(() => {});
  questions() {
    return this.dialogs.list();
  }
  answer(a: Answer) {
    return this.dialogs.answer(a);
  }
  maxPayloadBytes() {
    return this.max;
  }
  fail(where: string, e: unknown) {
    this.failures.push(`${where}: ${(e as Error).message}`);
  }
  items() {
    return this.out.flatMap((m) => (m.body.case === "event" && m.body.value.body.case === "item" ? [m.body.value.body.value] : []));
  }
}

function setup(seq?: bigint) {
  const pi = new FakePi();
  const sink = new FakeSink();
  const live = new Live(pi.api(), pi.ctx(), sink, () => new Uint8Array(32), "i1", "startup", "", { pi: "t", extension: "t" }, seq);
  return { pi, sink, live };
}

const prompt = (requestId: string, text: string, extra: object = {}) =>
  create(SessionMessageSchema, { body: { case: "prompt", value: { requestId, text, ...extra } } });

function ask(live: Live, m: SessionMessage): SessionMessage[] {
  const replies: SessionMessage[] = [];
  live.onRequest(m, (r) => replies.push(r));
  return replies;
}

const errorCode = (m: SessionMessage | undefined) => (m?.body.case === "error" ? m.body.value.code : undefined);

test("another extension's message does not hold up the stream", () => {
  const { pi, sink, live } = setup();
  const u = user("hi");
  live.onMessageEnd(u);
  pi.persist(u);
  // pi stores a custom message as a custom_message entry, never a message.
  live.onMessageEnd({ role: "custom", customType: "x", content: "note", display: true, timestamp: 0 } as AgentMessage);
  const a = assistant("hello");
  live.onMessageStart(a);
  live.onMessageEnd(a);
  pi.persist(a);
  live.onWorking(false);
  assert.deepEqual(sink.items().map((i) => [i.entryId, i.body.case]), [["e1", "userMessage"], ["e2", "assistantMessage"]]);
  assert.equal(sink.items()[1].turnId, "e1");
  live.dispose();
});

test("a message pi never persists goes out without an entry ID", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { sink, live } = setup();
    live.onMessageEnd(user("lost"));
    assert.equal(sink.items().length, 0);
    mock.timers.tick(2100);
    assert.deepEqual(sink.items().map((i) => [i.entryId, i.body.case]), [["", "userMessage"]]);
    live.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("a prompt to an idle pi is accepted once it is echoed", () => {
  const { pi, sink, live } = setup();
  const replies = ask(live, prompt("r1", "hello"));
  assert.equal(replies.length, 0);
  assert.deepEqual(pi.sent[0].options, { deliverAs: "followUp", expandPromptTemplates: true });
  const u = user("hello");
  live.onWorking(true);
  live.onMessageEnd(u);
  pi.persist(u);
  assert.equal(replies[0]?.body.case, "accepted");
  live.onWorking(false);
  const item = sink.items()[0];
  assert.equal(item.body.case === "userMessage" && item.body.value.requestId, "r1");
  live.dispose();
});

test("a prompt pi never starts times out, and only then", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { live } = setup();
    const replies = ask(live, prompt("r1", "hello"));
    mock.timers.tick(CONFIRM_MS - 1);
    assert.equal(replies.length, 0);
    mock.timers.tick(1);
    assert.equal(errorCode(replies[0]), ErrorCode.TIMEOUT);
    live.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("a compaction pauses the deadline", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { live } = setup();
    const replies = ask(live, prompt("r1", "hello"));
    live.onCompactStart();
    mock.timers.tick(CONFIRM_MS * 3);
    assert.equal(replies.length, 0);
    live.onCompactEnd();
    mock.timers.tick(CONFIRM_MS);
    assert.equal(errorCode(replies[0]), ErrorCode.TIMEOUT);
    live.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("a prompt mid-run is accepted at once, as a steer or a follow-up", () => {
  const { pi, live } = setup();
  pi.idle = false;
  live.onWorking(true);
  assert.equal(ask(live, prompt("r1", "turn left", { delivery: Delivery.STEER }))[0].body.case, "accepted");
  assert.equal(ask(live, prompt("r2", "then this"))[0].body.case, "accepted");
  assert.deepEqual(pi.sent.map((s) => (s.options as { deliverAs: string }).deliverAs), ["steer", "followUp"]);
  live.dispose();
});

test("prompts pi would refuse are answered without sending them", () => {
  const { pi, live } = setup();
  pi.model = undefined;
  assert.equal(errorCode(ask(live, prompt("r2", "hi"))[0]), ErrorCode.PI_FAILED);
  assert.equal(errorCode(ask(live, prompt("r3", ""))[0]), ErrorCode.INVALID);
  assert.equal(pi.sent.length, 0);
  live.dispose();
});

const turn = () => new Promise((r) => setImmediate(r));
const sentText = (pi: FakePi) => pi.sent.map((s) => [s.content, (s.options as { deliverAs: string }).deliverAs]);

test("prompts during a compaction are accepted and held, then sent in order once it ends, after pi's hooks", async () => {
  const { pi, sink, live } = setup();
  live.onCompactStart();
  pi.commands = [{ name: "deploy", source: "extension" }];
  assert.equal(ask(live, prompt("r1", "first"))[0].body.case, "accepted");
  assert.equal(ask(live, prompt("r2", "second", { delivery: Delivery.STEER }))[0].body.case, "accepted");
  assert.equal(ask(live, prompt("r3", "/deploy now"))[0].body.case, "accepted");
  assert.deepEqual(sentText(pi), [["/deploy now", "followUp"]], "a command goes at once");
  live.onCompactEnd();
  assert.equal(pi.sent.length, 1, "not before pi's hook has returned");
  await turn();
  // pi idle: the first starts a run, the rest wait for it.
  assert.deepEqual(sentText(pi).slice(1), [["first", "followUp"]]);
  assert.equal(ask(live, prompt("r4", "third"))[0].body.case, "accepted", "behind those held");
  pi.idle = false;
  live.onWorking(true);
  await turn();
  assert.deepEqual(sentText(pi).slice(1), [["first", "followUp"], ["second", "steer"], ["third", "followUp"]]);
  // Their copies carry their request IDs.
  for (const text of ["first", "second"]) {
    const u = user(text);
    live.onMessageEnd(u);
    pi.persist(u);
  }
  live.onWorking(false);
  assert.deepEqual(sink.items().map((i) => i.body.case === "userMessage" && i.body.value.requestId), ["r1", "r2"]);
  live.dispose();
});

test("held prompts go together into a run that is still going", async () => {
  const { pi, live } = setup();
  pi.idle = false;
  live.onWorking(true);
  live.onCompactStart();
  ask(live, prompt("r1", "a"));
  ask(live, prompt("r2", "b"));
  live.onCompactEnd();
  await turn();
  assert.deepEqual(sentText(pi), [["a", "followUp"], ["b", "followUp"]]);
  live.dispose();
});

test("the rest of the held go anyway if the first never starts a run", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { pi, live } = setup();
    live.onCompactStart();
    ask(live, prompt("r1", "a"));
    ask(live, prompt("r2", "b"));
    live.onCompactEnd();
    await turn();
    assert.equal(pi.sent.length, 1);
    // pi compacts before the prompt's run: the wait pauses.
    live.onCompactStart();
    mock.timers.tick(CONFIRM_MS * 2);
    live.onCompactEnd();
    await turn();
    assert.equal(pi.sent.length, 1);
    mock.timers.tick(CONFIRM_MS);
    await turn();
    assert.deepEqual(sentText(pi), [["a", "followUp"], ["b", "followUp"]]);
    live.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("held prompts are dropped with the session", async () => {
  const { pi, live } = setup();
  live.onCompactStart();
  ask(live, prompt("r1", "a"));
  live.onCompactEnd();
  live.dispose();
  await turn();
  assert.equal(pi.sent.length, 0);
});

test("an extension command is accepted once dispatched", () => {
  const { pi, live } = setup();
  pi.commands = [{ name: "deploy", source: "extension" }];
  assert.equal(ask(live, prompt("r1", "/deploy now"))[0].body.case, "accepted");
  assert.equal(pi.sent.length, 1);
  live.dispose();
});

test("a prompt template is accepted when its run starts", () => {
  const { pi, live } = setup();
  pi.commands = [{ name: "review", source: "prompt" }];
  const replies = ask(live, prompt("r1", "/review"));
  assert.equal(replies.length, 0);
  live.onWorking(true);
  assert.equal(replies[0]?.body.case, "accepted");
  live.dispose();
});

test("an echo with pi's image notes appended still matches", () => {
  const { pi, sink, live } = setup();
  const replies = ask(live, prompt("r1", "look", { images: [{ mimeType: "image/png", data: new Uint8Array([1]) }] }));
  const u: AgentMessage = { role: "user", content: [{ type: "text", text: "look\n[image resized]" }], timestamp: 0 };
  live.onMessageEnd(u);
  pi.persist(u);
  live.onWorking(false);
  assert.equal(replies[0]?.body.case, "accepted");
  const item = sink.items()[0];
  assert.equal(item.body.case === "userMessage" && item.body.value.requestId, "r1");
  live.dispose();
});

test("an echo of an image with no text, with pi's note, matches", () => {
  const { pi, sink, live } = setup();
  const png = { type: "image" as const, mimeType: "image/png", data: "AQ==" };
  const replies = ask(live, prompt("r1", "", { images: [{ mimeType: "image/png", data: new Uint8Array([1]) }] }));
  // A message of text alone does not claim it.
  const other: AgentMessage = { role: "user", content: [{ type: "text", text: "typed at the terminal" }], timestamp: 0 };
  live.onMessageEnd(other);
  pi.persist(other);
  assert.equal(replies.length, 0);
  const u: AgentMessage = { role: "user", content: [{ type: "text", text: "[image resized]" }, png], timestamp: 0 };
  live.onMessageEnd(u);
  pi.persist(u);
  live.onWorking(false);
  assert.equal(replies[0]?.body.case, "accepted");
  const item = sink.items().find((i) => i.body.case === "userMessage" && i.body.value.text === "[image resized]");
  assert.equal(item?.body.case === "userMessage" && item.body.value.requestId, "r1");
  live.dispose();
});

test("a client's images get an entry after their message, for pi's chat, and clients never see it", () => {
  const { pi, sink, live } = setup();
  const png = { type: "image" as const, mimeType: "image/png", data: "AQ==" };
  ask(live, prompt("r1", "look", { images: [{ mimeType: "image/png", data: new Uint8Array([1]) }] }));
  const u: AgentMessage = { role: "user", content: [{ type: "text", text: "look" }, png], timestamp: 0 };
  live.onWorking(true);
  live.onMessageEnd(u);
  pi.persist(u);
  const a = assistant("a cat");
  live.onMessageStart(a);
  live.onMessageEnd(a);
  pi.persist(a);
  live.onWorking(false);
  assert.deepEqual(pi.entries.map((e) => e.type === "custom" ? [e.type, e.customType, e.data] : [e.type]), [
    ["message"],
    ["custom", PHOTO_ENTRY, { message: "e1" }],
    ["message"],
  ]);
  assert.deepEqual(sink.items().map((i) => [i.entryId, i.body.case]), [["e1", "userMessage"], ["e3", "assistantMessage"]]);
  assert.deepEqual(historyItems(pi.entries).map((i) => [i.entryId, i.body.case]), [["e1", "userMessage"], ["e3", "assistantMessage"]]);
  live.dispose();
});

test("no entry for a client's prompt of text, nor for images typed at pi's terminal", () => {
  const { pi, live } = setup();
  ask(live, prompt("r1", "hello"));
  const u = user("hello");
  live.onWorking(true);
  live.onMessageEnd(u);
  pi.persist(u);
  // Not a client's prompt.
  const typed: AgentMessage = { role: "user", content: [{ type: "text", text: "mine" }, { type: "image", mimeType: "image/png", data: "AQ==" }], timestamp: 0 };
  live.onMessageEnd(typed);
  pi.persist(typed);
  live.onWorking(false);
  assert.deepEqual(pi.entries.map((e) => e.type), ["message", "message"]);
  live.dispose();
});

test("an item too big for a frame loses its images, then its text, but is sent", () => {
  const { pi, sink, live } = setup();
  sink.max = 64 * 1024;
  const big = Buffer.alloc(200 * 1024, 7).toString("base64");
  const u: AgentMessage = { role: "user", content: [{ type: "text", text: "x".repeat(100 * 1024) }, { type: "image", mimeType: "image/png", data: big }], timestamp: 0 };
  live.onMessageEnd(u);
  pi.persist(u);
  const a = assistant("y".repeat(300 * 1024));
  live.onMessageEnd(a);
  pi.persist(a);
  live.onWorking(false);
  const out = sink.out.filter((m) => m.body.case === "event" && m.body.value.body.case === "item");
  assert.equal(out.length, 2);
  for (const m of out) assert.ok(toBinary(SessionMessageSchema, m).length <= sink.max, "fits");
  const first = sink.items()[0];
  assert.ok(first.body.case === "userMessage" && first.body.value.images.length === 1 && first.body.value.images[0].data.length === 0);
  // History, too, always carries the newest item.
  const h = live.history("h", 0);
  assert.ok(toBinary(SessionMessageSchema, h).length <= sink.max);
  assert.ok(h.body.case === "history" && h.body.value.items.at(-1)?.body.case === "assistantMessage");
  live.dispose();
});

test("history after an entry: only what follows it, when few enough and on the branch; else the usual answer", () => {
  const { pi, live } = setup();
  const ids = ["one", "two", "three", "four"].map((t, i) => pi.persist(i % 2 ? assistant(t) : user(t)));
  const ask = (after: string, limit = 200) => {
    const h = live.history("h", limit, after);
    assert.ok(h.body.case === "history");
    return { from: h.body.value.fromEntry, texts: h.body.value.items.map((i) => (i.body.case === "userMessage" ? i.body.value.text : "a")), truncated: h.body.value.truncated };
  };
  assert.deepEqual(ask(ids[1]), { from: true, texts: ["three", "a"], truncated: false });
  assert.deepEqual(ask(ids[3]), { from: true, texts: [], truncated: false }, "nothing new");
  assert.deepEqual(ask(ids[0], 3), { from: true, texts: ["a", "three", "a"], truncated: false });
  assert.deepEqual(ask(ids[0], 2), { from: false, texts: ["three", "a"], truncated: true }, "more than the limit follow it");
  assert.deepEqual(ask("elsewhere"), { from: false, texts: ["one", "a", "three", "a"], truncated: false }, "not on the branch");
  assert.deepEqual(ask(""), { from: false, texts: ["one", "a", "three", "a"], truncated: false });
  live.dispose();
});

test("history after an entry whose items do not fit one message is the usual answer", () => {
  const { pi, sink, live } = setup();
  sink.max = 64 * 1024;
  const first = pi.persist(user("one"));
  pi.persist(assistant("x".repeat(40 * 1024)));
  pi.persist(assistant("y".repeat(40 * 1024)));
  const h = live.history("h", 200, first);
  assert.ok(h.body.case === "history" && !h.body.value.fromEntry && h.body.value.truncated);
  assert.equal(h.body.value.items.length, 1, "the newest that fits");
  live.dispose();
});

test("sequence numbers carry on from where the process left the session", () => {
  const { sink, live } = setup(41n);
  live.onWorking(true);
  const m = sink.out[0];
  assert.equal(m.body.case === "event" && m.body.value.seq, 42n);
  assert.equal(live.lastSeq, BigInt(41 + sink.out.length));
  live.dispose();
});

test("fractional token counts do not throw", () => {
  const { pi, sink, live } = setup();
  const a = { ...assistant("x"), usage: { ...usage, input: 2.6 } } as AgentMessage;
  live.onMessageEnd(a);
  pi.persist(a);
  live.onWorking(false);
  const item = sink.items()[0];
  assert.equal(item.body.case === "assistantMessage" && item.body.value.usage?.inputTokens, 3n);
  live.dispose();
});

// --- The process side -------------------------------------------------

function hostWith(pi: FakePi) {
  const host = new Host("i1", { pi: "t", extension: "t" });
  const sent: Frame[] = [];
  const key = new Uint8Array(32).fill(9);
  const h = host as unknown as { conn: unknown; key: unknown; state: unknown; onFrame(f: Frame): void };
  h.conn = { send: (f: Frame) => void sent.push(f), stop() {} };
  h.key = { publicKey: key };
  h.state = { kind: "ready", maxFrameBytes: 1 << 20 };
  const papi = pi.api();
  host.bind(papi, pi.ctx(), { type: "session_start", reason: "startup" });
  const request = (sessionId: string, m: SessionMessage) =>
    h.onFrame(create(FrameSchema, {
      body: { case: "routed", value: { session: { hostKey: key, sessionId, instanceId: "i1" }, clientKey: new Uint8Array(32).fill(1), payload: toBinary(SessionMessageSchema, m) } },
    }));
  const replies = () => sent.flatMap((f) => (f.body.case === "routed" ? [fromRouted(f.body.value.payload)] : []));
  return { host, papi, request, replies };
}

const fromRouted = (b: Uint8Array) => fromBinary(SessionMessageSchema, b);

test("a repeated request is run once, and waits for the first one's outcome", () => {
  const pi = new FakePi("s1");
  const { request, replies, host } = hostWith(pi);
  const live = (host as unknown as { live: Live }).live;
  request("s1", prompt("r1", "hello"));
  request("s1", prompt("r1", "hello"));
  assert.equal(pi.sent.length, 1);
  assert.equal(replies().filter((m) => m.body.case === "accepted").length, 0);
  const u = user("hello");
  live.onMessageEnd(u);
  pi.persist(u);
  request("s1", prompt("r1", "hello"));
  assert.equal(pi.sent.length, 1);
  assert.deepEqual(replies().map((m) => m.body.case), ["accepted", "accepted"]);
  live.dispose();
});

test("request IDs are per session: a new session runs a reused one", () => {
  const pi1 = new FakePi("s1");
  pi1.idle = false;
  const { host, papi, request, replies } = hostWith(pi1);
  request("s1", prompt("r1", "one"));
  host.unbind(papi, "new");
  const pi2 = new FakePi("s2");
  pi2.idle = false;
  host.bind(pi2.api(), pi2.ctx(), { type: "session_start", reason: "new" });
  request("s2", prompt("r1", "two"));
  assert.equal(pi2.sent.length, 1);
  assert.deepEqual(replies().filter((m) => m.body.case === "accepted").length, 2);
  host.unbind(pi2.api(), "quit");
});

test("during a reload requests get BUSY, after the session ends SESSION_GONE", () => {
  const pi = new FakePi("s1");
  const { host, papi, request, replies } = hostWith(pi);
  host.unbind(papi, "reload");
  request("s1", prompt("r1", "hi"));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.BUSY);
  const again = pi.api();
  host.bind(again, pi.ctx(), { type: "session_start", reason: "reload" });
  host.unbind(again, "new");
  request("s1", prompt("r2", "hi"));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.SESSION_GONE);
  assert.equal(pi.sent.length, 0);
});

test("a second load of the extension takes over the same session", () => {
  const pi = new FakePi("s1");
  const { host, papi } = hostWith(pi);
  const second = pi.api();
  host.bind(second, pi.ctx(), { type: "session_start", reason: "startup" });
  assert.equal(host.liveFor(papi), undefined);
  assert.ok(host.liveFor(second));
  host.unbind(second, "quit");
});

test("a host another version made is taken over after a reload: the same instance, sequence numbers carrying on, its connection closed shortly after the session is announced again", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const pi = new FakePi("s1");
  const { host: old, papi } = hostWith(pi);
  const live = (old as unknown as { live: Live }).live;
  live.onWorking(true);
  live.onWorking(false);
  const seq = live.lastSeq;
  assert.ok(seq > 0n);
  let stopped = false;
  (old as unknown as { conn: unknown }).conn = { send: () => true, stop: () => void (stopped = true) };
  old.unbind(papi, "reload");

  const next = Host.succeeding(old, "i2", { pi: "t", extension: "t2" });
  assert.equal(next.instanceId, "i1");
  assert.equal(stopped, false);
  const sent: Frame[] = [];
  const n = next as unknown as { conn: unknown; key: unknown; state: unknown };
  n.conn = { send: (f: Frame) => (sent.push(f), true), stop() {} };
  n.key = { publicKey: new Uint8Array(32).fill(9) };
  n.state = { kind: "ready", maxFrameBytes: 1 << 20 };
  const again = pi.api();
  next.bind(again, pi.ctx(), { type: "session_start", reason: "reload" });
  const announced = sent.find((f) => f.body.case === "sessionAnnounce");
  assert.equal(announced?.body.case === "sessionAnnounce" && announced.body.value.session?.instanceId, "i1");
  assert.equal(next.liveFor(again)?.lastSeq, seq);
  assert.equal(stopped, false, "kept a moment, for the relay to see the announcement first");
  assert.ok((old as unknown as { suspended: unknown }).suspended, "still answering BUSY meanwhile");
  mock.timers.tick(2000);
  assert.equal(stopped, true);
  assert.equal((old as unknown as { suspended: unknown }).suspended, undefined);
  next.unbind(again, "quit");
  mock.timers.reset();
});

test("an announcement pushes a notice once: one raised offline on reconnecting, none on a repeat, and not again after a reload", () => {
  const pi = new FakePi("s1");
  const { host, papi } = hostWith(pi);
  const sent: Frame[] = [];
  const h = host as unknown as { conn: unknown; state: unknown; live: Live };
  h.conn = { send: (f: Frame) => (sent.push(f), true), stop() {} };
  const pushes = () => sent.flatMap((f) => (f.body.case === "sessionAnnounce" ? [f.body.value.push] : []));
  // How many announcements pushed, and whether the last did.
  const pushed = () => [pushes().filter(Boolean).length, pushes().at(-1)];
  const live = h.live;
  live.onWorking(true);
  live.onMessageEnd(assistant("done"));
  live.onWorking(false);
  assert.deepEqual(pushed(), [1, true]);
  live.onAnnouncementChanged();
  assert.deepEqual(pushed(), [1, false], "a later announcement of the same notice");
  // The relay out of reach while a turn ends.
  h.state = { kind: "connecting" };
  live.onWorking(true);
  live.onMessageEnd(assistant("done again"));
  live.onWorking(false);
  assert.deepEqual(pushed(), [1, false]);
  h.state = { kind: "ready", maxFrameBytes: 1 << 20 };
  host.announce(live);
  assert.deepEqual(pushed(), [2, true]);
  host.announce(live);
  assert.deepEqual(pushed(), [2, false]);
  // A send that fails is pushed with the next.
  h.conn = { send: () => false, stop() {} };
  live.onWorking(true);
  live.onWorking(false);
  h.conn = { send: (f: Frame) => (sent.push(f), true), stop() {} };
  host.announce(live);
  assert.deepEqual(pushed(), [3, true]);
  // A reload's successor knows what was pushed.
  host.unbind(papi, "reload");
  const next = Host.succeeding(host, "i2", { pi: "t", extension: "t2" });
  const n = next as unknown as { conn: unknown; key: unknown; state: unknown };
  n.conn = { send: (f: Frame) => (sent.push(f), true), stop() {} };
  n.key = { publicKey: new Uint8Array(32).fill(9) };
  n.state = { kind: "ready", maxFrameBytes: 1 << 20 };
  const again = pi.api();
  next.bind(again, pi.ctx(), { type: "session_start", reason: "reload" });
  assert.deepEqual(pushed(), [3, false]);
  next.unbind(again, "quit");
});

// --- Actions ------------------------------------------------------------

const action = (body: SessionMessage["body"]) => create(SessionMessageSchema, { body } as never);
const announcements = (sink: FakeSink) =>
  sink.out.flatMap((m) => (m.body.case === "event" && m.body.value.body.case === "announcement" ? [m.body.value.body.value] : []));

test("models: pi's available list, and the current one with its details", () => {
  const { live } = setup();
  const [r] = ask(live, action({ case: "listModels", value: { requestId: "m1" } } as never));
  assert.ok(r.body.case === "models");
  assert.deepEqual(r.body.value.models.map((m) => [m.model?.provider, m.model?.id, m.model?.name, m.reasoning, m.contextWindow, m.images]), [
    ["p", "m", "Model M", true, 1000n, true],
    ["q", "n", "", false, 0n, false],
  ]);
  assert.equal(r.body.value.current?.model?.id, "m");
  assert.equal(r.body.value.current?.images, false, "current comes from ctx.model itself");
  live.dispose();
});

test("set model: unknown, without credentials, failing, and done with its announcement first", async () => {
  const { pi, sink, live } = setup();
  const set = (id: string, provider = "q") => {
    const replies: SessionMessage[] = [];
    live.onRequest(action({ case: "setModel", value: { requestId: id, model: { provider, id: "n" } } } as never), (r) => {
      replies.push(r);
      sink.out.push(r);
    });
    return replies;
  };
  assert.equal(errorCode(ask(live, action({ case: "setModel", value: { requestId: "x" } } as never))[0]), ErrorCode.INVALID);
  assert.equal(errorCode(set("a", "nope")[0]), ErrorCode.INVALID);
  pi.setModelOutcome = false;
  const noCreds = set("b");
  await Promise.resolve();
  assert.equal(errorCode(noCreds[0]), ErrorCode.PI_FAILED);
  pi.setModelOutcome = new Error("boom");
  const failed = set("c");
  await new Promise((r) => setImmediate(r));
  assert.equal(errorCode(failed[0]), ErrorCode.PI_FAILED);
  pi.setModelOutcome = true;
  sink.out = [];
  const ok = set("d");
  await new Promise((r) => setImmediate(r));
  assert.equal(ok[0].body.case, "accepted");
  const kinds = sink.out.map((m) => (m.body.case === "event" ? m.body.value.body.case : m.body.case));
  assert.deepEqual(kinds, ["announcement", "accepted"]);
  assert.equal(announcements(sink)[0].model?.id, "n");
  live.dispose();
});

test("thinking level: the level pi clamps to is announced before the answer", () => {
  const { pi, sink, live } = setup();
  pi.levels = ["off", "low", "high"];
  const r = ask(live, action({ case: "setThinkingLevel", value: { requestId: "t1", level: 4 /* MEDIUM */ } } as never));
  assert.equal(r[0].body.case, "accepted");
  assert.equal(pi.thinking, "high");
  assert.equal(announcements(sink).at(-1)?.thinkingLevel, 5 /* HIGH */);
  // Unchanged still announces: pi itself would not.
  const before = announcements(sink).length;
  ask(live, action({ case: "setThinkingLevel", value: { requestId: "t2", level: 5 } } as never));
  assert.equal(announcements(sink).length, before + 1);
  assert.equal(errorCode(ask(live, action({ case: "setThinkingLevel", value: { requestId: "t3", level: 0 } } as never))[0]), ErrorCode.INVALID);
  live.dispose();
});

test("rename: trimmed, announced, and refused when empty", () => {
  const { pi, sink, live } = setup();
  assert.equal(ask(live, action({ case: "rename", value: { requestId: "n1", name: "  fix the tests " } } as never))[0].body.case, "accepted");
  assert.equal(pi.name, "fix the tests");
  assert.equal(announcements(sink).at(-1)?.name, "fix the tests");
  assert.equal(errorCode(ask(live, action({ case: "rename", value: { requestId: "n2", name: "  " } } as never))[0]), ErrorCode.INVALID);
  live.dispose();
});

test("compact: refused while working, compacting at once, answered at the end", () => {
  const { pi, sink, live } = setup();
  const compact = (id: string) => ask(live, action({ case: "compact", value: { requestId: id, instructions: "" } } as never));
  pi.idle = false;
  assert.equal(errorCode(compact("c0")[0]), ErrorCode.BUSY);
  pi.idle = true;
  const replies = compact("c1");
  assert.equal(replies.length, 0);
  assert.equal(pi.compactions[0].customInstructions, undefined);
  assert.equal(announcements(sink).at(-1)?.compacting, true, "compacting from the request, before pi's hook");
  assert.equal(errorCode(compact("c2")[0]), ErrorCode.BUSY, "a second one in the window before pi's hook");
  // pi's hooks, then its callback.
  live.onCompactStart();
  live.onCompact({ id: "e9", timestamp: "2026-10-23T00:00:00.000Z", summary: "s", tokensBefore: 10 });
  assert.equal(replies.length, 0);
  pi.compactions[0].onComplete!({});
  assert.equal(replies[0].body.case, "accepted");
  assert.equal(replies[0].body.case === "accepted" && replies[0].body.value.requestId, "c1");
  assert.equal(announcements(sink).at(-1)?.compacting, false);
  assert.equal(sink.items().at(-1)?.body.case, "compaction");
  // A failure, before pi's hook (nothing to compact).
  const failed = compact("c3");
  pi.compactions[1].onError!(new Error("Nothing to compact (session too small)"));
  assert.equal(errorCode(failed[0]), ErrorCode.PI_FAILED);
  assert.equal(announcements(sink).at(-1)?.compacting, false);
  // The session ends mid-compaction.
  const gone = compact("c4");
  live.dispose();
  assert.equal(errorCode(gone[0]), ErrorCode.SESSION_GONE);
  assert.equal(gone[0].body.case === "error" && gone[0].body.value.requestId, "c4");
  pi.compactions[2].onComplete!({});
  assert.equal(gone.length, 1);
});

test("stats: pi's totals over the whole file, and context use", () => {
  const { pi, live } = setup();
  const u = (n: number, cost: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n, totalTokens: 4 * n, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
  pi.entries = [
    { type: "message", id: "a", message: { role: "assistant", usage: u(1, 0.5) } },
    { type: "message", id: "b", message: { role: "toolResult", usage: u(2, 0.25) } },
    { type: "message", id: "c", message: { role: "user" } },
    { type: "compaction", id: "d", usage: u(3, 0.125) },
    { type: "branch_summary", id: "e" },
    { type: "usage", id: "f", usage: u(4, 0.0625) },
  ] as unknown as SessionEntry[];
  const [r] = ask(live, action({ case: "statsRequest", value: { requestId: "s1" } } as never));
  assert.ok(r.body.case === "stats");
  assert.deepEqual([r.body.value.total?.inputTokens, r.body.value.total?.cacheWriteTokens, r.body.value.total?.cost], [10n, 10n, 0.9375]);
  assert.deepEqual([r.body.value.contextTokens, r.body.value.contextWindow], [250n, 1000n]);
  pi.contextUsage = { tokens: null, contextWindow: 1000, percent: null };
  const [after] = ask(live, action({ case: "statsRequest", value: { requestId: "s2" } } as never));
  assert.ok(after.body.case === "stats" && after.body.value.contextTokens === undefined);
  live.dispose();
});

test("commands: PiRC's own are neither listed nor run as prompt text, nor are pi's built-ins", () => {
  const { pi, live } = setup();
  pi.commands = [{ name: "pirc", source: "extension" }, { name: "pirc:new", source: "extension" }, { name: "review", source: "prompt", description: "Review" }, { name: "deploy", source: "extension" }];
  const [r] = ask(live, action({ case: "listCommands", value: { requestId: "l1" } } as never));
  assert.ok(r.body.case === "commands");
  assert.deepEqual(r.body.value.commands.map((c) => [c.name, c.description, c.source]), [["review", "Review", 2], ["deploy", "", 1]]);
  for (const text of ["/pirc enrol ws://evil:1 t", "/pirc:new", "/tree", "/compact now"]) {
    const [e] = ask(live, prompt("x", text));
    assert.equal(errorCode(e), ErrorCode.INVALID, text);
  }
  const [c] = ask(live, prompt("y", "/compact"));
  assert.ok(c.body.case === "error" && c.body.value.message.includes("use the compact action"));
  assert.equal(pi.sent.length, 0);
  // Not commands: a path, and an extension's own command.
  ask(live, prompt("z", "/usr/bin is odd"));
  ask(live, prompt("w", "/deploy"));
  assert.equal(pi.sent.length, 2);
  live.dispose();
});

test("new session: answered as the old session shuts down, before its end goes out", () => {
  const pi = new FakePi("s1");
  const { host, papi, request, replies } = hostWith(pi);
  const sent = (host as unknown as { conn: { send(f: Frame): void } }).conn;
  const frames: string[] = [];
  const send = sent.send;
  sent.send = (f: Frame) => {
    frames.push(f.body.case === "routed" ? fromRouted(f.body.value.payload).body.case! : f.body.case!);
    send(f);
  };
  pi.idle = false;
  request("s1", action({ case: "newSession", value: { requestId: "n0" } } as never));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.BUSY);
  pi.idle = true;
  request("s1", action({ case: "newSession", value: { requestId: "n1" } } as never));
  assert.deepEqual(pi.sent.at(-1), { content: "/pirc:new", options: { deliverAs: "followUp", expandPromptTemplates: true } });
  request("s1", action({ case: "compact", value: { requestId: "c1" } } as never));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.BUSY, "no compaction while a new session starts");
  frames.length = 0;
  host.unbind(papi, "new");
  const last = replies().at(-1)!;
  assert.ok(last.body.case === "accepted" && last.body.value.requestId === "n1");
  assert.deepEqual(frames, ["accepted", "sessionEnd"]);
});

test("new session: cancelled by another extension, or never started", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const pi = new FakePi("s1");
    const { host, papi, request, replies } = hostWith(pi);
    request("s1", action({ case: "newSession", value: { requestId: "n1" } } as never));
    host.liveFor(papi)!.onCommandRan("new", "another extension cancelled the new session");
    const r = replies().at(-1)!;
    assert.ok(r.body.case === "error" && r.body.value.code === ErrorCode.PI_FAILED && r.body.value.requestId === "n1");
    request("s1", action({ case: "newSession", value: { requestId: "n2" } } as never));
    mock.timers.tick(CONFIRM_MS + 1);
    assert.equal(errorCode(replies().at(-1)), ErrorCode.TIMEOUT);
    // A shutdown for another reason ends it as gone.
    request("s1", action({ case: "newSession", value: { requestId: "n3" } } as never));
    host.unbind(papi, "resume");
    assert.equal(errorCode(replies().at(-1)), ErrorCode.SESSION_GONE);
  } finally {
    mock.timers.reset();
  }
});

test("reload: refused while working, sent as PiRC's command, answered as pi starts it; the session carries on", () => {
  const pi = new FakePi("s1");
  const { host, papi, request, replies } = hostWith(pi);
  pi.idle = false;
  request("s1", action({ case: "reload", value: { requestId: "l0" } } as never));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.BUSY);
  pi.idle = true;
  request("s1", action({ case: "reload", value: { requestId: "l1" } } as never));
  assert.deepEqual(pi.sent.at(-1), { content: "/pirc:reload", options: { deliverAs: "followUp", expandPromptTemplates: true } });
  request("s1", action({ case: "newSession", value: { requestId: "n1" } } as never));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.BUSY, "no new session while pi reloads");
  // A shutdown for another reason does not answer it.
  host.liveFor(papi)!.onShutdown("new");
  assert.equal(errorCode(replies().at(-1)), ErrorCode.BUSY);
  const live = host.liveFor(papi);
  host.unbind(papi, "reload");
  const last = replies().at(-1)!;
  assert.ok(last.body.case === "accepted" && last.body.value.requestId === "l1");
  const again = pi.api();
  host.bind(again, pi.ctx(), { type: "session_start", reason: "reload" });
  assert.equal(host.liveFor(again), live, "the same session");
  request("s1", prompt("p1", "hello"));
  assert.equal(pi.sent.at(-1)?.content, "hello");
});

test("fork: only before a user message, answered as pi forks; clone: once there is something to copy", () => {
  const pi = new FakePi("s1");
  const { host, papi, request, replies } = hostWith(pi);
  request("s1", action({ case: "clone", value: { requestId: "k0" } } as never));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.INVALID, "nothing to clone yet");
  const user = pi.persist({ role: "user", content: "hi", timestamp: 0 } as AgentMessage);
  const reply = pi.persist({ role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 0 } as unknown as AgentMessage);
  // pi exits if asked to branch a session it has not written yet.
  pi.sessionFile = "/nonexistent/session.jsonl";
  request("s1", action({ case: "clone", value: { requestId: "k-unsaved" } } as never));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.INVALID, "not saved yet");
  pi.sessionFile = undefined;
  const sent = pi.sent.length;
  for (const entryId of [reply, "nope", ""]) {
    request("s1", action({ case: "fork", value: { requestId: `f-${entryId}`, entryId } } as never));
    assert.equal(errorCode(replies().at(-1)), ErrorCode.INVALID, `not forkable: ${entryId}`);
  }
  assert.equal(pi.sent.length, sent, "nothing reaches pi");
  pi.idle = false;
  request("s1", action({ case: "fork", value: { requestId: "f0", entryId: user } } as never));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.BUSY);
  pi.idle = true;
  request("s1", action({ case: "fork", value: { requestId: "f1", entryId: user } } as never));
  assert.deepEqual(pi.sent.at(-1), { content: `/pirc:fork ${user}`, options: { deliverAs: "followUp", expandPromptTemplates: true } });
  request("s1", action({ case: "clone", value: { requestId: "k1" } } as never));
  assert.equal(errorCode(replies().at(-1)), ErrorCode.BUSY, "one replacement at a time");
  host.unbind(papi, "fork");
  const last = replies().at(-1)!;
  assert.ok(last.body.case === "accepted" && last.body.value.requestId === "f1");
});

test("clone: sent as PiRC's command, and a shutdown for a new session does not answer it", () => {
  const pi = new FakePi("s1");
  const { host, papi, request, replies } = hostWith(pi);
  pi.persist({ role: "user", content: "hi", timestamp: 0 } as AgentMessage);
  request("s1", action({ case: "clone", value: { requestId: "k1" } } as never));
  assert.deepEqual(pi.sent.at(-1), { content: "/pirc:clone", options: { deliverAs: "followUp", expandPromptTemplates: true } });
  host.unbind(papi, "new");
  assert.equal(errorCode(replies().at(-1)), ErrorCode.SESSION_GONE);
});

function savedSessions(pi: FakePi) {
  const at = (d: number) => new Date(Date.UTC(2026, 9, d));
  pi.sessionFile = "/sessions/now.jsonl";
  pi.saved = [
    { path: "/sessions/now.jsonl", id: "s1", cwd: pi.folder, created: at(20), modified: at(27), messageCount: 2, firstMessage: "this one" },
    { path: "/sessions/a.jsonl", id: "a", cwd: pi.folder, name: "Named", created: at(20), modified: at(26), messageCount: 4, firstMessage: "\n" + "long ".repeat(50) },
    { path: "/other/b.jsonl", id: "b", cwd: "/", created: at(19), modified: at(25), messageCount: 1, firstMessage: "elsewhere" },
    { path: "/sessions/gone.jsonl", id: "g", cwd: "/nonexistent/folder", created: at(18), modified: at(24), messageCount: 1, firstMessage: "gone" },
  ];
}

// Waits for done, which file reads by the code under test make true later;
// at most 5 seconds, since a loaded machine can be slow.
async function until(done: () => boolean): Promise<void> {
  for (const end = Date.now() + 5000; !done() && Date.now() < end;) await new Promise((r) => setTimeout(r, 5));
}

test("past sessions: this folder's or every folder's, newest first, without this one, cut to fit", async () => {
  const pi = new FakePi("s1");
  const { request, replies, host, papi } = hostWith(pi);
  savedSessions(pi);
  const list = async (allFolders: boolean) => {
    const n = replies().filter((m) => m.body.case !== "event").length;
    request("s1", action({ case: "listPastSessions", value: { requestId: `l-${allFolders}`, allFolders } } as never));
    await until(() => replies().filter((m) => m.body.case !== "event").length > n);
    const r = replies().filter((m) => m.body.case !== "event").at(-1)!;
    assert.equal(r.body.case, "pastSessions");
    return r.body.value as { requestId: string; sessions: { path: string; name: string; firstPrompt: string; messageCount: number }[]; truncated: boolean };
  };
  const here = await list(false);
  assert.equal(here.requestId, "l-false");
  assert.deepEqual(here.sessions.map((s) => s.path), ["/sessions/a.jsonl"]);
  assert.equal(here.sessions[0].name, "Named");
  assert.equal(here.sessions[0].messageCount, 4);
  assert.ok(here.sessions[0].firstPrompt.startsWith("long long") && here.sessions[0].firstPrompt.endsWith("…"), "its first line, cut");
  assert.deepEqual((await list(true)).sessions.map((s) => s.path), ["/sessions/a.jsonl", "/other/b.jsonl", "/sessions/gone.jsonl"]);
  assert.equal((await list(true)).truncated, false);
  (host as unknown as { state: object }).state = { kind: "ready", maxFrameBytes: 512 + 1024 + 250 };
  const cut = await list(true);
  assert.ok(cut.truncated && cut.sessions.length < 3 && cut.sessions[0]?.path === "/sessions/a.jsonl", "the newest kept");
  host.unbind(papi, "quit");
});

test("resume: only a session pi would list, not this one, nor one whose folder is gone; answered as pi resumes", async () => {
  const pi = new FakePi("s1");
  const { request, replies, host, papi } = hostWith(pi);
  savedSessions(pi);
  // Events too go out meanwhile (the place is checked on every request).
  const answers = () => replies().filter((m) => m.body.case !== "event");
  const resume = async (requestId: string, path: string) => {
    const n = answers().length;
    request("s1", action({ case: "resume", value: { requestId, path } } as never));
    // The checks read files; a reply, or a command sent, comes later.
    const sent = pi.sent.length;
    await until(() => answers().length > n || pi.sent.length > sent);
    return answers().at(-1)!;
  };
  const sent = pi.sent.length;
  for (const path of ["", "/sessions/now.jsonl", "/sessions/unknown.jsonl", "/sessions/gone.jsonl"]) {
    assert.equal(errorCode(await resume(`r-${path}`, path)), ErrorCode.INVALID, `not resumable: ${path}`);
  }
  assert.equal(pi.sent.length, sent, "nothing reaches pi");
  pi.idle = false;
  assert.equal(errorCode(await resume("r0", "/other/b.jsonl")), ErrorCode.BUSY);
  pi.idle = true;
  await resume("r1", "/other/b.jsonl");
  assert.deepEqual(pi.sent.at(-1), { content: "/pirc:resume /other/b.jsonl", options: { deliverAs: "followUp", expandPromptTemplates: true } });
  host.unbind(papi, "resume");
  const last = answers().at(-1)!;
  assert.ok(last.body.case === "accepted" && last.body.value.requestId === "r1");
});

test("the announcement lists the requests the session takes; one it does not know is answered by the ID beside it", () => {
  const pi = new FakePi("s1");
  const { host, papi, request, replies } = hostWith(pi);
  const requests = host.liveFor(papi)!.announcement().requests;
  for (const r of ["prompt", "list_past_sessions", "reload", "history_request"]) assert.ok(requests.includes(r), r);
  // A kind of request from a newer client: its body is a field this
  // extension's types lack, so it decodes as none.
  request("s1", create(SessionMessageSchema, { requestId: "r-new" }));
  const r = replies().at(-1)!;
  assert.ok(r.body.case === "error" && r.body.value.code === ErrorCode.INVALID && r.body.value.requestId === "r-new", JSON.stringify(r.body));
});

test("a repeated change runs once", async () => {
  const pi = new FakePi("s1");
  const { request, replies, host, papi } = hostWith(pi);
  const m = action({ case: "setModel", value: { requestId: "r1", model: { provider: "q", id: "n" } } } as never);
  request("s1", m);
  request("s1", m);
  await new Promise((r) => setImmediate(r));
  request("s1", m);
  assert.equal(pi.setModelCalls, 1);
  assert.equal(replies().filter((x) => x.body.case === "accepted").length, 2);
  host.unbind(papi, "quit");
});

test("the built-in commands refused are pi's own list", async () => {
  // pi does not export the list from its package; read its module.
  const main = import.meta.resolve("@earendil-works/pi-coding-agent");
  const { BUILTIN_SLASH_COMMANDS } = (await import(new URL("core/slash-commands.js", main).href)) as { BUILTIN_SLASH_COMMANDS: { name: string }[] };
  assert.deepEqual([...BUILTIN_COMMANDS].sort(), BUILTIN_SLASH_COMMANDS.map((c) => c.name).sort());
});

test("compact waits for a prompt pi has not started yet", () => {
  const { live } = setup();
  ask(live, prompt("r1", "hello"));
  const [r] = ask(live, action({ case: "compact", value: { requestId: "c1" } } as never));
  assert.equal(errorCode(r), ErrorCode.BUSY);
  live.dispose();
});

test("tree: refused for an unknown entry or while working; sent as PiRC's command, summarising as compacting, answered when it has run, after the move goes out", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const { pi, sink, live } = setup();
    const ask1 = pi.persist(user("first"));
    pi.persist(assistant("one"));
    const go = (requestId: string, entryId: string, summarize = false) => ask(live, action({ case: "navigateTree", value: { requestId, entryId, summarize } } as never));
    assert.equal(errorCode(go("t0", "nope")[0]), ErrorCode.INVALID);
    pi.idle = false;
    assert.equal(errorCode(go("t1", ask1)[0]), ErrorCode.BUSY);
    pi.idle = true;
    pi.model = undefined;
    assert.equal(errorCode(go("t2", ask1, true)[0]), ErrorCode.PI_FAILED, "a summary needs a model");
    pi.model = { provider: "p", id: "m" };
    assert.equal(pi.sent.length, 0, "nothing reaches pi");

    const replies = go("t3", ask1, true);
    assert.deepEqual(pi.sent.at(-1), { content: `/pirc:tree ${ask1} summarize`, options: { deliverAs: "followUp", expandPromptTemplates: true } });
    assert.equal(announcements(sink).at(-1)?.compacting, true, "compacting while pi summarises");
    assert.equal(ask(live, prompt("p1", "meanwhile"))[0].body.case, "accepted", "held while pi summarises");
    // Running: however long the summary takes.
    live.onCommandStart("tree");
    mock.timers.tick(CONFIRM_MS + 1);
    assert.equal(replies.length, 0);
    sink.out.length = 0;
    live.onTree(null);
    live.onCommandRan("tree", undefined);
    const events = sink.out.flatMap((m) => (m.body.case === "event" ? [m.body.value.body] : []));
    assert.deepEqual(events.map((b) => b.case), ["branchChanged", "announcement"]);
    assert.ok(events[0].case === "branchChanged" && events[0].value.leafId === "");
    assert.equal(announcements(sink).at(-1)?.compacting, false);
    assert.ok(replies[0]?.body.case === "accepted" && replies[0].body.value.requestId === "t3");
    await turn();
    assert.equal(pi.sent.at(-1)?.content, "meanwhile", "sent once the move is done");

    // Not run: TIMEOUT. Cancelled: PI_FAILED.
    const late = go("t4", ask1);
    mock.timers.tick(CONFIRM_MS + 1);
    assert.equal(errorCode(late[0]), ErrorCode.TIMEOUT);
    const refused = go("t5", ask1);
    live.onCommandStart("tree");
    live.onCommandRan("tree", "another extension cancelled the move in the session tree");
    assert.equal(errorCode(refused[0]), ErrorCode.PI_FAILED);
    // Another command's finishing answers nothing.
    const other = go("t6", ask1);
    live.onCommandRan("new", undefined);
    assert.equal(other.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("list tree: the current branch, with what it has", () => {
  const { pi, live } = setup();
  pi.persist(user("what is it?"));
  pi.persist(assistant("this"));
  const [r] = ask(live, action({ case: "listTree", value: { requestId: "l1" } } as never));
  assert.ok(r.body.case === "tree" && r.body.value.requestId === "l1" && !r.body.value.truncated);
  const [b] = r.body.value.branches;
  assert.ok(b.current && b.leafId === "e2" && b.prompt === "what is it?" && b.last === "this" && b.messageCount === 2);
});

test("stop: refused while working; answered, then pi shuts down", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { pi, live } = setup();
    pi.idle = false;
    assert.equal(errorCode(ask(live, create(SessionMessageSchema, { body: { case: "stop", value: { requestId: "s1" } } }))[0]), ErrorCode.BUSY);
    pi.idle = true;
    const r = ask(live, create(SessionMessageSchema, { body: { case: "stop", value: { requestId: "s2" } } }));
    assert.equal(r[0]?.body.case, "accepted");
    assert.equal(pi.shutdowns, 0);
    mock.timers.tick(1000);
    assert.equal(pi.shutdowns, 1);
    live.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("launch: in an existing folder, named, with this pi's command and the launch's ID; refused without a launcher or a folder", async () => {
  const { sink, live } = setup();
  const launch = (requestId: string, cwd: string, name = "") => {
    const replies: SessionMessage[] = [];
    live.onRequest(create(SessionMessageSchema, { body: { case: "launch", value: { requestId, cwd, name } } }), (r) => replies.push(r));
    return replies;
  };
  const r = launch("l1", tmpdir(), " web\n app ");
  await new Promise((res) => setImmediate(res));
  assert.equal(r[0]?.body.case, "accepted");
  assert.equal(sink.launched.length, 1);
  assert.equal(sink.launched[0].cwd, tmpdir());
  assert.equal(sink.launched[0].env.PIRC_LAUNCH, "l1");
  assert.equal(sink.launched[0].name, "web app");
  assert.deepEqual(sink.launched[0].command, [process.execPath, process.argv[1]]);

  assert.equal(errorCode(launch("l2", "/no/such/folder")[0]), ErrorCode.INVALID);
  assert.equal(errorCode(launch("l3", "relative")[0]), ErrorCode.INVALID);
  sink.launchFails = new Error("tmux: no server");
  const failed = launch("l4", tmpdir());
  await new Promise((res) => setImmediate(res));
  assert.equal(errorCode(failed[0]), ErrorCode.PI_FAILED);
  sink.canLaunch = false;
  assert.equal(errorCode(launch("l5", tmpdir())[0]), ErrorCode.INVALID);
  assert.equal(live.announcement().launcher, "");
  sink.canLaunch = true;
  assert.equal(live.announcement().launcher, "tmux");
  live.dispose();
});

test("answer: a client answers a question asked in the terminal, which then closes; a stale or unfitting answer is refused", async () => {
  const { sink, live } = setup();
  const ui = fakeDialogs();
  sink.dialogs.install(ui as never, () => sink.dialogs);
  const asked = (ui as unknown as { confirm(t: string, m: string): Promise<boolean> }).confirm("Delete it?", "build/ goes");
  const [q] = live.announcement().questions;
  assert.equal(q.title, "Delete it?");
  assert.equal(q.message, "build/ goes");
  assert.ok(q.answerable);
  const answer = (requestId: string, value: Answer["value"], questionId = q.id) => {
    const replies: SessionMessage[] = [];
    live.onRequest(create(SessionMessageSchema, { body: { case: "answer", value: { requestId, questionId, value } } }), (r) => replies.push(r));
    return replies[0];
  };
  assert.equal(errorCode(answer("a1", { case: "text", value: "yes" })), ErrorCode.INVALID);
  assert.equal(answer("a2", { case: "confirmed", value: true })?.body.case, "accepted");
  assert.equal(await asked, true);
  assert.equal(ui.open, 0, "the terminal's dialog is still open");
  assert.deepEqual(live.announcement().questions, []);
  assert.equal(errorCode(answer("a3", { case: "confirmed", value: true })), ErrorCode.INVALID);
  live.dispose();
});

test("notices: a turn's end and a new question are announced, numbered upwards; an abort and a question already showing raise none", async () => {
  const { sink, live: before } = setup();
  const ui = fakeDialogs();
  sink.dialogs.install(ui as never, () => sink.dialogs);
  void (ui as unknown as { confirm(t: string, m: string): Promise<boolean> }).confirm("Old?", "");
  before.dispose();
  // A session started with a question showing: not news.
  const { pi } = setup();
  const live = new Live(pi.api(), pi.ctx(), sink, () => new Uint8Array(32), "i1", "startup", "", { pi: "t", extension: "t" });
  live.onQuestionsChanged();
  assert.equal(live.announcement().notice, undefined);
  const turn = (m: AgentMessage) => {
    live.onWorking(true);
    live.onMessageEnd(m);
    live.onWorking(false);
    return announcements(sink).at(-1)?.notice;
  };
  const done = turn(assistant("All done."));
  assert.deepEqual([done?.kind, done?.text], [NoticeKind.FINISHED, "All done."]);
  const aborted = turn({ ...assistant("half"), stopReason: "aborted" } as AgentMessage);
  assert.equal(aborted?.number, done?.number, "an abort leaves the last notice");
  const failed = turn({ ...assistant(""), stopReason: "error", errorMessage: "overloaded" } as AgentMessage);
  assert.deepEqual([failed?.kind, failed?.text], [NoticeKind.FAILED, "overloaded"]);
  assert.ok(failed!.number > done!.number);
  void (ui as unknown as { confirm(t: string, m: string): Promise<boolean> }).confirm("Deploy?", "to prod");
  live.onQuestionsChanged();
  const q = live.announcement().notice;
  assert.deepEqual([q?.kind, q?.text], [NoticeKind.QUESTION, "Deploy? to prod"]);
  assert.ok(q!.number > failed!.number);
  live.onQuestionsChanged();
  assert.equal(live.announcement().notice?.number, q?.number, "the same questions again raise nothing");
  // Carried to the session's next Live in this process.
  const again = new Live(pi.api(), pi.ctx(), sink, () => new Uint8Array(32), "i1", "resume", "", { pi: "t", extension: "t" }, 0n, live.notice);
  assert.equal(again.announcement().notice?.number, q?.number);
  live.dispose();
  again.dispose();
});

// pi's terminal dialogs as far as PiRC sees them: they stay open until
// their signal closes them (or the terminal answers, with answerHere).
function fakeDialogs() {
  const ui = {
    open: 0,
    here: [] as ((v: unknown) => void)[],
    dialog(signal?: AbortSignal, closed: unknown = undefined) {
      ui.open++;
      return new Promise((resolve) => {
        const done = (v: unknown) => {
          ui.open--;
          resolve(v);
        };
        signal?.addEventListener("abort", () => done(closed), { once: true });
        ui.here.push(done);
      });
    },
    select: (_t: string, _o: string[], opts?: { signal?: AbortSignal }) => ui.dialog(opts?.signal),
    confirm: (_t: string, _m: string, opts?: { signal?: AbortSignal }) => ui.dialog(opts?.signal, false),
    input: (_t: string, _p?: string, opts?: { signal?: AbortSignal }) => ui.dialog(opts?.signal),
    editor: () => ui.dialog(),
    custom: () => ui.dialog(),
  };
  return ui;
}

test("a prompt's deadline waits while a question holds its run up", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { sink, live } = setup();
    const ui = fakeDialogs();
    sink.dialogs = new Questions(() => live.onQuestionsChanged());
    sink.dialogs.install(ui as never, () => sink.dialogs);
    const replies: SessionMessage[] = [];
    live.onRequest(create(SessionMessageSchema, { body: { case: "prompt", value: { requestId: "p1", text: "ask first" } } }), (r) => replies.push(r));
    const asked = (ui as unknown as { confirm(t: string, m: string): Promise<boolean> }).confirm("Go?", "");
    mock.timers.tick(CONFIRM_MS * 2);
    assert.deepEqual(replies, []);
    ui.here[0](true);
    await asked;
    mock.timers.tick(CONFIRM_MS - 1);
    assert.deepEqual(replies, []);
    mock.timers.tick(1);
    assert.equal(errorCode(replies[0]), ErrorCode.TIMEOUT);
    live.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("a tool's result says how long it ran, timed here when pi does not record it", () => {
  mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  try {
    const { pi, sink, live } = setup();
    live.onToolStart("t1");
    mock.timers.tick(1_250);
    live.onToolEnd("t1");
    const r = { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 0 } as unknown as AgentMessage;
    live.onMessageEnd(r);
    pi.persist(r);
    live.onWorking(false);
    const [item] = sink.items();
    assert.equal(item.body.case, "toolResult");
    const v = item.body.value as { durationMs?: number; exitCode?: number };
    assert.deepEqual([v.durationMs, v.exitCode], [1_250, 0]);
    live.dispose();
  } finally {
    mock.timers.reset();
  }
});
