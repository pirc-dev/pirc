// What the end-to-end tests share: a temporary directory, the Go relay, an
// interactive pi in tmux with the extension and a scripted model, and
// cleanup. Needs go, tmux and pi on PATH.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startFakeModel, type ModelCall } from "../extension/test/fake-model.ts";

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
  // Its registry is made by then, which the commands need.
  const deadline = Date.now() + 10_000;
  while (!log.includes("msg=listening")) {
    if (proc!.exitCode !== null || Date.now() > deadline) throw new Error(`relay did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return relay;
}

// The relay's hosted mode (relay/internal/hosted), built with its tag,
// taking test attestations: its origin is the URL devices sign.
export async function startHostedRelay(h: Harness): Promise<{ origin: string; log: () => string; kill(): Promise<void> }> {
  const bin = join(h.dir, "pirc-relay-hosted");
  execFileSync("go", ["build", "-tags", "hosted", "-o", bin, "./cmd/pirc-relay"], { cwd: join(repo, "relay"), stdio: "inherit" });
  const port = await freePort();
  const origin = `ws://127.0.0.1:${port}`;
  let log = "";
  const proc = spawn(bin, ["serve-hosted", "--plaintext", "--listen", `127.0.0.1:${port}`, "--origin", origin, "--test-attestation", "--data-dir", join(h.dir, "hosted-relay")], { stdio: ["ignore", "ignore", "pipe"] });
  proc.stderr!.on("data", (b) => (log += b));
  h.onCleanup(() => proc.kill());
  const deadline = Date.now() + 10_000;
  while (!log.includes("msg=listening")) {
    if (proc.exitCode !== null || Date.now() > deadline) throw new Error(`hosted relay did not start:\n${log}`);
    await sleep(20);
  }
  return {
    origin,
    log: () => log,
    async kill() {
      if (proc.exitCode !== null) return;
      proc.kill();
      await new Promise((r) => proc.once("exit", r));
    },
  };
}

export interface Pi {
  // Its host.json.
  config: string;
  // The tmux session and window pi runs in, on the harness's own server.
  tmuxSession: string;
  tmuxWindow: string;
  work: string;
  logFile: string;
  keys(...k: string[]): void;
  screen(): string;
  // What the fake model was sent, one entry per request (fake-model.ts).
  modelRequests: ModelCall[];
}

// An interactive pi in tmux, with the extension, enrolled on the relay with
// hostToken, talking to a fake model.
// An empty hostToken starts a host that asks the relay's operator to
// approve it.
// extensions: more pi extensions to load beside PiRC's.
// relay: undefined for a host enrolled nowhere, as before /pirc join.
// o.extension: PiRC's extension to load, else PIRC_E2E_EXTENSION or the
// tree's; o.config: another pi's host.json, for a second install on the
// same machine.
export async function startPi(h: Harness, relay: Relay | undefined, hostToken: string, name = "pi", extensions: string[] = [], o: { extension?: string; config?: string } = {}): Promise<Pi> {
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
  const config = o.config ?? join(h.dir, `${name}-host.json`);
  // A key of its own, so that each pi is a host of its own.
  if (!o.config) writeFileSync(config, JSON.stringify({ ...(relay && { relay: relay.url }), label: `e2e-${name}`, keyFile: join(h.dir, `${name}-host.key`) }));
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
  const extension = o.extension || process.env.PIRC_E2E_EXTENSION || join(repo, "extension");
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
    config,
    tmuxSession: session,
    tmuxWindow: `${name}-window`,
    work,
    logFile,
    keys: (...k) => void execFileSync("tmux", tmux("send-keys", "-t", `=${session}:`, ...k)),
    screen: () => execFileSync("tmux", tmux("capture-pane", "-p", "-t", `=${session}:`), { encoding: "utf8" }),
    modelRequests: model.requests,
  };
}
