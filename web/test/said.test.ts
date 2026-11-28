// What a screen reader is told of an open chat (page/src/said.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ChatItem, NoticeView, SessionView } from "../core/view.ts";
import { type Heard, said } from "../page/src/said.ts";

const session = (notice?: NoticeView) => ({ id: "s", notice }) as SessionView;
const user = (id: string): ChatItem => ({ kind: "user", id, turnId: id, at: 0, text: "hi", images: [] });
const note = (id: string, level: "info" | "warning" | "error", text: string): ChatItem => ({ kind: "notification", id, turnId: "u1", at: 0, level, text });

test("nothing of what the chat showed when it opened", () => {
  const r = said(undefined, session({ number: 5, kind: "finished", text: "Done." }), [user("u1"), note("n1", "error", "old")], []);
  assert.deepEqual(r.say, []);
  assert.deepEqual(r.heard, { notice: 5, last: "n1", failed: new Set() });
});

test("a reply, a failure and a question, by the session's next notice", () => {
  const was: Heard = { notice: 5, last: "u1", failed: new Set() };
  const items = [user("u1")];
  assert.deepEqual(said(was, session({ number: 6, kind: "finished", text: "All tests pass." }), items, []).say, [{ text: "pi: All tests pass.", urgent: false }]);
  assert.deepEqual(said(was, session({ number: 6, kind: "failed", text: "rate limited" }), items, []).say, [{ text: "pi failed: rate limited", urgent: true }]);
  assert.deepEqual(said(was, session({ number: 6, kind: "question", text: "Allow git push?" }), items, []).say, [{ text: "pi asks: Allow git push?", urgent: false }]);
  assert.deepEqual(said(was, session({ number: 5, kind: "finished", text: "Done." }), items, []).say, []);
});

test("an extension's warning or error after the last item, not an info, not earlier items loaded later", () => {
  const was: Heard = { notice: 0, last: "u1", failed: new Set() };
  const items = [note("old", "error", "from before"), user("u1"), note("n1", "info", "fyi"), note("n2", "warning", "slow"), note("n3", "error", "broke")];
  assert.deepEqual(said(was, session(), items, []).say, [{ text: "Warning: slow", urgent: false }, { text: "Error: broke", urgent: true }]);
  // The chat reset to other items: none is news.
  assert.deepEqual(said(was, session(), [note("x", "error", "?")], []).say, []);
});

test("a message from here not sent, once", () => {
  const was: Heard = { notice: 0, last: "u1", failed: new Set() };
  const r = said(was, session(), [user("u1")], [{ key: 1, state: "failed", error: "pi is gone" }, { key: 2, state: "lost" }, { key: 3, state: "sent" }]);
  assert.deepEqual(r.say, [{ text: "Not sent: pi is gone", urgent: true }, { text: "Not sent: pi stopped first", urgent: true }]);
  assert.deepEqual(said(r.heard, session(), [user("u1")], [{ key: 1, state: "failed", error: "pi is gone" }]).say, []);
});
