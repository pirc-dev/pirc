// The page's side of the server (docs/web.md, section 3): a snapshot, then
// the event stream from its position, applied as it comes; reloading the
// snapshot when the server says so; reopening the stream when the page is
// shown again, since phones drop connections in the background. Commands
// are requests, each answering with the stream position it took effect at.
import type { Answer, Body, CommandName, RelayAnswer, TokenAnswer } from "../../core/api.ts";
import { applyToChat, type ChatView, type DeviceView, type PendingHostView, type RelayView, type SessionView, type ViewEvent } from "../../core/view.ts";

export interface State {
  // Whether the server has a sign-in for this browser; undefined while
  // finding out.
  signedIn: boolean | undefined;
  relay: RelayView;
  sessions: SessionView[];
  // Hosts asking to join, oldest first.
  pendingHosts: PendingHostView[];
  // The devices registered with the relay, by role, then label; none while
  // the relay is out of reach.
  devices: DeviceView[];
  // The chat being watched, and its contents.
  chatId: string | undefined;
  chat: ChatView | undefined;
  // The stream: connected, or reconnecting.
  stream: "connecting" | "open" | "closed";
}

type Listener = () => void;

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (j as { error?: string; message?: string }).error ?? (j as { message?: string }).message ?? r.statusText);
  return j as T;
}

export const api = { call };

// The position of an event ID ("<run>.<seq>").
function position(id: string | undefined): { run: string; seq: number } | undefined {
  const m = id ? /^([^.]+)\.(\d+)$/.exec(id) : null;
  return m ? { run: m[1], seq: Number(m[2]) } : undefined;
}

export class Live {
  state: State = { signedIn: undefined, relay: { state: "connecting" }, sessions: [], pendingHosts: [], devices: [], chatId: undefined, chat: undefined, stream: "closed" };
  private listeners = new Set<Listener>();
  private source: EventSource | undefined;
  // The last event applied.
  private last: string | undefined;
  // Commands waiting for the stream to reach their position.
  private waiting: { at: { run: string; seq: number }; resolve: () => void }[] = [];
  private lastAlive = 0;
  // The current load; an earlier one finishing late is discarded.
  private loading = 0;
  private inFlight = false;

