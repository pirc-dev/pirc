// Applying events to a chat (core/view.ts), past its limit; the rest is
// in cases/functions/view.json.
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyToChat, CHAT_LIMIT, type ChatView } from "../core/view.ts";

test("a chat keeps its latest items, and says older ones were dropped", () => {
  let chat: ChatView = { items: [], truncated: false, loading: false };
  for (let i = 0; i < CHAT_LIMIT + 5; i++) {
    chat = applyToChat(chat, { type: "chatItem", id: "s", item: { kind: "user", id: `u${i}`, turnId: "", at: 0, text: "", images: [] } });
  }
  assert.equal(chat.items.length, CHAT_LIMIT);
  assert.equal(chat.items[0].id, "u5");
  assert.equal(chat.truncated, true);
  chat = applyToChat(chat, { type: "chatDelta", id: "s", itemId: "m", turnId: "", at: 0, block: 0, kind: "text", text: "hi" });
  assert.equal(chat.items.length, CHAT_LIMIT);
  assert.equal(chat.items.at(-1)?.id, "m");
});
