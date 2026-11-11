// The web app's commands to a session, as the page sends them and the
// server takes them: POST /api/sessions/<id>/<name> with the body, answered
// with an Outcome of the result named. The server builds each one's
// request from this list (app.ts), and the page's calls are typed by it.
import type { ThinkingName } from "@pirc/protocol";

import type { Result } from "./results.ts";

type Of<K extends Result["kind"]> = Extract<Result, { kind: K }>;

export interface Commands {
  // images: base64, IMAGE_TYPES only, within the IMAGE limits below.
  prompt: { body: { text: string; images?: { mimeType: string; data: string }[]; delivery?: "steer" | "followUp" }; result: Of<"accepted"> };
  abort: { body: object; result: Of<"accepted"> };
  model: { body: { provider: string; id: string }; result: Of<"accepted"> };
  thinking: { body: { level: ThinkingName }; result: Of<"accepted"> };
  compact: { body: { instructions?: string }; result: Of<"accepted"> };
  new: { body: object; result: Of<"accepted"> };
  fork: { body: { entryId: string }; result: Of<"accepted"> };
  clone: { body: object; result: Of<"accepted"> };
  past: { body: { allFolders?: boolean }; result: Of<"pastSessions"> };
  resume: { body: { path: string }; result: Of<"accepted"> };
  reload: { body: object; result: Of<"accepted"> };
  // To an entry of pi's tree: a user message's to go back before it, a
  // branch's leaf to switch to it.
  tree: { body: { entryId: string; summarize?: boolean }; result: Of<"accepted"> };
  branches: { body: object; result: Of<"tree"> };
  rename: { body: { name: string }; result: Of<"accepted"> };
  // Ends the pi process, as quitting it does.
  stop: { body: object; result: Of<"accepted"> };
  // Opens a new pi beside the session's, in the folder given, its window
  // named as given (none: the multiplexer names it); the new session's
  // launchId is the request's ID.
  launch: { body: { cwd: string; name?: string }; result: Of<"accepted"> };
  // Answers one of the session's questions (view.ts, QuestionView): an
  // option's index for a select, yes or no for a confirm, text for an
  // input, or dismissed for any.
  answer: { body: { questionId: string; option?: number; confirmed?: boolean; text?: string; dismissed?: boolean }; result: Of<"accepted"> };
  stats: { body: object; result: Of<"stats"> };
  models: { body: object; result: Of<"models"> };
}

export type CommandName = keyof Commands;

// Images in a prompt (docs/web.md, section 6): the page shrinks each to fit
// IMAGE_SIDE, pi's own limit, and the server refuses more or larger, so
// that a prompt stays well within one relay frame.
export const IMAGES_MAX = 4;
export const IMAGE_SIDE = 2000;
export const IMAGE_BYTES_MAX = 2 << 20;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// requestId, when the page gives one, names the request end to end: the
// page makes it once per message and sends it again with a retry, so a
// prompt pi already has is not run twice (extension/src/host.ts). The
// server makes one otherwise.
export type Body<K extends CommandName> = Commands[K]["body"] & { requestId?: string };

export type Answer<K extends CommandName> =
  | { ok: true; result: Commands[K]["result"] }
  // code is ErrorCode's name without its prefix, e.g. "BUSY", "TIMEOUT".
  | { ok: false; code: string; message: string };

// The relay's own requests, answered alike. Approving or rejecting a host
// asking to join: POST /api/hosts/approve with {key, label?},
// /api/hosts/reject with {key}, the key as the relay shows it (view.ts,
// PendingHostView). Renaming a registered device: POST
// /api/devices/rename with {key, label}; removing one, /api/devices/remove
// with {key} (view.ts, DeviceView).
export type RelayAnswer = { ok: true } | { ok: false; code: string; message: string };

// A one-time token for a new device, valid for 15 minutes: POST
// /api/devices/invite with {role: "host" | "client", label?}. Answered
// with the token, when it expires, and the relay's URL as this server
// reaches it, which the device is to use too. Shown once; neither the
// server nor the page keeps it.
export type TokenAnswer = { ok: true; token: string; expiresAt: number; relay: string } | { ok: false; code: string; message: string };

// A request ID the page made: what the server takes as one.
export const PAGE_REQUEST_ID = /^[A-Za-z0-9-]{16,64}$/;
