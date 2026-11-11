// The web app as a PiRC client: the live sessions, each one's chat from
// history and live events, and requests to sessions with their replies
// (docs/web.md, section 4). It reads and writes relay frames but holds no
// connection: the server passes frames in and sends the ones it gives out,
// so it runs and is tested without a socket, and nothing in it is Node's.
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";

import {
  ErrorCode,
  FrameSchema,
  Role,
  SessionAnnouncementSchema,
  SessionMessageSchema,
  StopReason,
  QuestionKind,
  NoticeKind,
  type ConversationItem,
  type Frame,
  type History,
  type Model,
  type SessionAnnouncement,
  type SessionEntry,
  type SessionEvent,
  type SessionMessage,
  type SessionRef,
  errorReply,
  hex,
  requestIdOf,
  requestName,
  sameRef,
  thinkingName,
} from "@pirc/protocol";

import type { RelayAnswer } from "./api.ts";
import { ImageStore, type StoredImage } from "./images.ts";
import { applyToChat, lastOf, type ChatItem, type ChatView, type DeviceView, type ModelView, type NoticeView, type PendingHostView, type PlaceView, type QuestionView, type RelayView, type SessionView, type Snapshot, type ViewEvent } from "./view.ts";

// How long a process may be without a session before it is gone: a
// session change ends one session and announces the next, and a process
// reconnecting to the relay is missing from the list for a moment.
export const END_GRACE_MS = 3000;
// How long a request may wait for its answer. A prompt to an idle pi is
// answered within 30 s (TIMEOUT at worst).
export const REQUEST_MS = 45_000;
// History asked for on attach and after a gap.
export const HISTORY_LIMIT = 200;
// The images of user messages kept for the page, all sessions together.
export const IMAGE_BYTES = 32 << 20;

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
}

export interface ClientOptions {
  // Sends a frame to the relay; false when it could not (not connected).
  send(f: Frame): boolean;
  // Every change, in order.
  onEvent(e: ViewEvent): void;
  // Request IDs: unique, and not guessable by a host (another host could
  // otherwise answer for a session: the reply is also checked against the
  // session it came from).
  newId?: () => string;
  clock?: Clock;
  imageBytes?: number;
  // This client's own public key, to mark it in the devices.
  publicKey?: Uint8Array;
}

// A request's answer: the session's reply, or an error made here.
export type Reply = SessionMessage;

// A request to a session, as SessionMessage's body.
export type RequestBody = MessageInitShape<typeof SessionMessageSchema>["body"];
type FrameBody = MessageInitShape<typeof FrameSchema>["body"];

interface Live {
  view: SessionView;
  ref: SessionRef;
  chat: ChatView;
  // The last event applied; undefined until history arrives.
  lastSeq: bigint | undefined;
  // Events that came while history was being fetched.
  buffered: SessionEvent[] | undefined;
  // The history request in flight, if any, and the entry it asked for
  // what follows.
  historyId: string | undefined;
  historyAfter?: string;
  endTimer: unknown;
  // Numbers items that have no ID of their own yet, unique in the chat.
  unsaved: number;
}

interface Pending {
  to: SessionRef;
  // The first asker's, then any repeat's while it is in flight.
  resolve(m: Reply): void;
  timer: unknown;
  // Asked again when the deadline passes: true extends it.
  extend?: () => boolean;
}

// A process's ID: its host and instance, the same across its sessions.
export function viewId(s: SessionRef): string {
  return `${hex(s.hostKey).slice(0, 16)}-${s.instanceId}`;
}

const STOP: Partial<Record<StopReason, string>> = {
  [StopReason.STOP]: "stop",
  [StopReason.LENGTH]: "length",
  [StopReason.TOOL_USE]: "tool_use",
  [StopReason.ABORTED]: "aborted",
  [StopReason.ERROR]: "error",
  [StopReason.DEFERRED]: "deferred",
};

const ms = (t: Timestamp | undefined) => (t ? Number(timestampMs(t)) : 0);
const modelView = (m: Model | undefined): ModelView | undefined => (m ? { provider: m.provider, id: m.id, name: m.name } : undefined);

