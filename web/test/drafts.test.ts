// Drafts (page/src/drafts.ts): what is being written in each chat, kept in
// the browser for a week, for the chats written in most recently.
import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};
const { loadDraft, saveDraft } = await import("../page/src/drafts.ts");

test("a draft is kept per chat, cleared when emptied, and forgotten after a week", () => {
  const day = 24 * 3600_000;
  saveDraft("a", "half a thought", 0);
  saveDraft("b", "other", 0);
  assert.equal(loadDraft("a", day), "half a thought");
  assert.equal(loadDraft("b", day), "other");
  saveDraft("a", "  ", day);
  assert.equal(loadDraft("a", day), "");
  assert.equal(loadDraft("b", 8 * day), "");
});

test("only the chats written in most recently keep theirs", () => {
  store.clear();
  for (let i = 0; i < 105; i++) saveDraft(`c${i}`, `text ${i}`, i);
  assert.equal(loadDraft("c0", 200), "");
  assert.equal(loadDraft("c104", 200), "text 104");
  assert.equal(Object.keys(JSON.parse(store.get("pirc.drafts")!)).length, 100);
});
