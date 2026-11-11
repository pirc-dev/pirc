// The host's PiRC configuration: which relay, and where the host key is.
//
// One JSON file, by default $XDG_CONFIG_HOME/pirc/host.json (else
// ~/.config/pirc/host.json), or the file PIRC_CONFIG names:
//
//   { "relay": "wss://relay.example:8443", "keyFile": "...", "label": "..." }
//
// PIRC_RELAY overrides "relay", and PIRC_TOKEN supplies a registration
// token, so a host can be enrolled without the /pirc command. A relay and no
// token enrols too, once the relay's operator approves the host's key.
// "removed" records when the relay removed the host's key while it was
// connected: the host does not connect again until /pirc enrol is run.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

export interface HostConfig {
  // Unset until the host is enrolled.
  relay?: string;
  keyFile: string;
  label: string;
  token?: string;
  // When the relay removed this host, as an ISO time.
  removed?: string;
  path: string;
}

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pirc");
}

export function configPath(): string {
  return process.env.PIRC_CONFIG || join(configDir(), "host.json");
}

interface FileConfig {
  relay?: string;
  keyFile?: string;
  label?: string;
  removed?: string;
}

function readFile(path: string): FileConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

export function loadConfig(): HostConfig {
  const path = configPath();
  const f = readFile(path);
  return {
    relay: process.env.PIRC_RELAY || f.relay,
    keyFile: f.keyFile || join(dirname(path), "host.key"),
    label: f.label || hostname(),
    token: process.env.PIRC_TOKEN || undefined,
    removed: f.removed,
    path,
  };
}

// Records the relay in the file, keeping its other settings: enrolling,
// which forgets a removal.
export function saveRelay(relay: string): void {
  const { removed: _, ...f } = readFile(configPath());
  write({ ...f, relay });
}

// Records that the relay removed this host.
export function saveRemoved(at: Date): void {
  write({ ...readFile(configPath()), removed: at.toISOString() });
}

function write(f: FileConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}
