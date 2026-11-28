// Which running pi opens a new one (page/src/beside.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionView } from "../core/view.ts";
import { besideEnded, launchable } from "../page/src/beside.ts";

const s = (id: string, host: string, group: string | undefined, at: number, launcher = true) =>
  ({ id, hostname: host, hostLabel: "", cwd: "~", place: { kind: "tmux", group }, startedAt: at, ...(launcher ? { launcher: "tmux" } : {}) }) as SessionView;

test("the newest that can open one", () => {
  assert.equal(launchable([s("a", "h", "g", 1), s("b", "h", "g", 3), s("c", "h", "g", 5, false)])?.id, "b");
  assert.equal(launchable([s("c", "h", "g", 5, false)]), undefined);
});

test("in an ended session's place: one in its group, else on its machine, never another machine", () => {
  const was = s("x", "h", "work", 0);
  assert.equal(besideEnded(was, [s("a", "h", "infra", 9), s("b", "h", "work", 1), s("c", "other", "work", 9)])?.id, "b");
  assert.equal(besideEnded(was, [s("a", "h", "infra", 9), s("c", "other", "work", 9)])?.id, "a");
  assert.equal(besideEnded(was, [s("c", "other", "work", 9)]), undefined);
  // Itself, should it still be listed, is not.
  assert.equal(besideEnded(was, [was]), undefined);
});
