// Where pi runs: the tmux session and window, or the herdr workspace and
// tab, it is in, or a place another pi extension gives through the
// pirc:place event (docs/design.md, section 4). Checked on activity only,
// never on a timer: the session starting, a prompt, a turn, a reconnect, a
// client's request.
import { create } from "@bufbuild/protobuf";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";

import { PlaceSchema, type Place } from "@pirc/protocol";
import { cutUtf8 } from "@pirc/relay-client";

// How long a multiplexer has to answer.
const DETECT_MS = 2000;
// The longest name kept (session.proto, Place).
const MAX_NAME = 128;

// What another extension may emit on pirc:place. Any field may be left
// out; an object with none shows nothing; null hands back to detection.
export interface PlaceGiven {
  kind?: string;
  group?: string;
  groupNumber?: number;
  window?: string;
  windowNumber?: number;
  pane?: string;
  display?: string;
}

export const PLACE_EVENT = "pirc:place";

function cut(s: unknown): string {
  return typeof s === "string" ? cutUtf8(s.trim(), MAX_NAME) : "";
}

function num(n: unknown): number | undefined {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 2 ** 32 ? n : undefined;
}

function place(p: PlaceGiven): Place | undefined {
  const v = {
    kind: cut(p.kind),
    group: cut(p.group),
    window: cut(p.window),
    pane: cut(p.pane),
    display: cut(p.display),
    groupNumber: num(p.groupNumber),
    windowNumber: num(p.windowNumber),
  };
  if (!v.group && !v.window && !v.pane && !v.display) return undefined;
  return create(PlaceSchema, v);
}

// A pirc:place event's data as a place: undefined to show nothing, null to
// hand back to detection, or an error for anything else.
export function parseGiven(data: unknown): Place | undefined | null {
  if (data === null) return null;
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("pirc:place takes an object, or null");
  return place(data as PlaceGiven);
}

// --- tmux -------------------------------------------------------------

export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: DETECT_MS, encoding: "utf8" }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

export async function tmuxPlace(env: NodeJS.ProcessEnv): Promise<Place | undefined> {
  const pane = env.TMUX_PANE;
  if (!env.TMUX || !pane) return undefined;
  // $TMUX names the server's socket, so this asks the server pi runs in.
  const out = await run("tmux", ["display-message", "-p", "-t", pane, "#{session_name}\t#{window_index}\t#{window_name}"], env);
  const [group, windowNumber, window] = out.replace(/\n$/, "").split("\t");
  return place({ kind: "tmux", group, window, windowNumber: Number(windowNumber) });
}

// --- herdr -------------------------------------------------------------

// Requests on herdr's socket, one JSON object per line each way, over one
// connection (herdr's socket API).
export function herdrSession(path: string): { ask(method: string, params: object): Promise<Record<string, unknown>>; close(): void } {
  const socket = createConnection(path);
  let buf = "";
  let n = 0;
  const waiting = new Map<string, { resolve(v: Record<string, unknown>): void; reject(e: Error): void }>();
  const failAll = (e: Error) => {
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  socket.setEncoding("utf8");
  socket.on("data", (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m: { id?: string; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const w = m.id ? waiting.get(m.id) : undefined;
      if (!w) continue;
      waiting.delete(m.id!);
      if (m.result) w.resolve(m.result);
      else w.reject(new Error(`herdr: ${m.error?.message ?? "no result"}`));
    }
  });
  socket.on("error", (e) => failAll(e));
  socket.on("close", () => failAll(new Error("herdr closed the connection")));
  return {
    ask(method, params) {
      const id = `pirc-${++n}`;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close() {
      socket.destroy();
    },
  };
}

// herdr's socket and this process's pane, when pi runs in herdr.
export function herdrPane(env: NodeJS.ProcessEnv): { socket: string; paneId: string } | undefined {
  const path = env.HERDR_SOCKET_PATH;
  const paneId = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !path || !paneId) return undefined;
  return { socket: process.platform === "win32" ? `\\\\.\\pipe\\${path}` : path, paneId };
}

export async function herdrPlace(env: NodeJS.ProcessEnv): Promise<Place | undefined> {
  const at = herdrPane(env);
  if (!at) return undefined;
  const paneId = at.paneId;
  const h = herdrSession(at.socket);
  const timer = setTimeout(() => h.close(), DETECT_MS);
  try {
    // The pane's current workspace and tab: a pane moved to another
    // workspace keeps answering to its first ID.
    const { pane } = (await h.ask("pane.current", { caller_pane_id: paneId })) as { pane?: { workspace_id?: string; tab_id?: string; label?: string } };
    if (!pane?.workspace_id || !pane.tab_id) return undefined;
    const [{ workspace }, { tab }] = (await Promise.all([
      h.ask("workspace.get", { workspace_id: pane.workspace_id }),
      h.ask("tab.get", { tab_id: pane.tab_id }),
    ])) as [{ workspace?: { label?: string; number?: number } }, { tab?: { label?: string; number?: number } }];
    return place({
      kind: "herdr",
      group: workspace?.label,
      groupNumber: workspace?.number,
      window: tab?.label,
      windowNumber: tab?.number,
      pane: pane.label,
    });
  } finally {
    clearTimeout(timer);
    h.close();
  }
}

// What the environment says: herdr's pane before tmux's, since herdr can
// run inside tmux and is then the nearer.
export async function detectPlace(env: NodeJS.ProcessEnv = process.env): Promise<Place | undefined> {
  return (await herdrPlace(env)) ?? (await tmuxPlace(env));
}

// The process's place, kept up to date on activity.
export class PlaceTracker {
  private detected: Place | undefined;
  // Given by another extension: replaces detection until null hands back.
  private given: { place: Place | undefined } | undefined;
  private checking: Promise<void> | undefined;
  private again = false;

  constructor(
    private readonly onChange: () => void,
    private readonly onError: (e: unknown) => void,
    private readonly detect: () => Promise<Place | undefined> = () => detectPlace(),
  ) {}

  get current(): Place | undefined {
    return this.given ? this.given.place : this.detected;
  }

  // From the pirc:place event.
  give(data: unknown): void {
    const before = key(this.current);
    const p = parseGiven(data);
    this.given = p === null ? undefined : { place: p };
    // Handing back shows what was detected last at once, then checks it.
    if (key(this.current) !== before) this.onChange();
    if (p === null) void this.refresh();
  }

  // Checks again; concurrent calls share one check, and a call during one
  // runs another after it.
  refresh(): Promise<void> {
    if (this.given) return Promise.resolve();
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.again = false;
        let p: Place | undefined;
        try {
          p = await this.detect();
        } catch (e) {
          // A multiplexer gone, or slow: keep what was known.
          this.onError(e);
          continue;
        }
        if (this.given) return;
        if (key(p) !== key(this.detected)) {
          this.detected = p;
          this.onChange();
        }
      } while (this.again);
    })().finally(() => (this.checking = undefined));
    return this.checking;
  }
}

function key(p: Place | undefined): string {
  return p ? JSON.stringify([p.kind, p.group, p.groupNumber, p.window, p.windowNumber, p.pane, p.display]) : "";
}
