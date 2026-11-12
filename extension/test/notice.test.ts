import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { NoticeKind, QuestionSchema } from "@pirc/protocol";

import type { AgentMessage } from "../src/convert.ts";
import { nextNumber, noticeText, NOTICE_CHARS, plainText, questionNotice, turnNotice } from "../src/notice.ts";

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

test("Markdown as the text it reads as", () => {
  const t = (md: string) => noticeText(plainText(md));
  assert.equal(t("## Summary\n\nThe **build** passes, _all_ of it."), "Summary: The build passes, all of it.");
  assert.equal(t("# Done.\nYes"), "Done. Yes", "a heading ending in punctuation gets no colon");
  assert.equal(t("- one\n* two\n+ three\n1. four\n2) five\n- [x] six"), "one two three four five six");
  assert.equal(t("> quoted\n> > twice"), "quoted twice");
  assert.equal(t("See [the guide](https://x.org/g) and ![a chart](c.png), or <https://x.org>."), "See the guide and a chart, or https://x.org.");
  assert.equal(t("Run `**not bold**` and ``a ` tick``."), "Run **not bold** and a ` tick.", "code spans keep what is inside");
  assert.equal(t("Above\n\n---\n\nBelow"), "Above Below");
  assert.equal(t("```ts\nconst a_b = *c*;\n```\nafter"), "const a_b = *c*; after", "a fenced block keeps its code");
  assert.equal(t("~~~\n```\nstill code\n~~~\nout"), "``` still code out");
  assert.equal(t("| File | Lines |\n|---|:---:|\n| a.ts | 3 |"), "File · Lines a.ts · 3");
  assert.equal(t("~~old~~ new, *it* and **bold _both_**"), "old new, it and bold both");
  // What is not markup stays.
  assert.equal(t("snake_case_name, 2 * 3 * 4, a*b, __init__ file"), "snake_case_name, 2 * 3 * 4, a*b, init file");
  assert.equal(t("\\*literal\\* and C:\\path"), "*literal* and C:\\path");
  assert.equal(t("#hashtag and 3. not a list"), "#hashtag and 3. not a list");
  // Marks around code spans, and links within links' addresses.
  assert.equal(t("- **`src/notice.ts`** — adds it"), "src/notice.ts — adds it");
  assert.equal(t("**`npm test` passes**, [`plainText`](src/notice.ts) and *see `x`*"), "npm test passes, plainText and see x");
  assert.equal(t("[Foo](https://en.wikipedia.org/wiki/Foo_(bar)) yes"), "Foo yes");
  assert.equal(t("glob src/**/*.ts and lib/**/*.js, rm build/*"), "glob src/**/*.ts and lib/**/*.js, rm build/*");
  assert.equal(t("\\`not code\\`"), "`not code`");
  assert.equal(t("| `x \\| y` | 2 |"), "x | y · 2");
  assert.equal(t("Title\n=====\nbody"), "Title body");
  // A long reply is read only as far as a notice needs.
  const start = Date.now();
  assert.equal(t(`# a${" ".repeat(40_000)}`).startsWith("a"), true);
  t(" ".repeat(40_000) + "|");
  t("[".repeat(40_000));
  assert.ok(Date.now() - start < 500, "long lines take no time");
});

test("numbers are the time, and go up when the clock goes back", () => {
  assert.equal(nextNumber(undefined, 1000), 1000n);
  assert.equal(nextNumber(900n, 1000), 1000n);
  assert.equal(nextNumber(1000n, 1000), 1001n);
  assert.equal(nextNumber(5000n, 1000), 5001n);
});

test("a turn's notice: finished with its text, failed with the error, none for an abort", () => {
  const done = turnNotice(reply({ content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "All" }, { type: "toolCall" }, { type: "text", text: "**done**." }] }), 7n);
  assert.deepEqual([done?.number, done?.kind, done?.text], [7n, NoticeKind.FINISHED, "All done."], "as plain text");
  const failed = turnNotice(reply({ stopReason: "error", errorMessage: "429 rate limited", content: [{ type: "text", text: "partial" }] }), 8n);
  assert.deepEqual([failed?.kind, failed?.text], [NoticeKind.FAILED, "429 rate limited"]);
  assert.equal(turnNotice(reply({ stopReason: "aborted" }), 9n), undefined);
  const none = turnNotice(undefined, 10n);
  assert.deepEqual([none?.kind, none?.text], [NoticeKind.FINISHED, ""], "a turn with no reply still ended");
});

test("a question's notice: its title and message", () => {
  const n = questionNotice(create(QuestionSchema, { id: "q", title: "Delete it?", message: "`build/` goes" }), 3n);
  assert.deepEqual([n.number, n.kind, n.text], [3n, NoticeKind.QUESTION, "Delete it? build/ goes"]);
});