  constructor() {
    // Hidden, the page lets its stream go: the server counts a chat as
    // shown only while a stream for it is open, and notifies otherwise.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.resume();
      else this.close();
    });
    window.addEventListener("pageshow", (e) => {
      if (e.persisted) this.resume();
    });
    // What the person does keeps the sign-in alive (30 minutes idle).
    for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, () => this.alive(), { passive: true });
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getState = () => this.state;

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  async start(): Promise<void> {
    const { signedIn } = await call<{ signedIn: boolean }>("/api/auth");
    this.set({ signedIn });
    if (signedIn) await this.load();
  }

  signedIn(): Promise<void> {
    this.set({ signedIn: true });
    return this.load();
  }

  signedOut(): void {
    this.close();
    this.set({ signedIn: false, sessions: [], pendingHosts: [], devices: [], chat: undefined });
  }

  // Watches a chat (or none): its snapshot, and a stream with its events.
  watch(chatId: string | undefined): Promise<void> {
    if (chatId === this.state.chatId && this.source) return Promise.resolve();
    this.set({ chatId, chat: undefined });
    return this.load();
  }

  private async load(): Promise<void> {
    this.close();
    if (!this.state.signedIn) return;
    const chatId = this.state.chatId;
    const mine = ++this.loading;
    this.inFlight = true;
    try {
      const snap = await call<{ id: string; relay: RelayView; sessions: SessionView[]; pendingHosts: PendingHostView[]; devices: DeviceView[]; chat?: ChatView | null }>(
        `/api/snapshot${chatId ? `?chat=${encodeURIComponent(chatId)}` : ""}`,
      );
      if (mine !== this.loading || chatId !== this.state.chatId) return;
      this.last = snap.id;
      this.set({ relay: snap.relay, sessions: snap.sessions, pendingHosts: snap.pendingHosts ?? [], devices: snap.devices ?? [], chat: snap.chat ?? undefined });
      this.open();
    } catch (e) {
      if (mine === this.loading) this.failed(e);
    } finally {
      if (mine === this.loading) this.inFlight = false;
    }
  }

  // One stream at a time: a page with two would apply every event twice.
  private open(): void {
    this.close();
    // Opened when shown again (resume).
    if (document.visibilityState === "hidden") return;
    const chatId = this.state.chatId;
    const q = new URLSearchParams({ after: this.last ?? "" });
    if (chatId) q.set("chat", chatId);
    const source = new EventSource(`/api/events?${q}`);
    this.source = source;
    this.set({ stream: "connecting" });
    source.onopen = () => this.set({ stream: "open" });
    source.onmessage = (m) => {
      this.last = m.lastEventId;
      this.apply(JSON.parse(m.data) as ViewEvent);
      this.release();
    };
    source.addEventListener("reset", () => void this.load());
    source.addEventListener("signedOut", () => this.signedOut());
    source.onerror = () => {
      // The browser retries by itself, with Last-Event-ID; when it gives
      // up (a 401, say) find out why.
      if (source.readyState === EventSource.CLOSED) {
        this.set({ stream: "closed" });
        void this.check();
      } else {
        this.set({ stream: "connecting" });
      }
    };
  }

  private close(): void {
    this.source?.close();
    this.source = undefined;
  }

  // The page is shown again: a stream may be dead without saying so.
  private resume(): void {
    // A load under way opens its own stream when its snapshot comes.
    if (!this.state.signedIn || this.inFlight) return;
    this.close();
    // The stream from where it was, or a snapshot when too far behind.
    if (this.last) this.open();
    else void this.load();
  }

  private async check(): Promise<void> {
    try {
      const { signedIn } = await call<{ signedIn: boolean }>("/api/auth");
      if (!signedIn) return this.signedOut();
      setTimeout(() => this.resume(), 2000);
    } catch {
      setTimeout(() => void this.check(), 5000);
    }
  }

  private failed(e: unknown): void {
    if (e instanceof ApiError && e.status === 401) return this.signedOut();
    setTimeout(() => void this.load(), 3000);
  }

  private apply(e: ViewEvent): void {
    const s = this.state;
    switch (e.type) {
      case "relay":
        return this.set({ relay: e.relay });
      case "session": {
        const i = s.sessions.findIndex((x) => x.id === e.session.id);
        const sessions = i < 0 ? [...s.sessions, e.session] : s.sessions.map((x, j) => (j === i ? e.session : x));
        return this.set({ sessions });
      }
      case "sessionGone":
        return this.set({ sessions: s.sessions.filter((x) => x.id !== e.id) });
      case "pendingHosts":
        return this.set({ pendingHosts: e.hosts });
      case "devices":
        return this.set({ devices: e.devices });
      default:
        if (e.id !== s.chatId) return;
        return this.set({ chat: applyToChat(s.chat ?? { items: [], truncated: false, loading: true }, e) });
    }
  }

  // Resolves commands whose position the stream has now reached.
  private release(): void {
    const at = position(this.last);
    this.waiting = this.waiting.filter((w) => {
      if (at && (at.run !== w.at.run || at.seq >= w.at.seq)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  private alive(): void {
    const now = Date.now();
    if (!this.state.signedIn || now - this.lastAlive < 60_000) return;
    this.lastAlive = now;
    call("/api/alive", {}).catch((e) => {
      if (e instanceof ApiError && e.status === 401) this.signedOut();
    });
  }

  // A command to a session (core/api.ts); resolves once its effect is on
  // screen.
  async command<K extends CommandName>(sessionId: string, name: K, body: Body<K>): Promise<Answer<K>> {
    this.lastAlive = Date.now();
    let r: Answer<K> & { id: string };
    try {
      r = await call<Answer<K> & { id: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/${name}`, body);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.signedOut();
      throw e;
    }
    await this.reach(r.id);
    return r;
  }

  // Approves or rejects a host asking to join; resolves once the list on
  // screen no longer has it.
  decide(key: string, approve: boolean, label?: string): Promise<RelayAnswer> {
    return this.relayCall(`/api/hosts/${approve ? "approve" : "reject"}`, { key, ...(label ? { label } : {}) });
  }

  // Renames a registered device; resolves once the list on screen has the
  // new name.
  rename(key: string, label: string): Promise<RelayAnswer> {
    return this.relayCall("/api/devices/rename", { key, label });
  }

  // Removes a registered device; resolves once the list on screen no
  // longer has it.
  remove(key: string): Promise<RelayAnswer> {
    return this.relayCall("/api/devices/remove", { key });
  }

  // A one-time token for a new device, to show once.
  invite(role: "host" | "client", label: string): Promise<TokenAnswer> {
    return this.relayCall<TokenAnswer>("/api/devices/invite", { role, ...(label ? { label } : {}) });
  }

  private async relayCall<T extends RelayAnswer | TokenAnswer = RelayAnswer>(path: string, body: unknown): Promise<T> {
    this.lastAlive = Date.now();
    let r: T & { id: string };
    try {
      r = await call<T & { id: string }>(path, body);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) this.signedOut();
      throw e;
    }
    await this.reach(r.id);
    return r;
  }

  // Waits, not for ever, for the stream to reach an event ID.
  private async reach(id: string): Promise<void> {
    const at = position(id);
    const here = position(this.last);
    if (at && here && here.run === at.run && here.seq < at.seq) {
      await new Promise<void>((resolve) => {
        this.waiting.push({ at, resolve });
        // Not forever: the stream may be reconnecting.
        setTimeout(resolve, 5000);
      });
    }
  }
}

export const live = new Live();
