// The process side of the extension: one relay connection per pi process,
// kept for the life of the process and rebound to whichever session the
// process has (docs/design.md, section 8, lifecycle rules).
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";

import { errorReply, ErrorCode, FrameSchema, hex, messageRequestId, sameBytes, SessionMessageSchema, type Answer, type Frame, type Place, type Question, type SessionMessage, type SessionRef } from "@pirc/protocol";
import { loadOrCreateKey, RelayConnection, type ConnectionState, type DeviceKey } from "@pirc/relay-client";

import { loadConfig, saveRemoved, type HostConfig } from "./config.ts";
import { errorText, Live, REQUESTS, type NoticeMemo, type Sink } from "./live.ts";
import { LAUNCH_ENV, LauncherChoice, type Launcher } from "./launch.ts";
import { PlaceTracker } from "./place.ts";
import { Questions } from "./questions.ts";

const isChange = (c: string | undefined) => c !== undefined && Object.hasOwn(REQUESTS, c) && REQUESTS[c as keyof typeof REQUESTS] === "change";
// Replies to changes kept for repeats.
const IDEMPOTENCY_ENTRIES = 1000;
// Outcomes after which nothing ran, so a repeat of the request tries again
// rather than getting the same answer.
const RETRYABLE = new Set([ErrorCode.BUSY, ErrorCode.TIMEOUT, ErrorCode.PI_FAILED, ErrorCode.INVALID, ErrorCode.SESSION_GONE]);

// A host made by another version of this extension, in this process: its
// class is another module's, so it is read by the fields every version
// since 0.1.0 has.
interface Predecessor {
  instanceId?: string;
  seqs?: Map<string, bigint>;
  // Absent from versions before notices.
  notices?: Map<string, NoticeMemo>;
  live?: { sessionId: string; lastSeq: bigint; notice?: NoticeMemo; dispose(): void };
  suspended?: { sessionId: string; lastSeq: bigint; notice?: NoticeMemo; dispose(): void };
  conn?: { stop(): void };
}

// The longest a predecessor's connection is kept, for this host to take its
// session over; and how long it stays once this host has announced, since
// the relay reads each connection on its own and could otherwise see the
// old one close, ending the session, before the announcement.
const HANDOVER_MS = 30_000;
const HANDOVER_AFTER_ANNOUNCE_MS = 2_000;

export class Host implements Sink {
  private config: HostConfig | undefined;
  private key: DeviceKey | undefined;
  private conn: RelayConnection | undefined;
  private state: ConnectionState = { kind: "stopped" };
  private live: Live | undefined;
  // A session paused by a reload, until it starts again.
  private suspended: Live | undefined;
  private previousSessionId = "";
  // A request still waiting for its outcome is "pending": a repeat of it is
  // neither run nor answered, since the first one's answer, to the same
  // client and request ID, is still to come.
  private replies = new Map<string, SessionMessage | "pending">();
  // Where each session's sequence numbers left off, for a return to it.
  private seqs = new Map<string, bigint>();
  // And each one's notice, so that one is pushed once.
  private notices = new Map<string, NoticeMemo>();
  private lastError = "";
  // Where the process runs, announced with its session; checked again on
  // activity (bind, a turn, a reconnect, a client's request).
  readonly places = new PlaceTracker(
    // Not connected, an event would be lost, leaving a gap in the sequence
    // numbers; the announcement on connecting carries the place anyway.
    () => {
      if (this.state.kind === "ready") this.live?.onAnnouncementChanged();
    },
    (e) => this.fail("place", e),
  );

  // What opens a new pi beside this one; another extension can change it.
  readonly launchers = new LauncherChoice(() => {
    if (this.state.kind === "ready") this.live?.onAnnouncementChanged();
  });
  // The dialogs pi is showing for extensions, asked of clients too.
  readonly dialogs = new Questions(() => {
    this.live?.onQuestionsChanged();
    if (this.state.kind === "ready") this.live?.onAnnouncementChanged();
  });
  // The Launch that started this process, if one did.
  readonly launchId = process.env[LAUNCH_ENV] ?? "";

  // The host this one took over from, until it is let go (HANDOVER_MS).
  private predecessor: { host: Predecessor; timer: NodeJS.Timeout; announced: boolean } | undefined;

  constructor(
    readonly instanceId: string,
    private readonly versions: { pi: string; extension: string },
  ) {}

