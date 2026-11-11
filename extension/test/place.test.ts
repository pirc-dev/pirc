// Where pi runs (place.ts): what other extensions give, tmux and herdr
// detection, and when the tracker says it changed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Place } from "@pirc/protocol";

import { herdrPlace, parseGiven, PlaceTracker, tmuxPlace } from "../src/place.ts";

const plain = (p: Place | undefined | null) => (p ? { kind: p.kind, group: p.group, groupNumber: p.groupNumber, window: p.window, windowNumber: p.windowNumber, pane: p.pane, display: p.display } : p);

test("a place another extension gives: names, none, or back to detection", () => {
  assert.deepEqual(plain(parseGiven({ kind: "zellij", group: " work ", window: "api" })), {
    kind: "zellij", group: "work", groupNumber: undefined, window: "api", windowNumber: undefined, pane: "", display: "",
  });
  assert.equal(parseGiven({}), undefined);
  assert.equal(parseGiven({ kind: "x" }), undefined, "a kind alone names nothing");
  assert.equal(parseGiven(null), null);
  assert.equal(parseGiven({ display: "é".repeat(100) })!.display.length, 64, "cut to 128 bytes on a character");
  assert.equal(parseGiven({ window: "w", windowNumber: -1 })!.windowNumber, undefined);
  assert.throws(() => parseGiven("api"));
  assert.throws(() => parseGiven([]));
});

test("tmux: the session and window pi's pane is in", { skip: !hasTmux() && "no tmux" }, async () => {
  // A tmux server of the test's own, by socket name.
  const server = `pirc-place-${process.pid}`;
  const tmux = (...a: string[]) => execFileSync("tmux", ["-L", server, ...a], { encoding: "utf8" }).trim();
  tmux("-f", "/dev/null", "new-session", "-d", "-s", "my work", "-n", "tests", "sleep 30");
  try {
    const [socket, pane] = tmux("display-message", "-p", "-t", "=my work:", "#{socket_path}\t#{pane_id}").split("\t");
    const env = { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane };
    assert.deepEqual(plain(await tmuxPlace(env)), {
      kind: "tmux", group: "my work", groupNumber: undefined, window: "tests", windowNumber: 0, pane: "", display: "",
    });
    tmux("rename-window", "-t", "=my work:", "renamed");
    assert.equal((await tmuxPlace(env))?.window, "renamed");
    assert.equal(await tmuxPlace({ PATH: process.env.PATH }), undefined, "not in tmux");
  } finally {
    tmux("kill-server");
    // kill-server leaves the socket file behind.
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, server), { force: true });
  }
});

test("herdr: the workspace and tab of pi's pane, over its socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pirc-herdr-"));
  const path = join(dir, "herdr.sock");
  const seen: string[] = [];
  const server = createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const req = JSON.parse(buf.slice(0, i)) as { id: string; method: string; params: Record<string, string> };
        buf = buf.slice(i + 1);
        seen.push(`${req.method} ${JSON.stringify(req.params)}`);
        const result = req.method === "pane.current"
          ? { type: "pane_current", pane: { pane_id: "w2:p1", workspace_id: "w2", tab_id: "t5", label: "agent" } }
          : req.method === "workspace.get"
            ? { type: "workspace_info", workspace: { workspace_id: "w2", number: 2, label: "pirc" } }
            : { type: "tab_info", tab: { tab_id: "t5", number: 3, label: "web" } };
        c.write(`${JSON.stringify({ id: req.id, result })}\n`);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  try {
    const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "w1:p1" };
    assert.deepEqual(plain(await herdrPlace(env)), {
      kind: "herdr", group: "pirc", groupNumber: 2, window: "web", windowNumber: 3, pane: "agent", display: "",
    });
    // The pane asked about by the ID it started with; then its own.
    assert.deepEqual(seen, [
      'pane.current {"caller_pane_id":"w1:p1"}',
      'workspace.get {"workspace_id":"w2"}',
      'tab.get {"tab_id":"t5"}',
    ]);
    assert.equal(await herdrPlace({ HERDR_PANE_ID: "w1:p1" }), undefined, "not in herdr");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tracker: detection on activity, replaced by a given place until null", async () => {
  let detected: Place | undefined = parseGiven({ kind: "tmux", group: "a", window: "1" })!;
  let changes = 0;
  const t = new PlaceTracker(() => changes++, (e) => assert.fail(String(e)), async () => detected);
  await t.refresh();
  assert.equal(t.current?.window, "1");
  assert.equal(changes, 1);
  await t.refresh();
  assert.equal(changes, 1, "unchanged: nothing announced");

  t.give({ display: "my agent" });
  assert.equal(t.current?.display, "my agent");
  assert.equal(changes, 2);
  detected = parseGiven({ kind: "tmux", group: "a", window: "2" })!;
  await t.refresh();
  assert.equal(t.current?.display, "my agent", "a given place stands until null");

  t.give({});
  assert.equal(t.current, undefined, "an empty place shows nothing");
  assert.equal(changes, 3);

  // Handing back announces the detected place even when detection has
  // nothing new to say.
  await t.refresh();
  t.give(null);
  assert.equal((t.current as Place | undefined)?.window, "1", "what was detected before, at once");
  assert.equal(changes, 4);
  await t.refresh();
  assert.equal((t.current as Place | undefined)?.window, "2", "then checked again");
  assert.equal(changes, 5);

  assert.throws(() => t.give("nope"));
});

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
