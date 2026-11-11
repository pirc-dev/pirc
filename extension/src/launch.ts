// Opening a new pi beside this one, for a client's Launch: a new tmux window
// in pi's tmux session, a new herdr tab in its workspace, or what another pi
// extension gives through the pirc:launcher event (docs/design.md, section
// 4). The new pi is started like this one, and told which request it
// answers (PIRC_LAUNCH), so that the client can open it.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { herdrPane, herdrSession, run } from "./place.ts";

// How long a multiplexer has to open the window.
const LAUNCH_MS = 5000;

// The variable that tells a launched pi the request it answers.
export const LAUNCH_ENV = "PIRC_LAUNCH";

export const LAUNCHER_EVENT = "pirc:launcher";

// What opens a new pi. launch() resolves once it is opened, or rejects
// with why it could not be; the new pi needs only to run the command in
// the folder with the variables added. name is what to call its window,
// if anything ("" leaves it to the launcher).
export interface Launcher {
  // Announced: "tmux", "herdr", or what the extension calls it.
  name: string;
  launch(o: { cwd: string; command: string[]; env: Record<string, string>; name: string }): Promise<void>;
}

// What another extension may emit on pirc:launcher: a launcher, false to
// turn launching off, or null to hand back to the built-in ones.
export function parseLauncher(data: unknown): Launcher | undefined | null {
  if (data === null) return null;
  if (data === false) return undefined;
  const l = data as Partial<Launcher> | undefined;
  if (typeof l?.name !== "string" || !l.name.trim() || typeof l.launch !== "function") {
    throw new Error("pirc:launcher takes { name, launch({ cwd, command, env, name }) }, false, or null");
  }
  const launch = l.launch.bind(l);
  return { name: l.name.trim().slice(0, 64), launch: async (o) => void (await launch(o)) };
}

// The command that runs this pi again: its runtime and entry point, else
// pi from the PATH.
export function piCommand(argv = process.argv, execPath = process.execPath): string[] {
  const entry = argv[1];
  return entry && existsSync(entry) ? [execPath, entry] : ["pi"];
}

// The variables the new pi gets beyond its terminal's own: pi's and
// PiRC's settings as this pi has them (PI_*, PIRC_*), so that it uses the
// same agent folder and relay, but no one-time token, no launch of its own,
// and not the mark pi sets for what it runs (PI_CODING_AGENT, which pi sets
// on itself too); then the launch's.
export function launchEnv(env: NodeJS.ProcessEnv, launchId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || !/^(PI|PIRC)_/.test(k) || k === "PIRC_TOKEN" || k === LAUNCH_ENV || k === "PI_CODING_AGENT") continue;
    out[k] = v;
  }
  out[LAUNCH_ENV] = launchId;
  return out;
}

// A folder as a client gives it: a leading ~ is the home directory. Why it
// cannot be launched in, if so.
export function launchFolder(cwd: string, home = homedir()): { path: string } | { problem: string } {
  const given = cwd.trim();
  if (!given) return { problem: "no folder given" };
  const path = given === "~" ? home : given.startsWith("~/") ? join(home, given.slice(2)) : given;
  if (!path.startsWith("/")) return { problem: `not a full path: ${given}` };
  try {
    if (!statSync(path).isDirectory()) return { problem: `not a folder: ${path}` };
  } catch {
    return { problem: `no such folder: ${path}` };
  }
  return { path };
}

// A window's name as a client gives it: one line, without control
// characters, and not too long for a status bar.
export function launchName(name: string): string {
  return name.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, 64);
}

// A new window after pi's, in pi's tmux session and server ($TMUX), left
// in the background so that the terminal stays where it is. new-window
// takes a window, not a pane, so pi's pane's window is asked for first.
// A name given turns tmux's automatic renaming off for that window; tmux
// expands formats in it, so a # is doubled to stay one.
export function tmuxLauncher(env: NodeJS.ProcessEnv, exec = run): Launcher | undefined {
  const pane = env.TMUX_PANE;
  if (!env.TMUX || !pane) return undefined;
  return {
    name: "tmux",
    async launch({ cwd, command, env: extra, name }) {
      const window = (await exec("tmux", ["display-message", "-p", "-t", pane, "#{window_id}"], env)).trim();
      if (!window) throw new Error("tmux did not say which window pi is in");
      const vars = Object.entries(extra).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const named = name ? ["-n", name.replaceAll("#", "##")] : [];
      await exec("tmux", ["new-window", "-d", "-a", "-t", window, ...named, "-c", cwd, ...vars, "--", ...command], env);
    },
  };
}

// A new tab in pi's herdr workspace, not focused, labelled with the name
// if given (herdr's layout.apply).
export function herdrLauncher(env: NodeJS.ProcessEnv, connect = herdrSession): Launcher | undefined {
  const at = herdrPane(env);
  if (!at) return undefined;
  return {
    name: "herdr",
    async launch({ cwd, command, env: extra, name }) {
      const h = connect(at.socket);
      const timer = setTimeout(() => h.close(), LAUNCH_MS);
      try {
        const { pane } = (await h.ask("pane.current", { caller_pane_id: at.paneId })) as { pane?: { workspace_id?: string } };
        if (!pane?.workspace_id) throw new Error("herdr did not say which workspace pi is in");
        await h.ask("layout.apply", { workspace_id: pane.workspace_id, ...(name ? { tab_label: name } : {}), focus: false, root: { type: "pane", cwd, command, env: extra } });
      } finally {
        clearTimeout(timer);
        h.close();
      }
    },
  };
}

// herdr's before tmux's, since herdr can run inside tmux and is then the
// nearer, as for the place.
export function builtInLauncher(env: NodeJS.ProcessEnv = process.env): Launcher | undefined {
  return herdrLauncher(env) ?? tmuxLauncher(env);
}

// The process's launcher: given by another extension, else built in.
export class LauncherChoice {
  private given: { launcher: Launcher | undefined } | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly builtIn: Launcher | undefined = builtInLauncher(),
  ) {}

  get current(): Launcher | undefined {
    return this.given ? this.given.launcher : this.builtIn;
  }

  // From the pirc:launcher event.
  give(data: unknown): void {
    const before = this.current?.name ?? "";
    const l = parseLauncher(data);
    this.given = l === null ? undefined : { launcher: l };
    if ((this.current?.name ?? "") !== before) this.onChange();
  }
}
