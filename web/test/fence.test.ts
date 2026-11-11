// A code block's file, from its opening fence (page/src/fence.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { fence } from "../page/src/fence.ts";

test("a code block's file: after the language, named, or after a colon", () => {
  assert.deepEqual(fence("ts", "src/relay/socket.ts"), { lang: "ts", file: "src/relay/socket.ts" });
  assert.deepEqual(fence("ts", 'title="src/a b.ts" {1,3}'), { lang: "ts", file: "src/a b.ts" });
  assert.deepEqual(fence("sh", "filename=sync.sh"), { lang: "sh", file: "sync.sh" });
  assert.deepEqual(fence("ts:src/a.ts", null), { lang: "ts", file: "src/a.ts" });
});

test("a fence naming only a file takes its language from the extension", () => {
  assert.deepEqual(fence("src/a.TS", null), { lang: "ts", file: "src/a.TS" });
  assert.deepEqual(fence("bin/pirc-deploy", null), { file: "bin/pirc-deploy" });
  assert.deepEqual(fence("Makefile.am", undefined), { lang: "am", file: "Makefile.am" });
});

test("what is not a file names none", () => {
  assert.deepEqual(fence("ts", null), { lang: "ts" });
  assert.deepEqual(fence("python", "{1,3}"), { lang: "python" });
  assert.deepEqual(fence("js", "1.2"), { lang: "js" });
  assert.deepEqual(fence("c++", null), { lang: "c++" });
  assert.deepEqual(fence("diff", "showLineNumbers"), { lang: "diff" });
  assert.deepEqual(fence("js", "// note"), { lang: "js" });
  assert.deepEqual(fence("text", "https://example.com/a"), { lang: "text" });
  assert.deepEqual(fence(null, null), {});
});
