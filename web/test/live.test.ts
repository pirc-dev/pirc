// The page's connection logic (page/src/live.ts) in a stand-in browser:
// whatever order loads, resumes and snapshots come in, one stream is open.
import assert from "node:assert/strict";
import { test } from "node:test";

type Listener = (e: { persisted?: boolean }) => void;
const docListeners: Record<string, Listener[]> = {};
const g = globalThis as Record<string, unknown>;
g.document = {
  visibilityState: "visible",
  addEventListener: (t: string, l: Listener) => (docListeners[t] ??= []).push(l),
};
g.window = { addEventListener: () => {} };

class FakeSource {
  static all: FakeSource[] = [];
  static readonly CLOSED = 2;
  readyState = 1;
  onopen?: () => void;
  onmessage?: (m: { data: string; lastEventId: string }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener() {}
  close() {
    this.readyState = FakeSource.CLOSED;
  }
}
g.EventSource = FakeSource;

// Snapshots answer when the test says; an answer with status is an error.
const pending: ((body: unknown) => void)[] = [];
const asked: string[] = [];
// The server out of reach: asking whether signed in fails, as fetch does.
let unreachable = false;
g.fetch = async (url: string) => {
  if (unreachable && url.startsWith("/api/auth")) throw new TypeError("Failed to fetch");
  if (!url.startsWith("/api/auth")) asked.push(url);
  const body = url.startsWith("/api/auth")
    ? { signedIn: true }
    : await new Promise((resolve) => pending.push(resolve));
  const status = (body as { status?: number }).status ?? 200;
  return { ok: status < 400, status, statusText: "failed", json: async () => body };
};
const snapshot = (id: string) => ({ id, relay: { state: "ready" }, sessions: [], chat: { items: [], truncated: false, loading: false } });
const settle = () => new Promise((r) => setImmediate(r));
const open = () => FakeSource.all.filter((s) => s.readyState !== FakeSource.CLOSED);
const resume = () => docListeners.visibilitychange.forEach((l) => l({}));

const { kept, Live } = await import("../page/src/live.ts");

test("waking while a snapshot loads leaves one stream", async () => {
  FakeSource.all = [];
  // Only this test's Live hears the page wake.
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  const live = new Live();
  void live.start();
  await settle();
  const atStart = pending.shift()!;
  void live.watch("abc");
  await settle();
  atStart(snapshot("run.0"));
  pending.shift()!(snapshot("run.5"));
  await settle();
  // The server said the page is too far behind ("reset"): a snapshot is
  // on its way when the phone wakes, twice.
  void (live as unknown as { load(): Promise<void> }).load();
  await settle();
  resume();
  resume();
  pending.shift()!(snapshot("run.9"));
  await settle();
  assert.deepEqual(open().map((s) => s.url), ["/api/events?after=run.9&chat=abc"]);
});

test("a late snapshot from an earlier load is dropped", async () => {
  FakeSource.all = [];
  // Only this test's Live hears the page wake.
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  const live = new Live();
  // Its own load at start, for no chat, answers late (below).
  void live.start();
  await settle();
  const atStart = pending.shift()!;
  void live.watch("abc");
  await settle();
  void live.watch("def");
  await settle();
  pending.shift()!(snapshot("run.1"));
  pending.shift()!(snapshot("run.2"));
  atStart(snapshot("run.0"));
  await settle();
  assert.deepEqual(open().map((s) => s.url), ["/api/events?after=run.2&chat=def"]);
});

test("resuming replaces the stream rather than adding one", async () => {
  FakeSource.all = [];
  // Only this test's Live hears the page wake.
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  const live = new Live();
  // Its own load at start, for no chat, answers late (below).
  void live.start();
  await settle();
  const atStart = pending.shift()!;
  void live.watch("abc");
  await settle();
  atStart(snapshot("run.0"));
  pending.shift()!(snapshot("run.3"));
  await settle();
  resume();
  resume();
  assert.equal(open().length, 1);
});

const user = (id: string) => ({ kind: "user" as const, id, turnId: id, at: 0, text: id, images: [] });
const ids = (n: number, from: number) => Array.from({ length: n }, (_, i) => `m${from + i}`);

// A Live watching chat "abc", whose snapshot holds m100 to m199 of more.
async function watching() {
  FakeSource.all = [];
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  const live = new Live();
  void live.start();
  await settle();
  pending.shift()!(snapshot("run.0"));
  void live.watch("abc");
  await settle();
  pending.shift()!({ ...snapshot("run.1"), chat: { items: ids(100, 100).map(user), truncated: false, loading: false, earlier: true } });
  await settle();
  asked.splice(0);
  const event = (seq: number, e: unknown) => open()[0].onmessage!({ data: JSON.stringify({ id: "abc", ...e as object }), lastEventId: `run.${seq}` });
  return { live, event, chat: () => live.state.chat!.items.map((x) => x.id) };
}

test("earlier items are put first; a change to one not loaded waits for it, and an answer older than that change is asked again", async () => {
  const { live, event, chat } = await watching();
  // Not loaded: left out. Loaded: replaced. New: appended.
  event(2, { type: "chatItem", item: { ...user("m50"), text: "changed" }, old: true });
  event(3, { type: "chatItem", item: { ...user("m150"), text: "changed" }, old: true });
  event(4, { type: "chatItem", item: user("m200") });
  assert.equal(live.state.chat!.items.length, 101);
  assert.equal((live.state.chat!.items[50] as { text: string }).text, "changed");
  const loading = live.older();
  await settle();
  assert.deepEqual(asked.splice(0), ["/api/chat/abc/older?before=m100"]);
  assert.equal(live.state.older.loading, true);
  // Made before the change to m50: asked for again.
  pending.shift()!({ id: "run.1", items: ids(100, 0).map(user), earlier: false });
  await settle();
  assert.deepEqual(asked.splice(0), ["/api/chat/abc/older?before=m100"]);
  pending.shift()!({ id: "run.4", items: ids(100, 0).map((x) => (x === "m50" ? { ...user(x), text: "changed" } : user(x))), earlier: false });
  await loading;
  assert.deepEqual(chat(), [...ids(201, 0)]);
  assert.equal(live.state.chat!.earlier, false);
  assert.deepEqual(live.state.older, { loading: false });
  assert.equal((live.state.chat!.items[50] as { text: string }).text, "changed");
});

test("an answer that comes after the chat was reset is dropped", async () => {
  const { live, event, chat } = await watching();
  const loading = live.older();
  await settle();
  event(2, { type: "chatReset", chat: { items: ["n1", "n2"].map(user), truncated: false, loading: false } });
  pending.shift()!({ id: "run.1", items: ids(100, 0).map(user), earlier: false });
  await loading;
  assert.deepEqual(chat(), ["n1", "n2"]);
  assert.deepEqual(live.state.older, { loading: false });
});

test("a failed load says why, and is tried again when asked; a chat that no longer has the item is loaded again", async () => {
  const { live } = await watching();
  const failing = live.older();
  await settle();
  pending.shift()!({ status: 502, error: "the relay is out of reach" });
  await failing;
  assert.deepEqual(live.state.older, { loading: false, error: "the relay is out of reach" });
  asked.splice(0);
  const again = live.older();
  await settle();
  assert.deepEqual(asked.splice(0), ["/api/chat/abc/older?before=m100"]);
  pending.shift()!({ status: 409, error: "the chat no longer has that message" });
  await again;
  await settle();
  assert.deepEqual(asked.splice(0), ["/api/snapshot?chat=abc"]);
  pending.shift()!(snapshot("run.9"));
  await settle();
});

test("a reset to a chat's latest items keeps the earlier ones loaded when they lead to it; another chat replaces them", () => {
  const was = { items: ids(150, 50).map(user), truncated: false, loading: false, earlier: true };
  const now = { items: ids(101, 100).map(user), truncated: false, loading: false, earlier: true };
  const merged = kept(was, now);
  assert.deepEqual(merged.items.map((x) => x.id), ids(151, 50));
  assert.equal(merged.earlier, true);
  const other = { items: ["n1"].map(user), truncated: false, loading: false, earlier: true };
  assert.equal(kept(was, other), other);
  const whole = { items: ids(3, 0).map(user), truncated: false, loading: false };
  assert.equal(kept(was, whole), whole);
});

test("a server out of reach at start is asked again, at once when the page is shown again, never left on the splash", async () => {
  FakeSource.all = [];
  for (const k of Object.keys(docListeners)) delete docListeners[k];
  unreachable = true;
  const live = new Live();
  await live.start();
  assert.equal(live.state.signedIn, undefined);
  assert.equal(live.state.unreachable, true);
  // Shown again twice while still out of reach: one question at a time.
  resume();
  resume();
  await settle();
  assert.equal(live.state.unreachable, true);
  unreachable = false;
  resume();
  await settle();
  assert.equal(live.state.signedIn, true);
  assert.equal(live.state.unreachable, false);
  pending.shift()!(snapshot("run.0"));
  await settle();
  assert.equal(open().length, 1);
});
