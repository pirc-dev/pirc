// Opening a new pi beside this one (src/launch.ts): what each launcher asks
// of its multiplexer, the new pi's variables and folder, and launchers
// another extension gives.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { herdrLauncher, LauncherChoice, launchEnv, launchFolder, launchName, parseLauncher, piCommand, tmuxLauncher } from "../src/launch.ts";

test("tmux: a window after pi's, in the background, named, in the folder, with the variables, on pi's server", async () => {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const env = { TMUX: "/tmp/tmux-1/x,1,0", TMUX_PANE: "%3" };
  const l = tmuxLauncher(env, async (cmd, args, e) => (calls.push({ cmd, args, env: e }), args[0] === "display-message" ? "@4\n" : ""));
  assert.equal(l?.name, "tmux");
  await l!.launch({ cwd: "/w", command: ["/node", "/pi.js"], env: { PIRC_LAUNCH: "r1", PI_OFFLINE: "1" }, name: "w #2" });
  assert.deepEqual(calls, [{ cmd: "tmux", args: ["display-message", "-p", "-t", "%3", "#{window_id}"], env }, {
    cmd: "tmux",
    args: ["new-window", "-d", "-a", "-t", "@4", "-n", "w ##2", "-c", "/w", "-e", "PIRC_LAUNCH=r1", "-e", "PI_OFFLINE=1", "--", "/node", "/pi.js"],
    env,
  }]);
  // No name: tmux's own.
  await l!.launch({ cwd: "/w", command: ["pi"], env: {}, name: "" });
  assert.deepEqual(calls[3].args, ["new-window", "-d", "-a", "-t", "@4", "-c", "/w", "--", "pi"]);
  assert.equal(tmuxLauncher({ TMUX_PANE: "%3" }), undefined);
});

test("herdr: a tab in pi's workspace, not focused, labelled, running the command", async () => {
  const asked: [string, object][] = [];
  let closed = 0;
  const l = herdrLauncher({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/run/herdr.sock", HERDR_PANE_ID: "p7" }, () => ({
    ask: async (method, params) => {
      asked.push([method, params]);
      return method === "pane.current" ? { pane: { workspace_id: "w2" } } : {};
    },
    close: () => void closed++,
  }));
  assert.equal(l?.name, "herdr");
  await l!.launch({ cwd: "/w", command: ["pi"], env: { PIRC_LAUNCH: "r1" }, name: "w" });
  await l!.launch({ cwd: "/w", command: ["pi"], env: {}, name: "" });
  assert.deepEqual(asked, [
    ["pane.current", { caller_pane_id: "p7" }],
    ["layout.apply", { workspace_id: "w2", tab_label: "w", focus: false, root: { type: "pane", cwd: "/w", command: ["pi"], env: { PIRC_LAUNCH: "r1" } } }],
    ["pane.current", { caller_pane_id: "p7" }],
    ["layout.apply", { workspace_id: "w2", focus: false, root: { type: "pane", cwd: "/w", command: ["pi"], env: {} } }],
  ]);
  assert.equal(closed, 2);
  assert.equal(herdrLauncher({ HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "p" }), undefined);
});

test("the new pi gets pi's and PiRC's settings, no token, and its launch", () => {
  assert.deepEqual(launchEnv({ PI_CODING_AGENT_DIR: "/a", PIRC_CONFIG: "/c", PIRC_TOKEN: "t", PIRC_LAUNCH: "old", PI_CODING_AGENT: "true", HOME: "/h", PIPE: "x" }, "r2"),
    { PI_CODING_AGENT_DIR: "/a", PIRC_CONFIG: "/c", PIRC_LAUNCH: "r2" });
});

test("the command is this pi's runtime and entry point, else pi", () => {
  const dir = mkdtempSync(join(tmpdir(), "pirc-launch-"));
  const entry = join(dir, "cli.js");
  writeFileSync(entry, "");
  assert.deepEqual(piCommand(["/node", entry], "/node"), ["/node", entry]);
  assert.deepEqual(piCommand(["/node", join(dir, "gone.js")], "/node"), ["pi"]);
});

test("a folder: ~ is home, and it must be a folder that exists, given in full", () => {
  const home = mkdtempSync(join(tmpdir(), "pirc-home-"));
  const file = join(home, "f");
  writeFileSync(file, "");
  assert.deepEqual(launchFolder("~", home), { path: home });
  assert.deepEqual(launchFolder(` ${home} `, home), { path: home });
  assert.deepEqual(launchFolder("~/f", home), { problem: `not a folder: ${file}` });
  assert.deepEqual(launchFolder("~/nope", home), { problem: `no such folder: ${join(home, "nope")}` });
  assert.deepEqual(launchFolder("src", home), { problem: "not a full path: src" });
  assert.deepEqual(launchFolder("", home), { problem: "no folder given" });
});

test("a window's name is one line, without control characters, at most 64 characters", () => {
  assert.equal(launchName("  my\tproject\n\u0007x  "), "my project x");
  assert.equal(launchName("a".repeat(80)), "a".repeat(64));
  assert.equal(launchName(""), "");
});

test("another extension's launcher replaces the built-in one, false turns launching off, null hands back", async () => {
  let changes = 0;
  const builtIn = { name: "tmux", launch: async () => {} };
  const c = new LauncherChoice(() => changes++, builtIn);
  assert.equal(c.current?.name, "tmux");
  const got: object[] = [];
  c.give({ name: " kitty ", launch: (o: object) => void got.push(o) });
  assert.equal(c.current?.name, "kitty");
  await c.current!.launch({ cwd: "/w", command: ["pi"], env: {}, name: "w" });
  assert.deepEqual(got, [{ cwd: "/w", command: ["pi"], env: {}, name: "w" }]);
  c.give(false);
  assert.equal(c.current, undefined);
  c.give(null);
  assert.equal(c.current, builtIn);
  assert.equal(changes, 3);
  assert.throws(() => parseLauncher({ name: "x" }), /pirc:launcher takes/);
  assert.throws(() => c.give("tmux"), /pirc:launcher takes/);
});
