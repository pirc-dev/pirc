// A question's text in parts (page/src/asked.ts): code, label and value,
// and plain text, its line breaks and indentation kept.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parts } from "../page/src/asked.ts";

test("pi-automode's question: a label and value, a label, a bracketed block as code, then text", () => {
  const message = 'Rule: bash(git push *)\n\nAction:\nbash {\n  "command": "git push nowhere main"\n}\n\nAllow this action to continue to auto-mode classification?';
  assert.deepEqual(parts(message), [
    { kind: "field", label: "Rule", value: "bash(git push *)" },
    { kind: "label", label: "Action" },
    { kind: "code", text: 'bash {\n  "command": "git push nowhere main"\n}' },
    { kind: "text", text: "Allow this action to continue to auto-mode classification?" },
  ]);
});

test("indented lines are code without their shared indentation; plain lines keep their breaks", () => {
  assert.deepEqual(parts("Run these?\nThey change files.\n\n    rm -rf build\n      && make\nOK?"), [
    { kind: "text", text: "Run these?\nThey change files." },
    { kind: "code", text: "rm -rf build\n  && make" },
    { kind: "text", text: "OK?" },
  ]);
});

test("a colon in a sentence or a URL is not a label", () => {
  assert.deepEqual(parts("Open https://example.com/x now?\nIt is 10:30: too late?"), [
    { kind: "text", text: "Open https://example.com/x now?\nIt is 10:30: too late?" },
  ]);
  assert.deepEqual(parts(""), []);
});

test("a block that never closes runs to the end, as code", () => {
  assert.deepEqual(parts("items [\n  1,\n  2"), [{ kind: "code", text: "items [\n  1,\n  2" }]);
});
