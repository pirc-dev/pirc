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

// Snapshots answer when the test says.
const pending: ((body: unknown) => void)[] = [];
g.fetch = async (url: string) => {
  const body = url.startsWith("/api/auth")
    ? { signedIn: true }
    : await new Promise((resolve) => pending.push(resolve));
  return { ok: true, status: 200, json: async () => body };
};
const snapshot = (id: string) => ({ id, relay: { state: "ready" }, sessions: [], chat: { items: [], truncated: false, loading: false } });
const settle = () => new Promise((r) => setImmediate(r));
const open = () => FakeSource.all.filter((s) => s.readyState !== FakeSource.CLOSED);
const resume = () => docListeners.visibilitychange.forEach((l) => l({}));

const { Live } = await import("../page/src/live.ts");

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
