// Where a reply being written is split into blocks parsed apart
// (page/src/blocks.ts): never inside a code fence, a list, a table or a
// quote, nor before an indented line; a reply with reference links stays
// whole.
import assert from "node:assert/strict";
import { test } from "node:test";

import { blocksOf } from "../page/src/blocks.ts";

test("paragraphs, headings and a closed fence split at their blank lines", () => {
  assert.deepEqual(blocksOf("## A\n\nOne.\n\n```ts\nx\n\ny\n```\n\nTwo."), ["## A", "One.", "```ts\nx\n\ny\n```", "Two."]);
});

test("a fence still open keeps the rest whole, its blank lines included", () => {
  assert.deepEqual(blocksOf("One.\n\n```sh\nls\n\npwd"), ["One.", "```sh\nls\n\npwd"]);
});

test("a loose list stays one block, and ends where a paragraph follows it", () => {
  assert.deepEqual(blocksOf("- a\n\n- b\n\n  more of b\n\n1. c\n\nAfter."), ["- a\n\n- b\n\n  more of b\n\n1. c", "After."]);
});

test("a table and a quote are not split from their next lines", () => {
  assert.deepEqual(blocksOf("| a |\n| - |\n\n| b |\n\n> q\n\n> r\n\nEnd."), ["| a |\n| - |\n\n| b |\n\n> q\n\n> r", "End."]);
});

test("reference links or footnotes keep the reply whole", () => {
  const text = "See [the RFC][1].\n\nMore.\n\n[1]: https://example.com";
  assert.deepEqual(blocksOf(text), [text]);
});