function placeView(p: SessionAnnouncement["place"]): PlaceView | undefined {
  if (!p) return undefined;
  const v: PlaceView = { kind: p.kind };
  if (p.group) v.group = p.group;
  if (p.groupNumber !== undefined) v.groupNumber = p.groupNumber;
  if (p.window) v.window = p.window;
  if (p.windowNumber !== undefined) v.windowNumber = p.windowNumber;
  if (p.pane) v.pane = p.pane;
  if (p.display) v.display = p.display;
  return v.group || v.window || v.pane || v.display ? v : undefined;
}

const QUESTION: Partial<Record<QuestionKind, QuestionView["kind"]>> = {
  [QuestionKind.SELECT]: "select",
  [QuestionKind.CONFIRM]: "confirm",
  [QuestionKind.INPUT]: "input",
  [QuestionKind.EDITOR]: "editor",
  [QuestionKind.CUSTOM]: "custom",
};

// The questions a client can make sense of; one of a kind it does not
// know is shown as a dialog in the terminal.
function questionViews(a: SessionAnnouncement): QuestionView[] {
  return a.questions.map((q) => {
    const kind = QUESTION[q.kind];
    return {
      id: q.id,
      kind: kind ?? "custom",
      title: q.title,
      ...(q.message ? { message: q.message } : {}),
      ...(q.options.length ? { options: q.options } : {}),
      ...(q.placeholder ? { placeholder: q.placeholder } : {}),
      answerable: q.answerable && kind !== undefined,
      askedAt: ms(q.askedAt),
    };
  });
}

const NOTICE: Partial<Record<NoticeKind, NoticeView["kind"]>> = {
  [NoticeKind.FINISHED]: "finished",
  [NoticeKind.FAILED]: "failed",
  [NoticeKind.QUESTION]: "question",
};

function noticeView(a: SessionAnnouncement): NoticeView | undefined {
  const kind = a.notice && NOTICE[a.notice.kind];
  return kind ? { number: Number(a.notice!.number), kind, text: a.notice!.text } : undefined;
}

function sessionView(id: string, e: SessionEntry, a: SessionAnnouncement): SessionView {
  const questions = questionViews(a);
  const notice = noticeView(a);
  const sessionId = e.session?.sessionId ?? "";
  const thinking = thinkingName(a.thinkingLevel);
  const model = modelView(a.model);
  const place = placeView(a.place);
  return {
    id,
    sessionId,
    hostLabel: e.hostLabel,
    hostname: a.hostname,
    name: a.name,
    ...(a.firstPrompt ? { first: a.firstPrompt } : {}),
    cwd: a.cwd,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    working: a.working,
    compacting: a.compacting,
    ...(a.startedAt ? { startedAt: ms(a.startedAt) } : {}),
    piVersion: a.piVersion,
    extensionVersion: a.extensionVersion,
    ...(a.requests.length > 0 ? { requests: a.requests } : {}),
    ...(place ? { place } : {}),
    ...(a.launcher ? { launcher: a.launcher } : {}),
    ...(a.launchId ? { launchId: a.launchId } : {}),
    ...(questions.length ? { questions } : {}),
    ...(notice ? { notice } : {}),
  };
}

