// PiRC's pi extension: puts every interactive pi session on a PiRC relay.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";

import { relayURL } from "@pirc/relay-client";

import { saveRelay } from "./config.ts";
import { Host } from "./host.ts";
import { errorText, SESSION_COMMANDS } from "./live.ts";
import { LAUNCHER_EVENT } from "./launch.ts";
import { loadPhotos, onConverted, PHOTO_ENTRY, photoRenderer, type PiParts } from "./photos.ts";
import { piVersion } from "./pi.ts";
import { PLACE_EVENT } from "./place.ts";

// Set by sh/release.sh when it bundles the extension; "dev" from source.
declare const PIRC_VERSION: string | undefined;
const EXTENSION_VERSION = typeof PIRC_VERSION === "string" ? PIRC_VERSION : "dev";

// Process-wide state, on globalThis: pi re-runs the factory for every
// session the process has, and can load the extension twice, as separate
// module instances, into one process. Each load gets its own `pi`; the
// host serves the session through the newest one (Host.bind), so the
// other load's handlers find no session and do nothing. Handlers look the
// host up when they run, since a newer load can replace it.
interface ProcessState {
  host: Host;
  // The code that made the host (LOAD).
  load?: string;
  // The pirc:place and pirc:launcher listeners, registered once per
  // process, on the newest load's event bus.
  stopPlace?: () => void;
  stopLauncher?: () => void;
  // Why clients' photos cannot be shown in pi's chat, once said.
  photosProblem?: string;
}
// A release is known by its version; a build from source is new at every
// load, so that /reload always runs the code as it now is.
const LOAD = typeof PIRC_VERSION === "string" ? PIRC_VERSION : `dev ${randomBytes(4).toString("hex")}`;
const KEY = Symbol.for("pirc.extension");
const proc = ((globalThis as Record<symbol, unknown>)[KEY] ??= {}) as ProcessState;
// /reload after an update loads new code into a process whose host the old
// code made (any version, also those from before LOAD was kept): the new
// code takes its session over, else it would run on the old code until pi
// restarts.
if (!proc.host || proc.load !== LOAD) {
  proc.host = Host.succeeding(proc.host, randomBytes(8).toString("hex"), { pi: piVersion(), extension: EXTENSION_VERSION });
  proc.load = LOAD;
}

const USAGE = "usage: /pirc [status | enrol <relay-url> [token] | reconnect]";

