// What PiRC's services on Node have on their command line (the web app's
// server, pirc-web): their data directory, settings from the environment, a
// JSON file written whole, and enrolling with a relay. Not for the extension, which runs inside pi.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { RelayConnection, relayURL, type ConnectionState } from "./connection.ts";
import { loadOrCreateKey } from "./keys.ts";

export class Cli {
  // name is the command's, which its messages start with.
  constructor(readonly name: string) {}

  die(msg: string): never {
    console.error(`${this.name}: ${msg}`);
    process.exit(1);
  }

  // The data directory: the flag's, else the variable's, else
  // $XDG_CONFIG_HOME/pirc/<sub>.
  dataDir(flag: string | undefined, variable: string, sub: string): string {
    return flag || process.env[variable] || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pirc", sub);
  }

  // Refuses a data directory owned by another user: its files are created
  // 0600, so one run as root would lock a service's user out.
  checkOwner(dir: string): void {
    let uid: number;
    try {
      uid = statSync(dir).uid;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (uid === process.getuid?.()) return;
    let owner = String(uid);
    try {
      owner = execFileSync("id", ["-nu", owner], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || owner;
    } catch {
      // Not every uid has a name.
    }
    this.die(`${dir} belongs to user ${owner}; run this command as that user (for example sudo -u ${owner} ${this.name} ...)`);
  }

  // A variable from the environment; an empty one counts as unset.
  env(name: string): string | undefined {
    return process.env[name] || undefined;
  }

  envBool(name: string): boolean {
    const v = this.env(name);
    if (v === undefined || v === "false") return false;
    if (v === "true") return true;
    return this.die(`${name} must be true or false, not ${JSON.stringify(v)}`);
  }

  // serve's address, host:port, from --listen or its variable; an IPv6
  // host is given in brackets.
  listen(spec: string | undefined, variable: string): { host: string; port: number; shown: string } {
    const m = spec ? /^(.*):(\d+)$/.exec(spec) : null;
    if (!m) return this.die(`give --listen host:port (or ${variable})`);
    return { host: m[1].replace(/^\[(.*)\]$/, "$1"), port: Number(m[2]), shown: spec! };
  }

  // serve's TLS: a certificate and its key, or plaintext behind a proxy
  // that terminates TLS, never neither.
  tls(cert: string | undefined, key: string | undefined, plaintext: boolean): { cert: Buffer; key: Buffer } | undefined {
    if (Boolean(cert) !== Boolean(key)) this.die("--tls-cert and --tls-key go together");
    if (cert && plaintext) this.die("--plaintext contradicts --tls-cert");
    if (!cert && !plaintext) this.die("TLS is required: give --tls-cert and --tls-key, or --plaintext behind a proxy that terminates TLS");
    return cert ? { cert: readFileSync(cert), key: readFileSync(key!) } : undefined;
  }

  // Registers this service's client key with a relay through a
  // registration token, once: the first answer is the result, the relay's
  // refusal or why it could not be reached (an untrusted certificate, say),
  // and none in 20 seconds is a failure too.
  async enrol(o: { dir: string; url: string; token: string; label: string; software: string }): Promise<void> {
    try {
      relayURL(o.url);
    } catch (e) {
      this.die((e as Error).message);
    }
    const key = loadOrCreateKey(join(o.dir, "client.key"));
    const state = await new Promise<ConnectionState>((resolve) => {
      const conn = new RelayConnection({
        url: o.url, role: "client", key, token: o.token, tokenRetry: false, label: o.label, software: o.software,
        onFrame() {},
        onState: (s) => {
          if (s.kind === "ready" || s.kind === "refused" || s.kind === "offline") {
            conn.stop();
            resolve(s);
          }
        },
      });
      conn.start();
      setTimeout(() => {
        conn.stop();
        resolve({ kind: "offline", reason: "no answer from the relay in 20 s" });
      }, 20_000).unref();
    });
    if (state.kind === "offline") {
      const ca = /self[- ]signed|unable to (verify|get (local )?issuer)/i.test(state.reason) ? "; a certificate from a private CA needs NODE_EXTRA_CA_CERTS set to the CA's file" : "";
      this.die(`cannot reach the relay at ${o.url}: ${state.reason}${ca}`);
    }
    if (state.kind !== "ready") this.die(`the relay refused: ${"reason" in state ? state.reason : state.kind}`);
  }
}

// A JSON file's contents; undefined when there is no file.
export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

// Writes a JSON file whole, 0600, in a 0700 directory: through a temporary
// file and a rename, so a reader never sees half of it.
export function writeJson(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