  // A host for this process, taking over from the one another version of
  // the extension made, if any: the same instance, with sequence numbers
  // carrying on, so clients see the session continue. The old host keeps
  // its connection, and its session (answering requests BUSY, as during
  // any reload), until this one has announced: the relay ends the sessions
  // of a connection that closes, but lets a newer one take a session over.
  static succeeding(previous: unknown, instanceId: string, versions: { pi: string; extension: string }): Host {
    const p = previous as Predecessor | undefined;
    const host = new Host(p?.instanceId ?? instanceId, versions);
    if (!p) return host;
    for (const [id, seq] of p.seqs ?? []) host.seqs.set(id, seq);
    for (const [id, n] of p.notices ?? []) host.notices.set(id, n);
    for (const live of [p.suspended, p.live]) {
      if (!live) continue;
      host.seqs.set(live.sessionId, live.lastSeq);
      if (live.notice) host.notices.set(live.sessionId, live.notice);
    }
    const timer = setTimeout(() => host.releasePredecessor(), HANDOVER_MS);
    timer.unref();
    host.predecessor = { host: p, timer, announced: false };
    return host;
  }

  private releasePredecessor(): void {
    const p = this.predecessor;
    if (!p) return;
    this.predecessor = undefined;
    clearTimeout(p.timer);
    const old = p.host;
    try {
      // Cleared first, or a reconnect would announce them again; pending
      // requests are answered as they are let go.
      const lives = [old.suspended, old.live];
      old.live = old.suspended = undefined;
      for (const live of lives) live?.dispose();
      old.conn?.stop();
    } catch (e) {
      this.fail("previous version", e);
    }
  }