export default async function (pi: ExtensionAPI): Promise<void> {
  // Only interactive sessions are put on the relay; `pi -p` runs are not.
  let active = false;

  // Runs a handler for the session this `pi` belongs to, and never lets an
  // error of ours reach pi.
  const on = <T>(where: string, fn: (live: NonNullable<ReturnType<Host["liveFor"]>>, e: T) => void) => (e: T) => {
    const live = proc.host.liveFor(pi);
    if (!live) return;
    try {
      fn(live, e);
    } catch (err) {
      proc.host.fail(where, err);
    }
  };

  // A client's images, after its message in pi's chat (photos.ts). The
  // renderer needs pi-tui by the time pi draws a chat, which it can before
  // session_start; pi waits for this function.
  // The published package's pi-parts.js leaves pi's own modules for it.
  const photos = await loadPhotos((globalThis as Record<symbol, PiParts | undefined>)[Symbol.for("pirc.piParts")]);
  pi.registerEntryRenderer(PHOTO_ENTRY, photoRenderer(
    (id) => {
      // An older load's host, kept by a newer one, may lack it.
      const e = proc.host.entry?.(id);
      return e?.type === "message" ? e.message : undefined;
    },
    () => pi.getSettings(),
  ));
  onConverted(() => proc.host.redraw());

  pi.on("session_start", (e, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    active = true;
    try {
      // Said once a process: why clients' photos cannot be shown.
      if (photos.problem && !proc.photosProblem) {
        proc.photosProblem = photos.problem;
        proc.host.fail("photos", new Error(photos.problem));
        ctx.ui.notify(`pirc: clients' photos cannot be shown in this pi's chat: ${photos.problem}`, "warning");
      }
      proc.host.dialogs.install(ctx.ui, () => proc.host.dialogs);
      proc.host.bind(pi, ctx, e);
      proc.host.log(`photos: ${photos.from}`);
      // A chat pi drew before the session was the extension's has its
      // photos to draw now.
      proc.host.redraw();
    } catch (err) {
      proc.host.fail("session_start", err);
    }
  });
  pi.on("session_shutdown", (e) => {
    if (!active) return;
    try {
      proc.host.unbind(pi, e.reason);
    } catch (err) {
      proc.host.fail("session_shutdown", err);
    }
  });

  pi.on("message_start", on("message_start", (live, e) => live.onMessageStart(e.message)));
  pi.on("message_update", on("message_update", (live, e) => live.onMessageUpdate(e)));
  pi.on("message_end", on("message_end", (live, e) => live.onMessageEnd(e.message)));
  pi.on("tool_execution_start", on("tool_execution_start", (live, e) => live.onToolStart(e.toolCallId)));
  pi.on("tool_execution_update", on("tool_execution_update", (live, e) => live.onToolUpdate(e)));
  pi.on("tool_execution_end", on("tool_execution_end", (live, e) => live.onToolEnd(e.toolCallId)));
  pi.on("agent_start", on("agent_start", (live) => {
    // pi may have made a new ui object since.
    proc.host.dialogs.install(live.ctx.ui, () => proc.host.dialogs);
    live.onWorking(true);
    void proc.host.places.refresh();
  }));
  pi.on("agent_settled", on("agent_settled", (live) => {
    live.onWorking(false);
    void proc.host.places.refresh();
  }));

  // Another extension can say where pi runs (docs/design.md, section 4):
  // an object with names, an empty one for none, or null for detection.
  proc.stopPlace?.();
  proc.stopPlace = pi.events.on(PLACE_EVENT, (data) => {
    try {
      proc.host.places.give(data);
    } catch (err) {
      proc.host.fail(PLACE_EVENT, err);
    }
  });
  // Another extension can open new pis for this one (docs/design.md,
  // section 4): a launcher, false for none, or null for the built-in ones.
  proc.stopLauncher?.();
  proc.stopLauncher = pi.events.on(LAUNCHER_EVENT, (data) => {
    try {
      proc.host.launchers.give(data);
    } catch (err) {
      proc.host.fail(LAUNCHER_EVENT, err);
    }
  });
  pi.on("session_info_changed", on("session_info_changed", (live) => live.onAnnouncementChanged()));
  pi.on("model_select", on("model_select", (live) => live.onAnnouncementChanged()));
  pi.on("thinking_level_select", on("thinking_level_select", (live) => live.onAnnouncementChanged()));
  pi.on("session_before_compact", on("session_before_compact", (live) => live.onCompactStart()));
  pi.on("session_compact", on("session_compact", (live, e) => live.onCompact(e.compactionEntry)));
  pi.on("session_compact_failed", on("session_compact_failed", (live) => live.onCompactEnd()));

  pi.on("session_tree", on("session_tree", (live, e) => live.onTree(e.newLeafId)));

  // A client's NewSession, Fork, Clone, Resume, Reload and NavigateTree
  // (SESSION_COMMANDS). After a replacement, this pi's session is gone.
  for (const [which, c] of Object.entries(SESSION_COMMANDS) as [keyof typeof SESSION_COMMANDS, (typeof SESSION_COMMANDS)[keyof typeof SESSION_COMMANDS]][]) {
    pi.registerCommand(c.name, {
      description: c.description,
      handler: async (args, ctx) => {
        proc.host.liveFor(pi)?.onCommandStart(which);
        let failed: string | undefined;
        try {
          failed = await c.run(args.trim(), ctx);
        } catch (err) {
          failed = errorText(err);
        }
        proc.host.liveFor(pi)?.onCommandRan(which, failed);
      },
    });
  }

  pi.registerCommand("pirc", {
    description: "PiRC: status, enrol <relay-url> [token], reconnect",
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      switch (sub) {
        case "status":
          ctx.ui.notify(proc.host.statusReport(), "info");
          return;
        case "enrol":
        case "enroll": {
          // Without a token, the relay holds the key for its operator to
          // approve.
          const [url, token] = rest;
          if (!url || rest.length > 2) return ctx.ui.notify(USAGE, "error");
          try {
            relayURL(url);
            saveRelay(url);
          } catch (err) {
            return ctx.ui.notify(`pirc: ${(err as Error).message}`, "error");
          }
          proc.host.connect(token);
          ctx.ui.notify(`pirc: enrolling with ${url}; /pirc status shows the result`, "info");
          return;
        }
        case "reconnect":
          proc.host.connect();
          ctx.ui.notify("pirc: reconnecting", "info");
          return;
        default:
          ctx.ui.notify(USAGE, "error");
      }
    },
  });
}
