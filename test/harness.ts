// What the end-to-end tests share: a temporary directory, the Go relay, an
// interactive pi in tmux with the extension and a scripted model, and
// cleanup. Needs go, tmux and pi on PATH.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startFakeModel } from "../extension/test/fake-model.ts";

export const repo = resolve(import.meta.dirname, "..");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function step(name: string): void {
  console.log(`· ${name}`);
}

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

export class Harness {
  readonly dir = realpathSync(mkdtempSync(join(tmpdir(), "pirc-e2e-")));
  private cleanups: (() => void)[] = [];
  private closed = false;

  // An error no test step caught (a stream's or a socket's) ends the
  // process without passing the test's own finally: clean up then too,
  // or the relay, pi and its tmux server are left running.
  constructor() {
    const bail = (e: unknown) => {
      console.error(e);
      void this.close().finally(() => process.exit(1));
    };
    process.once("uncaughtException", bail);
    process.once("unhandledRejection", bail);
  }

  onCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.cleanups.reverse()) {
      // Every cleanup runs; one that fails says so rather than hide it.
      try {
        c();
      } catch (e) {
        console.error(`cleanup failed: ${(e as Error).message}`);
      }
    }
    if (process.env.PIRC_E2E_KEEP) console.log(`kept ${this.dir}`);
    else {
      await sleep(500); // pi and the relay exiting
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 5 });
    }
  }
}

export interface Relay {
  url: string;
  log: () => string;
  start(): void;
  kill(): Promise<void>;
  // Runs a relay command against its data directory.
  cmd(name: string, ...args: string[]): string;
}

export async function startRelay(h: Harness): Promise<Relay> {
  // A release's binary (sh/release.sh), else one built from the tree.
  let bin = process.env.PIRC_E2E_RELAY_BIN;
  if (!bin) {
    bin = join(h.dir, "pirc-relay");
    execFileSync("go", ["build", "-o", bin, "./cmd/pirc-relay"], { cwd: join(repo, "relay"), stdio: "inherit" });
  }
  const relayBin = bin;
  const data = join(h.dir, "relay");
  const port = await freePort();
  let proc: ChildProcess | undefined;
  let log = "";
  const relay: Relay = {
    url: `ws://127.0.0.1:${port}`,
    log: () => log,
    start() {
      proc = spawn(relayBin, ["serve", "--plaintext", "--listen", `127.0.0.1:${port}`, "--data-dir", data], { stdio: ["ignore", "ignore", "pipe"] });
      proc.stderr!.on("data", (b) => (log += b));
    },
    async kill() {
      if (!proc || proc.exitCode !== null) return;
      const p = proc;
      p.kill();
      await new Promise((r) => p.once("exit", r));
    },
    // The data directory before the rest, which may end in "--" and a key
    // that begins with "-".
    cmd: (name, ...args) => execFileSync(relayBin, [name, "--data-dir", data, ...args], { encoding: "utf8" }).trim(),
  };
  relay.start();
  h.onCleanup(() => proc?.kill());
  return relay;
}

export interface Pi {
  // The tmux session and window pi runs in, on the harness's own server.
  tmuxSession: string;
  tmuxWindow: string;
  work: string;
  logFile: string;
  keys(...k: string[]): void;
  screen(): string;
}

// An interactive pi in tmux, with the extension, enrolled on the relay with
// hostToken, talking to a fake model.
// An empty hostToken starts a host that asks the relay's operator to
// approve it.
// extensions: more pi extensions to load beside PiRC's.
export async function startPi(h: Harness, relay: Relay, hostToken: string, name = "pi", extensions: string[] = []): Promise<Pi> {
  const model = await startFakeModel();
  h.onCleanup(() => model.server.close());
  const agentDir = join(h.dir, `${name}-agent`);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: model.url,
        api: "openai-completions",
        apiKey: "fake",
        models: [
          { id: "fake-1", input: ["text", "image"] },
          { id: "fake-2", name: "Fake Two", reasoning: true, contextWindow: 64000, input: ["text"] },
        ],
      },
    },
  }));
  // Anything older than the last reply can be compacted.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
  const work = join(h.dir, `${name}-work`);
  mkdirSync(work);
  const config = join(h.dir, `${name}-host.json`);
  // A key of its own, so that each pi is a host of its own.
  writeFileSync(config, JSON.stringify({ relay: relay.url, label: `e2e-${name}`, keyFile: join(h.dir, `${name}-host.key`) }));
  const logFile = join(h.dir, `${name}-extension.log`);
  const env = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PIRC_CONFIG: config,
    PIRC_TOKEN: hostToken,
    PIRC_LOG: logFile,
  };
  const session = `pirc-e2e-${process.pid}-${name}`;
  // A release's staged package (sh/release.sh), else the source tree.
  const extension = process.env.PIRC_E2E_EXTENSION || join(repo, "extension");
  const piArgs = ["-ne", "-e", extension, ...extensions.flatMap((e) => ["-e", e]), "-ns", "-np", "-nc", "--model", "fake/fake-1", "--session-dir", join(h.dir, `${name}-sessions`)];
  // Each pi gets a tmux server of its own, by socket name: the tests often
  // run inside someone's tmux, where $TMUX would otherwise send every
  // command, cleanup included, to that server. -f /dev/null keeps their
  // configuration out of it, and the server, started from here, runs pi
  // with this process's PATH.
  const tmux = (...args: string[]) => ["-L", session, ...args];
  // The window is named after the pi, as a person names theirs: PiRC
  // reports the session and window pi runs in (docs/design.md, section 4).
  execFileSync("tmux", ["-f", "/dev/null", ...tmux("new-session", "-d", "-s", session, "-n", `${name}-window`, "-x", "160", "-y", "45", "-c", work, "env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "pi", ...piArgs)]);
  // The server is gone already if pi quit (its only session ended): ask
  // first, and kill only one that is there, so that an error from
  // kill-server is never expected and never hidden. The socket name means
  // it can reach no other server. kill-server leaves the socket file
  // behind.
  h.onCleanup(() => {
    let running = true;
    try {
      execFileSync("tmux", tmux("has-session"), { stdio: "ignore" });
    } catch {
      running = false;
    }
    if (running) execFileSync("tmux", tmux("kill-server"));
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid!()}`, session), { force: true });
  });
  return {
    tmuxSession: session,
    tmuxWindow: `${name}-window`,
    work,
    logFile,
    keys: (...k) => void execFileSync("tmux", tmux("send-keys", "-t", `=${session}:`, ...k)),
    screen: () => execFileSync("tmux", tmux("capture-pane", "-p", "-t", `=${session}:`), { encoding: "utf8" }),
  };
}