  // Lets the predecessor go shortly after this host first announces.
  private announced(): void {
    const p = this.predecessor;
    if (!p || p.announced) return;
    p.announced = true;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.releasePredecessor(), HANDOVER_AFTER_ANNOUNCE_MS);
    p.timer.unref();
  }

  // The live session that `pi` belongs to, if it is still current.
  liveFor(pi: ExtensionAPI): Live | undefined {
    return this.live?.pi === pi ? this.live : undefined;
  }

  log(msg: string): void {
    const path = process.env.PIRC_LOG;
    if (!path) return;
    try {
      appendFileSync(path, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
    } catch {
      // Logging is best effort.
    }
  }

  fail(where: string, e: unknown): void {
    this.lastError = `${where}: ${(e as Error)?.message ?? e}`;
    this.log(this.lastError);
  }

  bind(pi: ExtensionAPI, ctx: ExtensionContext, ev: SessionStartEvent): void {
    const id = ctx.sessionManager.getSessionId();
    if (this.suspended?.sessionId === id) {
      this.live = this.suspended;
      this.live.rebind(pi, ctx);
    } else if (this.live?.sessionId === id) {
      // The extension loaded twice into this process: the second load's
      // pi takes over, and the first one's handlers find no session.
      this.live.rebind(pi, ctx);
    } else {
      if (this.suspended) this.endSession(this.suspended);
      if (this.live) this.endSession(this.live);
      this.live = new Live(pi, ctx, this, () => this.key?.publicKey ?? new Uint8Array(), this.instanceId, ev.reason, this.previousSessionId, this.versions, this.seqs.get(id), this.notices.get(id));
    }
    this.suspended = undefined;
    this.log(`session ${id} (${ev.reason})`);
    void this.places.refresh();
    if (!this.conn) this.connect();
    else if (this.state.kind === "ready") this.announce(this.live);
    this.showStatus();
  }

  unbind(pi: ExtensionAPI, reason: SessionShutdownEvent["reason"]): void {
    const live = this.liveFor(pi);
    if (!live) return;
    this.live = undefined;
    if (reason === "reload") {
      // The same session comes back with new objects; keep it announced.
      this.suspended = live;
      live.onShutdown(reason);
      return;
    }
    this.previousSessionId = live.sessionId;
    live.onShutdown(reason);
    this.endSession(live);
    if (reason === "quit") {
      this.conn?.stop();
      this.releasePredecessor();
    }
  }

  private endSession(live: Live): void {
    this.seqs.set(live.sessionId, live.lastSeq);
    this.notices.set(live.sessionId, live.notice);
    live.dispose();
    this.conn?.send(create(FrameSchema, { body: { case: "sessionEnd", value: { session: live.ref } } }));
  }

  // (Re)connects with the current configuration; token, when given, is a
  // registration token from /pirc enrol.
  connect(token?: string): void {
    this.conn?.stop();
    this.conn = undefined;
    let config: HostConfig;
    try {
      config = loadConfig();
    } catch (e) {
      this.fail("config", e);
      return this.showStatus();
    }
    this.config = config;
    if (!config.relay || config.removed) return this.showStatus();
    try {
      this.key = loadOrCreateKey(config.keyFile);
    } catch (e) {
      this.fail("host key", e);
      return this.showStatus();
    }
    try {
      this.conn = new RelayConnection({
        url: config.relay,
        role: "host",
        key: this.key,
        token: token ?? config.token,
        label: config.label,
        software: `pirc-extension/${this.versions.extension}`,
        onFrame: (f) => this.onFrame(f),
        onState: (s) => this.onState(s),
        onRegistered: () => this.log("connected with the registration token"),
        onError: (where, e) => this.fail(where, e),
      });
    } catch (e) {
      this.fail("relay", e);
      return this.showStatus();
    }
    this.conn.start();
  }

  private onState(s: ConnectionState): void {
    this.state = s;
    this.log(`relay ${s.kind}${"reason" in s ? `: ${s.reason}` : ""}`);
    // Not asked to join again by this process or the next one, until the
    // person enrols the host again (docs/design.md, 5.3).
    if (s.kind === "refused" && s.removed && this.config) {
      const at = new Date();
      this.config = { ...this.config, removed: at.toISOString() };
      try {
        saveRemoved(at);
      } catch (e) {
        this.fail("config", e);
      }
    }
    if (s.kind === "ready") {
      if (this.live) this.announce(this.live);
      if (this.suspended) this.announce(this.suspended);
      void this.places.refresh();
    }
    this.showStatus();
  }

  statusText(): string {
    const s = this.state;
    if (!this.config?.relay) return "pirc: not enrolled";
    if (this.config.removed) return "pirc: removed from the relay";
    switch (s.kind) {
      case "ready":
        return "pirc: online";
      case "connecting":
        return "pirc: connecting";
      case "offline":
        return "pirc: offline";
      case "pending":
        return "pirc: awaiting approval";
      case "refused":
        return "pirc: refused";
      case "stopped":
        return "pirc: off";
    }
  }

  statusReport(): string {
    const lines = [this.statusText()];
    const c = this.config;
    if (c) {
      lines.push(`config ${c.path}`);
      if (c.relay) lines.push(`relay ${c.relay}`);
      lines.push(`key ${c.keyFile}${this.key ? ` (${Buffer.from(this.key.publicKey).toString("base64url")})` : ""}`);
      lines.push(`label ${c.label}`);
    }
    if ("reason" in this.state) lines.push(`relay said: ${this.state.reason}`);
    if (this.live) lines.push(`session ${this.live.sessionId}, instance ${this.instanceId}`);
    if (this.dialogs.problem) lines.push(this.dialogs.problem);
    if (this.lastError) lines.push(`last error: ${this.lastError}`);
    if (c?.removed) lines.push(`removed from the relay ${c.removed}; to join again: /pirc enrol <relay-url> [token]`);
    if (!c?.relay) lines.push("enrol with: /pirc enrol <relay-url> [token]; without a token, approve this key in the web app or with pirc-relay approve");
    return lines.join("\n");
  }

  // The footer shows only what needs attention: online, the usual state,
  // takes no line.
  private showStatus(): void {
    try {
      this.live?.ctx.ui.setStatus("pirc", this.state.kind === "ready" && this.config?.relay && !this.config.removed ? undefined : this.statusText());
    } catch {
      // The context went stale; the next session shows it.
    }
  }

  // An entry of the session the extension has, through whichever load of
  // it has the session (bind): a photo's message.
  entry(id: string): SessionEntry | undefined {
    return this.live?.ctx.sessionManager.getEntry(id);
  }

  // Has pi draw its screen again, for a photo's PNG made after pi drew its
  // entry. pi gives an entry's renderer no way to ask for that, but setting
  // the footer status always redraws, so the status is set again as it is
  // (docs/design.md, section 8).
  redraw(): void {
    this.showStatus();
  }

  // --- Sink -------------------------------------------------------------

  private routed(session: Pick<SessionRef, "hostKey" | "sessionId" | "instanceId">, clientKey: Uint8Array, m: SessionMessage): void {
    this.conn?.send(create(FrameSchema, {
      body: { case: "routed", value: { session, clientKey, payload: toBinary(SessionMessageSchema, m) } },
    }));
  }

  broadcast(live: Live, m: SessionMessage): void {
    if (live === this.live) this.routed(live.ref, new Uint8Array(), m);
  }

  reply(live: Live, clientKey: Uint8Array, m: SessionMessage): void {
    this.routed(live.ref, clientKey, m);
  }

  // With push set for a notice not yet announced with it, as one raised
  // while the relay was out of reach (docs/design.md, section 12, step 13).
  announce(live: Live): void {
    if (this.state.kind !== "ready") return;
    const number = live.notice.notice?.number;
    const push = number !== undefined && number > live.notice.pushed;
    let sent: boolean | undefined;
    try {
      sent = this.conn?.send(create(FrameSchema, {
        body: { case: "sessionAnnounce", value: { session: live.ref, payload: live.announcementBytes(), push } },
      }));
    } catch (e) {
      this.fail("announce", e);
      return;
    }
    if (!sent) return;
    if (push) live.notice = { ...live.notice, pushed: number };
    this.announced();
  }

  place(): Place | undefined {
    return this.places.current;
  }

  launcher(): Launcher | undefined {
    return this.launchers.current;
  }

  questions(): Question[] {
    return this.dialogs.list();
  }

  answer(a: Answer): string | undefined {
    return this.dialogs.answer(a);
  }

  maxPayloadBytes(): number {
    return this.state.kind === "ready" ? this.state.maxFrameBytes - 512 : 1 << 20;
  }

  // --- Frames from the relay ------------------------------------------

  private onFrame(f: Frame): void {
    const body = f.body;
    if (body.case === "error") {
      this.lastError = `relay: ${body.value.message}`;
      this.log(this.lastError);
      return;
    }
    if (body.case !== "routed") return;
    const { session, clientKey, payload } = body.value;
    let m: SessionMessage;
    try {
      m = fromBinary(SessionMessageSchema, payload);
    } catch {
      if (session) this.routed(session, clientKey, errorReply("", ErrorCode.INVALID, "undecodable message"));
      return;
    }
    // The relay routes only this connection's sessions here; anything
    // else is not ours to answer.
    if (!session || !this.key || !sameBytes(session.hostKey, this.key.publicKey)) return;
    const is = (l: Live | undefined): l is Live => l !== undefined && session.sessionId === l.sessionId && session.instanceId === l.instanceId;
    if (is(this.suspended)) {
      this.routed(session, clientKey, errorReply(messageRequestId(m), ErrorCode.BUSY, "pi is reloading; try again shortly"));
      return;
    }
    const live = this.live;
    if (!is(live)) {
      this.routed(session, clientKey, errorReply(messageRequestId(m), ErrorCode.SESSION_GONE, "session is no longer live in this process"));
      return;
    }
    const idem = isChange(m.body.case) ? `${live.sessionId}/${hex(clientKey)}/${messageRequestId(m)}` : undefined;
    const seen = idem && this.replies.get(idem);
    if (seen === "pending") return;
    if (seen) return this.reply(live, clientKey, seen);
    if (idem) this.remember(idem, "pending");
    let answered = false;
    const respond = (reply: SessionMessage) => {
      if (answered) return;
      answered = true;
      if (idem) {
        const failed = reply.body.case === "error" && RETRYABLE.has(reply.body.value.code);
        if (failed) this.replies.delete(idem);
        else this.remember(idem, reply);
      }
      this.reply(live, clientKey, reply);
    };
    // A client's request is activity: the names may have changed.
    void this.places.refresh();
    try {
      live.onRequest(m, respond);
    } catch (e) {
      this.fail("request", e);
      respond(errorReply(messageRequestId(m), ErrorCode.PI_FAILED, errorText(e)));
    }
  }

  private remember(key: string, v: SessionMessage | "pending"): void {
    this.replies.delete(key);
    this.replies.set(key, v);
    if (this.replies.size > IDEMPOTENCY_ENTRIES) this.replies.delete(this.replies.keys().next().value!);
  }
}
