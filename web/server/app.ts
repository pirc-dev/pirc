// The web app's HTTP server (docs/web.md, sections 2 and 3): the page, the
// passkey sign-in, and for a signed-in page the snapshot, the event stream
// and the commands. Every request is checked for its Host and, where the
// browser says, its origin; everything under /api but signing in needs a
// live session.
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { Delivery, thinkingLevel } from "@pirc/protocol";

import type { Client, RequestBody } from "../core/client.ts";
import { IMAGE_BYTES_MAX, IMAGE_TYPES, IMAGES_MAX, PAGE_REQUEST_ID, type CommandName, type Commands } from "../core/api.ts";
import { outcome, type Result } from "../core/results.ts";
import { Auth, AuthError } from "./auth.ts";
import type { Notifier } from "./notify.ts";
import { clientAddr, type Proxies } from "./proxy.ts";
import { badSubscription, type PushStore, type Subscription } from "./push.ts";
import { wanted, Watchers, type EventLog } from "./stream.ts";

// A heartbeat on the event stream, within any proxy's read timeout; it also
// ends a stream whose sign-in has lapsed while nothing else happens.
export const HEARTBEAT_MS = 15_000;
// Attempts at pairing or signing in, per address and minute.
const ATTEMPTS_PER_MINUTE = 20;
// Request bodies: a passkey's response is a few kilobytes; a prompt can be
// longer. Larger ones are refused before they are read in full.
const SIGN_IN_BODY = 64 << 10;
const COMMAND_BODY = 1 << 20;
// A prompt with its images, base64.
const PROMPT_BODY = COMMAND_BODY + Math.ceil((IMAGES_MAX * IMAGE_BYTES_MAX * 4) / 3) + (64 << 10);
// Events queued for a page that does not read them (a phone gone off the
// network without closing): past this, its stream ends, and the page
// catches up when it is back.
export const STREAM_BACKLOG = 2000;
// The longest a compaction may keep its command waiting.
const COMPACT_MAX_MS = 15 * 60_000;
// The longest a question may keep a prompt waiting to start.
const ASKING_MAX_MS = 60 * 60_000;

export interface AppOptions {
  auth: Auth;
  client: Client;
  log: EventLog;
  // The built page; none serves the API only (tests).
  pageDir?: string;
  logLine?: (msg: string) => void;
  heartbeatMs?: number;
  // The chats pages are showing, counted from their event streams.
  watchers?: Watchers;
  // Notifications; none leaves the push API out.
  push?: { store: PushStore; notifier: Notifier };
  // The relay's URL as this server reaches it, given with a token for a
  // new device.
  relay?: string;
  // The proxies in front, whose X-Forwarded-For is believed (proxy.ts).
  trustedProxies?: Proxies;
}

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
].join("; ");