// A key as the relay shows it, base64url without padding, and back.
export function keyText(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function keyBytes(s: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(s)) return undefined;
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const failed = (code: ErrorCode, message: string): RelayAnswer => ({ ok: false, code: ErrorCode[code] ?? "UNKNOWN", message });

// A token the relay issued, or why not.
export type Issued = { ok: true; token: string; expiresAt: number } | { ok: false; code: string; message: string };

const emptyChat = (loading: boolean): ChatView => ({ items: [], truncated: false, loading });

export class Client {
  private sessions = new Map<string, Live>();
  private pending = new Map<string, Pending>();
  // Requests to the relay itself: decisions on waiting hosts, changes to
  // keys, tokens.
  private deciding = new Map<string, { resolve(d: RelayAnswer | Issued): void; timer: unknown }>();
  private pendingHosts: PendingHostView[] = [];
  private devices: DeviceView[] = [];
  private relay: RelayView = { state: "connecting" };
  // Sessions seen in the list arriving after a (re)connect.
  private listing: Set<string> | undefined;
  // Chats kept from before, by pi's session ID (seed).
  private seeds = new Map<string, ChatView>();
  private readonly newId: () => string;
  private readonly clock: Clock;
  private readonly images: ImageStore;

  constructor(private readonly o: ClientOptions) {
    this.images = new ImageStore(o.imageBytes ?? IMAGE_BYTES);
    this.newId = o.newId ?? (() => globalThis.crypto.randomUUID());
    this.clock = o.clock ?? { setTimeout: (fn, t) => setTimeout(fn, t), clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) };
  }

  snapshot(): Snapshot {
    return { relay: this.relay, sessions: [...this.sessions.values()].map((s) => s.view), pendingHosts: this.pendingHosts, devices: this.devices };
  }

  chat(id: string): ChatView | undefined {
    return this.sessions.get(id)?.chat;
  }

  // An image of a user message, by its key in the chat; undefined when it
  // is no longer kept.
  image(key: string): StoredImage | undefined {
    return this.images.get(key);
  }

  // --- The relay connection -------------------------------------------------

  // The connection's state changed. "ready" is a fresh login: the relay
  // remembers no subscription or attachment from before.
  onState(relay: RelayView): void {
    this.relay = relay;
    this.o.onEvent({ type: "relay", relay });
    if (relay.state === "ready") {
      this.listing = new Set();
      this.send({ case: "subscribeSessions", value: {} });
      this.send({ case: "watchPendingHosts", value: {} });
      this.send({ case: "watchKeys", value: {} });
      return;
    }
    if (relay.state === "connecting") return;
    // Not offered while they cannot be decided on; the relay sends them
    // again on the next login.
    if (this.pendingHosts.length > 0) this.setPendingHosts([]);
    // Nor the devices, whose online states would go stale.
    if (this.devices.length > 0) this.setDevices([]);
    for (const d of this.deciding.values()) {
      this.clock.clearTimeout(d.timer);
      d.resolve(failed(ErrorCode.SESSION_GONE, "lost the connection to the relay"));
    }
    this.deciding.clear();
    // Requests in flight are lost with the connection.
    for (const [id, p] of this.pending) {
      this.clock.clearTimeout(p.timer);
      p.resolve(errorReply(id, ErrorCode.SESSION_GONE, "lost the connection to the relay"));
    }
    this.pending.clear();
    for (const s of this.sessions.values()) s.historyId = undefined;
  }

  onFrame(f: Frame): void {
    const b = f.body;
    switch (b.case) {
      case "sessionList": {
        const seen = (this.listing ??= new Set());
        for (const e of b.value.sessions) {
          const id = this.upsert(e);
          if (id) seen.add(id);
        }
        if (!b.value.more) {
          for (const [id, s] of this.sessions) if (!seen.has(id)) this.endSoon(s);
          this.listing = undefined;
        }
        return;
      }
      case "sessionUpdated":
        if (b.value.entry) this.upsert(b.value.entry);
        return;
      case "sessionEnded": {
        const ref = b.value.session;
        if (!ref) return;
        this.failPending(ref, "the session has ended");
        const s = this.sessions.get(viewId(ref));
        if (s && s.ref.sessionId === ref.sessionId) this.endSoon(s);
        return;
      }
      case "routed":
        if (b.value.session) this.onRouted(b.value.session, b.value.payload);
        return;
      case "pendingHosts":
        this.setPendingHosts(b.value.hosts.map((h) => ({
          key: keyText(h.publicKey), label: h.label, software: h.software, remote: h.remote, firstSeen: ms(h.firstSeen),
        })));
        return;
      case "keys": {
        const own = this.o.publicKey && keyText(this.o.publicKey);
        this.setDevices(b.value.keys.map((k) => {
          const key = keyText(k.publicKey);
          return { key, role: k.role === Role.HOST ? "host" : "client", label: k.label, addedAt: ms(k.addedAt), online: k.online, self: key === own, push: k.push };
        }));
        return;
      }
      case "hostDecided":
      case "keyChanged":
        this.decided(b.value.requestId, { ok: true });
        return;
      case "tokenIssued":
        this.decided(b.value.requestId, { ok: true, token: b.value.token, expiresAt: ms(b.value.expiresAt) });
        return;
      case "error":
        // Only decisions on hosts and changes to keys are the relay's own
        // requests; the others end by sessionEnded or their deadline.
        this.decided(b.value.requestId, failed(b.value.code, b.value.message));
        return;
      default:
        return;
    }
  }

  private setPendingHosts(hosts: PendingHostView[]): void {
    this.pendingHosts = hosts;
    this.o.onEvent({ type: "pendingHosts", hosts });
  }

  private setDevices(devices: DeviceView[]): void {
    this.devices = devices;
    this.o.onEvent({ type: "devices", devices });
  }

  private decided(requestId: string, d: RelayAnswer | Issued): void {
    const w = this.deciding.get(requestId);
    if (!w) return;
    this.deciding.delete(requestId);
    this.clock.clearTimeout(w.timer);
    w.resolve(d);
  }

  // Approves or rejects a waiting host, by its key as the relay shows it;
  // approving may give it a label of its own. It never rejects.
  decide(key: string, approve: boolean, label = ""): Promise<RelayAnswer> {
    const publicKey = keyBytes(key);
    if (!publicKey) return Promise.resolve(failed(ErrorCode.INVALID, "not a host key"));
    const requestId = this.newId();
    const sent = approve
      ? this.send({ case: "approveHost", value: { requestId, publicKey, label } })
      : this.send({ case: "rejectHost", value: { requestId, publicKey } });
    return this.answered(requestId, sent);
  }

  // Renames a registered device, by its key as the relay shows it.
  rename(key: string, label: string): Promise<RelayAnswer> {
    const publicKey = keyBytes(key);
    if (!publicKey) return Promise.resolve(failed(ErrorCode.INVALID, "not a host's or an app's key"));
    const requestId = this.newId();
    return this.answered(requestId, this.send({ case: "renameKey", value: { requestId, publicKey, label } }));
  }

  // Removes a registered device, by its key as the relay shows it. The
  // relay refuses this client's own.
  remove(key: string): Promise<RelayAnswer> {
    const publicKey = keyBytes(key);
    if (!publicKey) return Promise.resolve(failed(ErrorCode.INVALID, "not a host's or an app's key"));
    const requestId = this.newId();
    return this.answered(requestId, this.send({ case: "removeKey", value: { requestId, publicKey } }));
  }

  // A one-time token for registering a new device of role, valid for the
  // relay's default 15 minutes.
  issueToken(role: "host" | "client", label: string): Promise<Issued> {
    const requestId = this.newId();
    return this.answered<Issued>(requestId, this.send({ case: "issueToken", value: { requestId, role: role === "host" ? Role.HOST : Role.CLIENT, label } }));
  }

  // The relay's answer to a request of its own just sent, if it was.
  private answered<T extends RelayAnswer | Issued = RelayAnswer>(requestId: string, sent: boolean): Promise<T> {
    if (!sent) return Promise.resolve(failed(ErrorCode.BUSY, "not connected to the relay") as T);
    return new Promise<T>((resolve) => {
      const timer = this.clock.setTimeout(() => this.decided(requestId, failed(ErrorCode.TIMEOUT, "no answer from the relay")), REQUEST_MS);
      this.deciding.set(requestId, { resolve: resolve as (d: RelayAnswer | Issued) => void, timer });
    });
  }

  private send(body: FrameBody): boolean {
    return this.o.send(create(FrameSchema, { body }));
  }

  private upsert(e: SessionEntry): string | undefined {
    const ref = e.session;
    if (!ref) return undefined;
    let a: SessionAnnouncement;
    try {
      a = fromBinary(SessionAnnouncementSchema, e.payload);
    } catch {
      return undefined;
    }
    const id = viewId(ref);
    const s = this.sessions.get(id);
    const last = s && s.ref.sessionId === ref.sessionId ? s.view.last : undefined;
    const view = { ...sessionView(id, e, a), ...(last ? { last } : {}) };
    if (!s) {
      const live: Live = { view, ref, chat: this.seeded(ref.sessionId), lastSeq: undefined, buffered: [], historyId: undefined, endTimer: undefined, unsaved: 0 };
      this.sessions.set(id, live);
      this.o.onEvent({ type: "session", session: view });
      if (live.chat.items.length > 0) this.o.onEvent({ type: "chatReset", id, chat: live.chat });
      this.attach(live);
      return id;
    }
    this.clock.clearTimeout(s.endTimer);
    s.endTimer = undefined;
    if (JSON.stringify(view) !== JSON.stringify(s.view)) {
      s.view = view;
      this.o.onEvent({ type: "session", session: view });
    }
    if (s.ref.sessionId !== ref.sessionId) {
      // The process moved to another session: its chat starts again.
      this.failPending(s.ref, "the session was replaced");
      s.ref = ref;
      s.chat = this.seeded(ref.sessionId);
      s.lastSeq = undefined;
      s.buffered = [];
      s.historyId = undefined;
      this.o.onEvent({ type: "chatReset", id, chat: s.chat });
      this.attach(s);
    } else if (this.listing && s.historyId === undefined) {
      // After a reconnect: attach again, and catch up on what was missed.
      s.ref = ref;
      this.attach(s);
    }
    return id;
  }

  // A chat this client kept from before, by pi's session ID, for when a
  // process with that session is first seen: the chat starts from it, still
  // loading, and its history is asked for only after its last saved item
  // (fetchHistory). Each seed is used once. The mobile app seeds the chats
  // it keeps on the phone; the web app's server never calls this, so for it
  // nothing changes.
  seed(sessionId: string, chat: ChatView): void {
    this.seeds.set(sessionId, chat);
  }

  private seeded(sessionId: string): ChatView {
    const chat = this.seeds.get(sessionId);
    this.seeds.delete(sessionId);
    return chat ? { ...chat, loading: true } : emptyChat(true);
  }

  private attach(s: Live): void {
    this.send({ case: "attach", value: { session: s.ref } });
    this.fetchHistory(s);
  }

  private endSoon(s: Live): void {
    this.clock.clearTimeout(s.endTimer);
    s.endTimer = this.clock.setTimeout(() => {
      if (this.sessions.get(s.view.id) !== s) return;
      this.sessions.delete(s.view.id);
      this.failPending(s.ref, "the session has ended");
      this.o.onEvent({ type: "sessionGone", id: s.view.id });
    }, END_GRACE_MS);
  }

  // --- History and events --------------------------------------------------

  private fetchHistory(s: Live): void {
    if (s.historyId !== undefined) return;
    s.buffered ??= [];
    if (!s.chat.loading) {
      s.chat = { ...s.chat, loading: true };
    }
    const requestId = this.newId();
    s.historyId = requestId;
    // A chat it has already is caught up from its last saved item, which
    // the session answers with only what follows, when it can.
    const after = s.chat.items.findLast((x) => x.entryId)?.entryId;
    s.historyAfter = after;
    const ref = s.ref;
    void this.request(ref, { case: "historyRequest", value: { requestId, limit: HISTORY_LIMIT, ...(after ? { afterEntryId: after } : {}) } }, requestId).then((m) => {
      if (this.sessions.get(s.view.id) !== s || s.historyId !== requestId) return;
      s.historyId = undefined;
      if (m.body.case !== "history") {
        // Asked again on the next gap or reconnect; until then the chat
        // shows what it had.
        s.chat = { ...s.chat, loading: false };
        s.buffered = undefined;
        this.o.onEvent({ type: "chatReset", id: s.view.id, chat: s.chat });
        return;
      }
      this.applyHistory(s, m.body.value);
    });
  }

  private applyHistory(s: Live, h: History): void {
    // What follows the entry asked after: the chat up to that entry's
    // items stays, what came after it goes. Else the history replaces it.
    const at = h.fromEntry && s.historyAfter ? s.chat.items.findLastIndex((x) => x.entryId === s.historyAfter) : -1;
    s.chat = at >= 0
      ? { items: s.chat.items.slice(0, at + 1), truncated: s.chat.truncated, loading: false }
      : { items: [], truncated: h.truncated, loading: false };
    for (const it of h.items) this.applyItem(s, it, false);
    s.lastSeq = h.seq;
    this.o.onEvent({ type: "chatReset", id: s.view.id, chat: s.chat });
    this.updateLast(s);
    // Those the history already reflects are dropped by their seq.
    const later = s.buffered ?? [];
    s.buffered = undefined;
    for (const ev of later) this.applyEvent(s, ev);
  }

  private onRouted(ref: SessionRef, payload: Uint8Array): void {
    let m: SessionMessage;
    try {
      m = fromBinary(SessionMessageSchema, payload);
    } catch {
      return;
    }
    const b = m.body;
    if (b.case === "event") {
      const s = this.sessions.get(viewId(ref));
      if (!s || s.ref.sessionId !== ref.sessionId) return;
      if (s.buffered) {
        s.buffered.push(b.value);
        return;
      }
      this.applyEvent(s, b.value);
      return;
    }
    const requestId = requestIdOf(b);
    if (!requestId) return;
    const p = this.pending.get(requestId);
    if (!p || !sameRef(p.to, ref)) return;
    this.pending.delete(requestId);
    this.clock.clearTimeout(p.timer);
    p.resolve(m);
  }

  private applyEvent(s: Live, ev: SessionEvent): void {
    if (s.lastSeq !== undefined && ev.seq <= s.lastSeq) return;
    if (s.lastSeq !== undefined && ev.seq !== s.lastSeq + 1n) {
      // Missed events: fetch history, keeping what comes meanwhile.
      s.lastSeq = undefined;
      s.buffered = [ev];
      this.fetchHistory(s);
      return;
    }
    s.lastSeq = ev.seq;
    const b = ev.body;
    switch (b.case) {
      case "item":
        this.applyItem(s, b.value, true);
        return;
      case "assistantDelta": {
        const d = b.value;
        if (d.body.case !== "text" && d.body.case !== "thinking") return;
        this.emitChat(s, {
          type: "chatDelta", id: s.view.id, itemId: d.messageId, turnId: d.turnId, at: ms(ev.at),
          block: d.blockIndex, kind: d.body.case, text: d.body.value,
        });
        return;
      }
      case "toolProgress":
        this.emitChat(s, { type: "toolProgress", id: s.view.id, itemId: b.value.toolCallId, text: b.value.text });
        return;
      case "branchChanged":
        // The session moved in its tree: the conversation is another one,
        // from history, with what comes meanwhile kept for after it.
        this.fetchHistory(s);
        return;
      default:
        // Working and announcement changes come with the session list.
        return;
    }
  }

  // An item as the chat's: a tool result joins its call.
  private applyItem(s: Live, it: ConversationItem, emit: boolean): void {
    const base = { turnId: it.turnId, at: ms(it.at), ...(it.entryId ? { entryId: it.entryId } : {}) };
    const b = it.body;
    let item: ChatItem | undefined;
    switch (b.case) {
      case "userMessage":
        item = {
          kind: "user", id: it.entryId ? `e-${it.entryId}` : b.value.requestId ? `r-${b.value.requestId}` : `u-${s.unsaved++}`,
          ...base, text: b.value.text,
          images: b.value.images.map((i) => ({ mimeType: i.mimeType, ...(i.data.length > 0 ? { key: this.images.put(i.mimeType, i.data) } : {}) })),
          ...(b.value.requestId ? { requestId: b.value.requestId } : {}),
        };
        break;
      case "assistantMessage": {
        const v = b.value;
        const model = modelView(v.model);
        const stop = STOP[v.stopReason];
        item = {
          kind: "assistant", id: v.messageId || `e-${it.entryId}`, ...base,
          blocks: v.content.flatMap((c) => (c.body.case === "text" || c.body.case === "thinking" ? [{ kind: c.body.case, text: c.body.value }] : [])),
          streaming: false,
          ...(stop ? { stop } : {}),
          ...(v.errorMessage ? { error: v.errorMessage } : {}),
          ...(model ? { model } : {}),
          ...(v.usage ? {
            usage: {
              input: Number(v.usage.inputTokens), output: Number(v.usage.outputTokens),
              cacheRead: Number(v.usage.cacheReadTokens), cacheWrite: Number(v.usage.cacheWriteTokens), cost: v.usage.cost,
            },
          } : {}),
        };
        break;
      }
      case "toolCall":
        item = { kind: "tool", id: b.value.toolCallId, ...base, name: b.value.toolName, args: b.value.argumentsJson };
        break;
      case "toolResult": {
        const call = s.chat.items.find((x) => x.id === b.value.toolCallId && x.kind === "tool");
        const v = b.value;
        const result = {
          text: v.text,
          isError: v.isError,
          ...(v.durationMs !== undefined ? { durationMs: v.durationMs } : {}),
          ...(v.exitCode !== undefined ? { exitCode: v.exitCode } : {}),
          ...(v.diff ? { diff: v.diff } : {}),
        };
        item = call?.kind === "tool"
          ? { ...call, progress: undefined, result }
          : { kind: "tool", id: b.value.toolCallId, ...base, name: "", args: "", result };
        if (item.kind === "tool" && item.progress === undefined) delete item.progress;
        break;
      }
      case "compaction":
        item = { kind: "compaction", id: it.entryId ? `e-${it.entryId}` : `c-${s.unsaved++}`, ...base, summary: b.value.summary, tokensBefore: Number(b.value.tokensBefore) };
        break;
      case "branchSummary":
        item = { kind: "branchSummary", id: it.entryId ? `e-${it.entryId}` : `b-${s.unsaved++}`, ...base, summary: b.value.summary };
        break;
    }
    if (!item) return;
    const e: ViewEvent = { type: "chatItem", id: s.view.id, item };
    if (emit) this.emitChat(s, e);
    else s.chat = applyToChat(s.chat, e);
  }

  private emitChat(s: Live, e: ViewEvent): void {
    s.chat = applyToChat(s.chat, e);
    this.o.onEvent(e);
    if (e.type === "chatItem") this.updateLast(s);
  }

  // The session's latest message, for the list, when it changed.
  private updateLast(s: Live): void {
    const last = lastOf(s.chat.items);
    if (JSON.stringify(last) === JSON.stringify(s.view.last)) return;
    const { last: _, ...rest } = s.view;
    s.view = last ? { ...rest, last } : rest;
    this.o.onEvent({ type: "session", session: s.view });
  }

  // --- Requests ----------------------------------------------------------------

  // Sends a request to a session and resolves with its answer, or an error
  // made here (SESSION_GONE, BUSY, TIMEOUT). It never rejects.
  ask(id: string, body: RequestBody, extend?: () => boolean): Promise<Reply> {
    const s = this.sessions.get(id);
    const requestId = requestIdOf(body);
    if (!s || s.endTimer !== undefined) return Promise.resolve(errorReply(requestId, ErrorCode.SESSION_GONE, "the session has ended"));
    // A request the session says it does not take would go unanswered.
    const name = body?.case ? requestName(body.case) : "";
    const takes = s.view.requests;
    if (takes && !takes.includes(name)) {
      return Promise.resolve(errorReply(requestId, ErrorCode.INVALID, `this session's extension (${s.view.extensionVersion}) does not take ${name}; update it`));
    }
    return this.request(s.ref, body, requestId, extend);
  }

  // A fresh request ID.
  id(): string {
    return this.newId();
  }

  // Whether the session is compacting, for a compaction's deadline.
  compacting(id: string): boolean {
    return this.sessions.get(id)?.view.compacting ?? false;
  }

  // Whether the session is asking a question, for a prompt's deadline.
  asking(id: string): boolean {
    return (this.sessions.get(id)?.view.questions?.length ?? 0) > 0;
  }

  private request(to: SessionRef, body: RequestBody, requestId: string, extend?: () => boolean): Promise<Reply> {
    if (!requestId) return Promise.resolve(errorReply("", ErrorCode.INVALID, "a request needs an ID"));
    // A repeat (the page retrying) waits for the same answer; the same ID
    // to another session is a mistake.
    const inFlight = this.pending.get(requestId);
    if (inFlight && !sameRef(inFlight.to, to)) return Promise.resolve(errorReply(requestId, ErrorCode.INVALID, "a request with this ID is in flight to another session"));
    if (inFlight) {
      return new Promise((resolve) => {
        const first = inFlight.resolve;
        inFlight.resolve = (m) => {
          first(m);
          resolve(m);
        };
      });
    }
    // The ID beside the body too, for a session that does not know this
    // kind of request.
    const payload = toBinary(SessionMessageSchema, create(SessionMessageSchema, { requestId, body }));
    if (!this.send({ case: "routed", value: { session: to, payload } })) {
      return Promise.resolve(errorReply(requestId, ErrorCode.BUSY, "not connected to the relay, or the request is too large"));
    }
    return new Promise((resolve) => {
      const expire = () => {
        const p = this.pending.get(requestId);
        if (!p) return;
        if (p.extend?.()) {
          p.timer = this.clock.setTimeout(expire, REQUEST_MS);
          return;
        }
        this.pending.delete(requestId);
        p.resolve(errorReply(requestId, ErrorCode.TIMEOUT, "no answer from the session"));
      };
      this.pending.set(requestId, { to, resolve, timer: this.clock.setTimeout(expire, REQUEST_MS), extend });
    });
  }

  private failPending(ref: SessionRef, why: string): void {
    for (const [id, p] of this.pending) {
      if (!sameRef(p.to, ref)) continue;
      this.pending.delete(id);
      this.clock.clearTimeout(p.timer);
      p.resolve(errorReply(id, ErrorCode.SESSION_GONE, why));
    }
  }
}
