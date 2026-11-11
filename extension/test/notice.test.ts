import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { NoticeKind, QuestionSchema } from "@pirc/protocol";

import type { AgentMessage } from "../src/convert.ts";
import { nextNumber, noticeText, NOTICE_CHARS, questionNotice, turnNotice } from "../src/notice.ts";

const reply = (o: object): AgentMessage => ({ role: "assistant", content: [], stopReason: "stop", timestamp: 0, ...o }) as unknown as AgentMessage;

test("a notice's text: whitespace made one space, cut to 120 code points with the ellipsis", () => {
  assert.equal(noticeText("  two\n\nlines\tand  spaces "), "two lines and spaces");
  const long = "a".repeat(NOTICE_CHARS + 5);
  assert.equal(noticeText(long), `${"a".repeat(NOTICE_CHARS - 1)}…`);
  assert.equal(noticeText("a".repeat(NOTICE_CHARS)), "a".repeat(NOTICE_CHARS), "exactly 120 is not cut");
  // Emoji are two UTF-16 units each and count once; none is split.
  const emoji = "😀".repeat(NOTICE_CHARS + 1);
  const cut = noticeText(emoji);
  assert.equal([...cut].length, NOTICE_CHARS);
  assert.equal(cut, `${"😀".repeat(NOTICE_CHARS - 1)}…`);
  assert.equal(noticeText("😀".repeat(NOTICE_CHARS)), "😀".repeat(NOTICE_CHARS));
  // A cut that would end in a space ends in the word before it.
  assert.equal(noticeText(`${"a".repeat(NOTICE_CHARS - 2)} b c`), `${"a".repeat(NOTICE_CHARS - 2)}…`);
});

test("numbers are the time, and go up when the clock goes back", () => {
  assert.equal(nextNumber(undefined, 1000), 1000n);
  assert.equal(nextNumber(900n, 1000), 1000n);
  assert.equal(nextNumber(1000n, 1000), 1001n);
  assert.equal(nextNumber(5000n, 1000), 5001n);
});

test("a turn's notice: finished with its text, failed with the error, none for an abort", () => {
  const done = turnNotice(reply({ content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "All" }, { type: "toolCall" }, { type: "text", text: "done." }] }), 7n);
  assert.deepEqual([done?.number, done?.kind, done?.text], [7n, NoticeKind.FINISHED, "All done."]);
  const failed = turnNotice(reply({ stopReason: "error", errorMessage: "429 rate limited", content: [{ type: "text", text: "partial" }] }), 8n);
  assert.deepEqual([failed?.kind, failed?.text], [NoticeKind.FAILED, "429 rate limited"]);
  assert.equal(turnNotice(reply({ stopReason: "aborted" }), 9n), undefined);
  const none = turnNotice(undefined, 10n);
  assert.deepEqual([none?.kind, none?.text], [NoticeKind.FINISHED, ""], "a turn with no reply still ended");
});

test("a question's notice: its title and message", () => {
  const n = questionNotice(create(QuestionSchema, { id: "q", title: "Delete it?", message: "build/ goes" }), 3n);
  assert.deepEqual([n.number, n.kind, n.text], [3n, NoticeKind.QUESTION, "Delete it? build/ goes"]);
});