class Limiter {
  private hits = new Map<string, number[]>();
  allow(key: string, now = Date.now()): boolean {
    // Forget addresses quiet for a minute.
    if (this.hits.size > 1000) for (const [k, v] of this.hits) if (v.every((t) => now - t >= 60_000)) this.hits.delete(k);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= ATTEMPTS_PER_MINUTE) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

// A prompt's images as the page sent them (core/api.ts), or why not.
function imagesOf(v: unknown): { mimeType: string; data: Uint8Array }[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return "images are a list";
  if (v.length > IMAGES_MAX) return `at most ${IMAGES_MAX} images`;
  const out = [];
  for (const i of v as { mimeType?: unknown; data?: unknown }[]) {
    const mimeType = str(i?.mimeType);
    const data = str(i?.data);
    if (!mimeType || !IMAGE_TYPES.includes(mimeType)) return `an image is one of ${IMAGE_TYPES.join(", ")}`;
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return "an image's data is base64";
    const bytes = new Uint8Array(Buffer.from(data, "base64"));
    if (bytes.length === 0 || bytes.length > IMAGE_BYTES_MAX) return `an image is at most ${IMAGE_BYTES_MAX >> 20} MiB`;
    out.push({ mimeType, data: bytes });
  }
  return out;
}

// How the server builds each command's request from its body, or why it
// cannot; and the kind of result it answers with.
interface ServerCommand {
  build(b: Record<string, unknown>, requestId: string): RequestBody | string;
  result: Result["kind"];
  // Asked when the deadline passes: true extends it.
  extend?(client: Client, id: string): () => boolean;
}

// A compaction takes minutes; its deadline waits while it runs, up to a
// limit, so a session that says it compacts for ever cannot hold the
// request open.
function whileCompacting(client: Client, id: string): () => boolean {
  const until = Date.now() + COMPACT_MAX_MS;
  return () => client.compacting(id) && Date.now() < until;
}

// A prompt to an idle pi is answered once its run starts, which a question
// asked first (an extension's, before the run) holds up until the person
// answers; its deadline waits meanwhile, as for a compaction.
function whileHeldUp(client: Client, id: string): () => boolean {
  const compacting = whileCompacting(client, id);
  const until = Date.now() + ASKING_MAX_MS;
  return () => compacting() || (client.asking(id) && Date.now() < until);
}

const COMMANDS: { [K in CommandName]: ServerCommand & { result: Commands[K]["result"]["kind"] } } = {
  prompt: {
    build: (b, requestId) => {
      const text = str(b.text) ?? "";
      const images = imagesOf(b.images);
      if (typeof images === "string") return images;
      if (!text.trim() && images.length === 0) return "a prompt needs text or an image";
      const delivery = b.delivery === "steer" ? Delivery.STEER : b.delivery === "followUp" ? Delivery.FOLLOW_UP : Delivery.UNSPECIFIED;
      return { case: "prompt", value: { requestId, text, images, delivery } };
    },
    result: "accepted",
    extend: whileHeldUp,
  },
  abort: { build: (_b, requestId) => ({ case: "abort", value: { requestId } }), result: "accepted" },
  model: {
    build: (b, requestId) => {
      const provider = str(b.provider);
      const id = str(b.id);
      if (!provider || !id) return "a model needs provider and id";
      return { case: "setModel", value: { requestId, model: { provider, id } } };
    },
    result: "accepted",
  },
  thinking: {
    build: (b, requestId) => {
      const level = thinkingLevel(str(b.level));
      if (level === undefined) return "unknown thinking level";
      return { case: "setThinkingLevel", value: { requestId, level } };
    },
    result: "accepted",
  },
  compact: {
    build: (b, requestId) => ({ case: "compact", value: { requestId, instructions: str(b.instructions) ?? "" } }),
    result: "accepted",
    extend: whileCompacting,
  },
  new: { build: (_b, requestId) => ({ case: "newSession", value: { requestId } }), result: "accepted" },
  fork: {
    build: (b, requestId) => {
      const entryId = str(b.entryId);
      if (!entryId) return "a fork needs the entry of a user message";
      return { case: "fork", value: { requestId, entryId } };
    },
    result: "accepted",
  },
  clone: { build: (_b, requestId) => ({ case: "clone", value: { requestId } }), result: "accepted" },
  past: { build: (b, requestId) => ({ case: "listPastSessions", value: { requestId, allFolders: b.allFolders === true } }), result: "pastSessions" },
  resume: {
    build: (b, requestId) => {
      const path = str(b.path);
      if (!path) return "a resume needs the session's path";
      return { case: "resume", value: { requestId, path } };
    },
    result: "accepted",
  },
  reload: { build: (_b, requestId) => ({ case: "reload", value: { requestId } }), result: "accepted" },
  tree: {
    build: (b, requestId) => {
      const entryId = str(b.entryId);
      if (!entryId) return "a move in the tree needs an entry";
      return { case: "navigateTree", value: { requestId, entryId, summarize: b.summarize === true } };
    },
    result: "accepted",
    // Summarising the branch left is compacting, to pi.
    extend: whileCompacting,
  },
  branches: { build: (_b, requestId) => ({ case: "listTree", value: { requestId } }), result: "tree" },
  rename: {
    build: (b, requestId) => {
      const name = str(b.name)?.trim();
      if (!name) return "a name is needed";
      return { case: "rename", value: { requestId, name } };
    },
    result: "accepted",
  },
  stop: { build: (_b, requestId) => ({ case: "stop", value: { requestId } }), result: "accepted" },
  launch: {
    build: (b, requestId) => {
      const cwd = str(b.cwd)?.trim();
      if (!cwd) return "a launch needs a folder";
      return { case: "launch", value: { requestId, cwd, name: str(b.name)?.trim() ?? "" } };
    },
    result: "accepted",
  },
  answer: {
    build: (b, requestId) => {
      const questionId = str(b.questionId);
      if (!questionId) return "an answer needs its question";
      const value = b.dismissed === true ? { case: "dismissed" as const, value: true }
        : typeof b.option === "number" && Number.isInteger(b.option) && b.option >= 0 ? { case: "option" as const, value: b.option }
        : typeof b.confirmed === "boolean" ? { case: "confirmed" as const, value: b.confirmed }
        : typeof b.text === "string" ? { case: "text" as const, value: b.text }
        : undefined;
      if (!value) return "an answer is an option, yes or no, text, or dismissed";
      return { case: "answer", value: { requestId, questionId, value } };
    },
    result: "accepted",
  },
  stats: { build: (_b, requestId) => ({ case: "statsRequest", value: { requestId } }), result: "stats" },
  models: { build: (_b, requestId) => ({ case: "listModels", value: { requestId } }), result: "models" },
};

export function createApp(o: AppOptions): Hono {
  const app = new Hono();
  const origin = new URL(o.auth.rp.origin);
  const secure = origin.protocol === "https:";
  // __Host- makes the browser refuse the cookie unless it is Secure, for
  // this host only and for every path; plain http is for local testing.
  const COOKIE = secure ? "__Host-pirc-session" : "pirc-session";
  const limiter = new Limiter();
  const heartbeat = o.heartbeatMs ?? HEARTBEAT_MS;
  const watchers = o.watchers ?? new Watchers();

  // The client's address, behind trusted proxies the one they saw: what
  // the sign-in limit counts by, and the logs show.
  const remote = (c: Context) => {
    let peer: string | undefined;
    try {
      peer = getConnInfo(c).remote.address;
    } catch {
      peer = undefined;
    }
    return clientAddr(peer, c.req.header("x-forwarded-for"), o.trustedProxies);
  };

  // Every request: our own host name (a page on another site resolving its
  // name to this address must not reach us), not sent from another site,
  // except for opening the page itself from a link elsewhere.
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (host !== origin.host) return c.text("wrong host\n", 421);
    const site = c.req.header("sec-fetch-site");
    const opening = c.req.method === "GET" && !c.req.path.startsWith("/api/") &&
      c.req.header("sec-fetch-mode") === "navigate" && c.req.header("sec-fetch-dest") === "document";
    if (site && site !== "same-origin" && site !== "none" && !opening) return c.text("cross-site requests are refused\n", 403);
    const from = c.req.header("origin");
    if (from && from !== origin.origin) return c.text("wrong origin\n", 403);
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && from !== origin.origin) return c.text("origin required\n", 403);
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    if (secure) c.header("Strict-Transport-Security", "max-age=31536000");
    // An image is named by its content, so it never changes.
    if (!c.req.path.startsWith("/api/images/")) c.header("Cache-Control", c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store");
  });

  const tooLarge = (c: Context) => c.json({ error: "request too large" }, 413);
  app.use("/api/pair/*", bodyLimit({ maxSize: SIGN_IN_BODY, onError: tooLarge }));
  app.use("/api/login/*", bodyLimit({ maxSize: SIGN_IN_BODY, onError: tooLarge }));
  // A prompt may carry images; nothing else needs more than COMMAND_BODY.
  const promptLimit = bodyLimit({ maxSize: PROMPT_BODY, onError: tooLarge });
  const commandLimit = bodyLimit({ maxSize: COMMAND_BODY, onError: tooLarge });
  app.use("/api/*", (c, next) => (/^\/api\/sessions\/[^/]+\/prompt$/.test(c.req.path) ? promptLimit : commandLimit)(c, next));

  const startSession = (c: Context, secret: string) => {
    setCookie(c, COOKIE, secret, { httpOnly: true, secure, sameSite: "Strict", path: "/" });
  };

  const json = async <T>(c: Context): Promise<T | undefined> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      return undefined;
    }
  };

  const fail = (c: Context, e: unknown) => {
    if (e instanceof AuthError) return c.json({ error: e.message }, 403);
    o.logLine?.(`sign-in: ${(e as Error).message}`);
    return c.json({ error: (e as Error).message || "the passkey could not be verified" }, 400);
  };

  const limited: MiddlewareHandler = async (c, next) => {
    if (!limiter.allow(remote(c))) {
      o.logLine?.(`sign-in attempts from ${remote(c)} limited`);
      return c.json({ error: "too many attempts; wait a minute" }, 429);
    }
    await next();
  };

  // --- Signing in ------------------------------------------------------------------

  app.get("/api/auth", (c) => c.json({ signedIn: o.auth.session(getCookie(c, COOKIE), false) !== undefined }));

  app.post("/api/pair/options", limited, async (c) => {
    const body = await json<{ token?: string }>(c);
    if (!body?.token) return c.json({ error: "no pairing token" }, 400);
    try {
      return c.json(await o.auth.registrationOptions(body.token));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/pair/verify", limited, async (c) => {
    const body = await json<{ response?: unknown }>(c);
    if (!body?.response) return c.json({ error: "no passkey" }, 400);
    try {
      startSession(c, await o.auth.register(body.response as never));
      o.logLine?.(`passkey added from ${remote(c)}`);
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/login/options", limited, async (c) => c.json(await o.auth.authenticationOptions()));

  app.post("/api/login/verify", limited, async (c) => {
    const body = await json<{ response?: unknown }>(c);
    if (!body?.response) return c.json({ error: "no passkey" }, 400);
    try {
      startSession(c, await o.auth.authenticate(body.response as never));
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/api/logout", (c) => {
    o.auth.endSession(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/", secure });
    return c.json({ ok: true });
  });

  // --- Signed in -------------------------------------------------------------------

  // Everything below needs a live session. Only what the person does keeps
  // it alive: the event stream and the snapshots a page loads by itself do
  // not, so a page left open still asks for the passkey after 30 minutes.
  const signedIn = (touch: boolean): MiddlewareHandler => async (c, next) => {
    if (!o.auth.session(getCookie(c, COOKIE), touch)) return c.json({ error: "signed out" }, 401);
    await next();
  };

  app.post("/api/alive", signedIn(true), (c) => c.json({ ok: true }));

  app.get("/api/snapshot", signedIn(false), (c) => {
    const chat = c.req.query("chat");
    return c.json({
      id: o.log.id(o.log.seq),
      ...o.client.snapshot(),
      ...(chat ? { chat: o.client.chat(chat) ?? null } : {}),
    });
  });

  // Written here rather than with Hono's streamSSE, whose
  // Transfer-Encoding header Node's HTTP/2 refuses, killing the process.
  app.get("/api/events", signedIn(false), (c) => {
    const chat = c.req.query("chat") || undefined;
    const secret = getCookie(c, COOKIE);
    const from = o.log.parse(c.req.header("last-event-id") ?? c.req.query("after"));
    const enc = new TextEncoder();
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(ctl) {
        const write = (s: string) => ctl.enqueue(enc.encode(s));
        const end = (last?: string) => {
          cleanup();
          if (last) write(last);
          ctl.close();
        };
        const backlog = from === undefined ? undefined : o.log.since(from);
        if (!backlog) {
          // Too far behind, or from another run: load a snapshot first.
          return end("event: reset\ndata: {}\n\n");
        }
        // Checked before every batch, not only when idle: a revoked or
        // lapsed sign-in must stop a busy session's events at once.
        const live = () => o.auth.session(secret, false) !== undefined;
        const send = (seq: number, json: string) => write(`id: ${o.log.id(seq)}\ndata: ${json}\n\n`);
        for (const n of backlog) if (wanted(n.event, chat)) send(n.seq, n.json);
        const stop = o.log.listen((n) => {
          if (!wanted(n.event, chat)) return;
          if (!live()) return end("event: signedOut\ndata: {}\n\n");
          // Chunks the page has not read: past the bound it is gone.
          if ((ctl.desiredSize ?? 0) < -STREAM_BACKLOG) return end();
          send(n.seq, n.json);
        });
        const unwatch = chat ? watchers.add(chat) : () => {};
        const timer = setInterval(() => {
          if (!live()) return end("event: signedOut\ndata: {}\n\n");
          write(": heartbeat\n\n");
        }, heartbeat);
        cleanup = () => {
          stop();
          unwatch();
          clearInterval(timer);
          cleanup = () => {};
        };
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        // Stop the proxy in front, if any, from holding events back.
        "X-Accel-Buffering": "no",
      },
    });
  });

  // Commands to a session (core/api.ts): each answers {ok, result | code
  // and message, id}, where id is the event stream's position once it took
  // effect.
  for (const [name, c] of Object.entries(COMMANDS) as [CommandName, ServerCommand][]) {
    app.post(`/api/sessions/:id/${name}`, signedIn(true), async (ctx) => {
      const id = ctx.req.param("id")!;
      const body = (await json<Record<string, unknown>>(ctx)) ?? {};
      const at = () => o.log.id(o.log.seq);
      const given = body.requestId;
      if (given !== undefined && (typeof given !== "string" || !PAGE_REQUEST_ID.test(given))) {
        return ctx.json({ ok: false, code: "INVALID", message: "a request ID is 16 to 64 letters, digits or dashes", id: at() }, 400);
      }
      const req = c.build(body, given ?? o.client.id());
      if (typeof req === "string") return ctx.json({ ok: false, code: "INVALID", message: req, id: at() }, 400);
      const r = outcome(await o.client.ask(id, req, c.extend?.(o.client, id)));
      // A reply of another kind than the command's is the session's
      // mistake, not an answer.
      if (r.ok && r.result.kind !== c.result) return ctx.json({ ok: false, code: "PI_FAILED", message: `the session answered ${r.result.kind}, not ${c.result}`, id: at() });
      return ctx.json({ ...r, id: at() });
    });
  }

  // Hosts asking to join (core/api.ts): approving or rejecting one, by
  // its key; answered like a command.
  for (const approve of [true, false]) {
    app.post(`/api/hosts/${approve ? "approve" : "reject"}`, signedIn(true), async (ctx) => {
      const body = (await json<Record<string, unknown>>(ctx)) ?? {};
      const key = str(body.key);
      const label = approve ? str(body.label)?.trim() ?? "" : "";
      if (!key) return ctx.json({ ok: false, code: "INVALID", message: "a host's key is needed", id: o.log.id(o.log.seq) }, 400);
      const r = await o.client.decide(key, approve, label);
      if (r.ok) o.logLine?.(`host ${key} ${approve ? "approved" : "rejected"} from ${remote(ctx)}`);
      return ctx.json({ ...r, id: o.log.id(o.log.seq) });
    });
  }

  // A registered device renamed (core/api.ts), by its key; answered like a
  // command.
  app.post("/api/devices/rename", signedIn(true), async (ctx) => {
    const body = (await json<Record<string, unknown>>(ctx)) ?? {};
    const key = str(body.key);
    const label = str(body.label)?.trim() ?? "";
    if (!key || !label) return ctx.json({ ok: false, code: "INVALID", message: "a key and a name are needed", id: o.log.id(o.log.seq) }, 400);
    const r = await o.client.rename(key, label);
    if (r.ok) o.logLine?.(`device ${key} renamed to ${JSON.stringify(label)} from ${remote(ctx)}`);
    return ctx.json({ ...r, id: o.log.id(o.log.seq) });
  });

  // A registered device removed (core/api.ts), by its key; answered like a
  // command.
  app.post("/api/devices/remove", signedIn(true), async (ctx) => {
    const body = (await json<Record<string, unknown>>(ctx)) ?? {};
    const key = str(body.key);
    if (!key) return ctx.json({ ok: false, code: "INVALID", message: "a key is needed", id: o.log.id(o.log.seq) }, 400);
    const r = await o.client.remove(key);
    if (r.ok) o.logLine?.(`device ${key} removed from ${remote(ctx)}`);
    return ctx.json({ ...r, id: o.log.id(o.log.seq) });
  });

  // A token for a new device (core/api.ts), passed on and not kept: the
  // log has its role and label only.
  app.post("/api/devices/invite", signedIn(true), async (ctx) => {
    const body = (await json<Record<string, unknown>>(ctx)) ?? {};
    const role = body.role === "host" || body.role === "client" ? body.role : undefined;
    const label = str(body.label)?.trim() ?? "";
    const id = () => o.log.id(o.log.seq);
    if (!role) return ctx.json({ ok: false, code: "INVALID", message: "a role is needed: host or client", id: id() }, 400);
    if (!o.relay) return ctx.json({ ok: false, code: "INVALID", message: "this server has no relay URL to give", id: id() }, 400);
    const r = await o.client.issueToken(role, label);
    if (!r.ok) return ctx.json({ ...r, id: id() });
    o.logLine?.(`${role} token issued${label ? ` for ${JSON.stringify(label)}` : ""} from ${remote(ctx)}`);
    return ctx.json({ ...r, relay: o.relay, id: id() });
  });

  // Notifications (docs/web.md, section 6): the key a browser subscribes
  // with, its subscription kept for the passkey signed in, and a test
  // notification to it alone.
  if (o.push) {
    const push = o.push;
    app.get("/api/push", signedIn(false), (c) => c.json({ publicKey: push.store.publicKey() }));
    app.post("/api/push/subscribe", signedIn(true), async (c) => {
      const body = (await json<{ subscription?: unknown }>(c)) ?? {};
      const bad = badSubscription(body.subscription, !secure);
      if (bad) return c.json({ ok: false, message: bad }, 400);
      const session = o.auth.session(getCookie(c, COOKIE), false)!;
      push.store.add(body.subscription as Subscription, session.passkeyId);
      return c.json({ ok: true });
    });
    app.post("/api/push/unsubscribe", signedIn(true), async (c) => {
      const endpoint = str((await json<{ endpoint?: unknown }>(c))?.endpoint);
      if (endpoint) push.store.remove(endpoint);
      return c.json({ ok: true });
    });
    app.post("/api/push/test", signedIn(true), async (c) => {
      const endpoint = str((await json<{ endpoint?: unknown }>(c))?.endpoint);
      const sub = push.store.subscriptions().find((x) => x.endpoint === endpoint);
      if (!sub) return c.json({ ok: false, message: "this browser is not subscribed" }, 400);
      const sent = await push.notifier.to(sub, { title: "PiRC", body: "Notifications are on: a session that finishes its turn will say so here.", url: "/", tag: "test" });
      return c.json(sent === "sent" ? { ok: true } : { ok: false, message: sent });
    });
  }

  // The images of user messages (core/images.ts), by the key in the chat.
  // Their type is one the prompt took, or what pi said; nosniff keeps a
  // browser from reading one as anything else.
  app.get("/api/images/:key", signedIn(false), (c) => {
    const it = o.client.image(c.req.param("key"));
    if (!it) return c.json({ error: "not kept" }, 404);
    const type = IMAGE_TYPES.includes(it.mimeType) ? it.mimeType : "application/octet-stream";
    return c.body(it.data.slice().buffer, 200, { "Content-Type": type, "Cache-Control": "private, max-age=86400, immutable" });
  });

    app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

  // --- The page ---------------------------------------------------------------------

  if (o.pageDir) {
    app.use("/*", serveStatic({ root: o.pageDir }));
    // Any other path is the page's own: it routes in the browser.
    app.get("*", serveStatic({ root: o.pageDir, path: "index.html" }));
  }
  return app;
}
