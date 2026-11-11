// Notifications when a session finishes its turn or asks a question
// (docs/web.md, section 6): to every browser subscribed for a passkey that
// still exists, unless a page somewhere is showing that chat. Written from
// the notice the host puts in the announcement (core/notices.ts); for a
// session from a host older than notices, which never carries one, by the
// same rules here. A turn stopped on purpose (an abort) notifies no one.
import type { Client } from "../core/client.ts";
import { title } from "../core/names.ts";
import { news, notification } from "../core/notices.ts";
import type { ChatView, QuestionView, SessionView } from "../core/view.ts";
import { send, topicOf, type PushStore, type Subscription } from "./push.ts";
import type { EventLog } from "./stream.ts";

// How long a push service keeps a notification for a phone that is off:
// one older than this is no longer news.
const TTL_SECONDS = 24 * 3600;
// How many sessions' last notices are kept, gone ones included.
const SHOWN_KEPT = 1000;
// How much of the reply a notification shows.
const BODY_CHARS = 120;

// What the service worker shows (page/public/sw.js).
export interface Notice {
  title: string;
  body: string;
  // The page to open when it is tapped.
  url: string;
  // A later notice with the same tag replaces it.
  tag: string;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// The notice for the session's latest from its host, if it has one.
export function hostNotice(s: SessionView): Notice | undefined {
  const n = notification(s);
  return n && { ...n, url: `/s/${encodeURIComponent(s.id)}`, tag: s.id };
}

// For a host older than notices, the notice for a session whose turn has
// just finished: its title and host, and how the reply begins, or what
// went wrong; none for an abort.
export function notice(s: SessionView, chat: ChatView | undefined): Notice | undefined {
  const items = chat?.items ?? [];
  let reply;
  for (let i = items.length - 1; i >= 0 && !reply; i--) {
    const it = items[i];
    if (it.kind === "assistant") reply = it;
    else if (it.kind === "user") break;
  }
  if (reply?.stop === "aborted") return undefined;
  const text = (reply?.blocks ?? []).filter((b) => b.kind === "text").map((b) => b.text).join(" ").replace(/\s+/g, " ").trim();
  const body = reply?.stop === "error" ? `Failed: ${reply.error || "pi gave no reason"}` : text || "Finished";
  return {
    title: cut([title(s), s.hostLabel || s.hostname].filter(Boolean).join(" · "), 80),
    body: cut(body, BODY_CHARS),
    url: `/s/${encodeURIComponent(s.id)}`,
    tag: s.id,
  };
}

// For a host older than notices, the notice for a question a session has
// just asked.
export function questionNotice(s: SessionView, q: QuestionView): Notice {
  const asked = [q.title, q.message].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return {
    title: cut([title(s), s.hostLabel || s.hostname].filter(Boolean).join(" · "), 80),
    body: cut(`Asks: ${asked || "a question in pi's terminal"}`, BODY_CHARS),
    url: `/s/${encodeURIComponent(s.id)}`,
    tag: s.id,
  };
}

export interface NotifierOptions {
  log: EventLog;
  client: Client;
  store: PushStore;
  // The passkeys that still exist; a revoked one's browsers get nothing.
  passkeys: () => string[];
  // Whether a page is showing the chat.
  watching: (chat: string) => boolean;
  // How the push services can reach whoever runs the server: the app's
  // address.
  subject: string;
  logLine?: (msg: string) => void;
}

export class Notifier {
  private working = new Map<string, boolean>();
  // The questions each session has been seen asking.
  private asked = new Map<string, Set<string>>();
  // The number of the last notice from the host taken for each session,
  // kept when it goes: a host back after a drop announces it again, with
  // any notice raised meanwhile, which is then news. The oldest go past
  // SHOWN_KEPT.
  private shown = new Map<string, number>();

  constructor(private readonly o: NotifierOptions) {}

  start(): () => void {
    return this.o.log.listen(({ event: e }) => {
      if (e.type === "sessionGone") {
        this.working.delete(e.id);
        this.asked.delete(e.id);
      }
      if (e.type !== "session") return;
      const s = e.session;
      const was = this.working.get(s.id);
      this.working.set(s.id, s.working);
      // Those asked before the session was first seen are not news.
      const before = this.asked.get(s.id);
      const now = s.questions ?? [];
      this.asked.set(s.id, new Set(now.map((q) => q.id)));
      const fresh = before ? now.filter((q) => !before.has(q.id)) : [];
      // A session first seen is not news (core/notices.ts).
      const last = this.shown.get(s.id);
      const r = news(last === undefined ? {} : { [s.id]: last }, [s]);
      this.shown.delete(s.id);
      this.shown.set(s.id, r.shown[s.id]);
      if (this.shown.size > SHOWN_KEPT) this.shown.delete(this.shown.keys().next().value!);
      if (s.notice) {
        const n = hostNotice(s);
        if (r.notify.length && n && !this.o.watching(s.id)) void this.toAll(n);
        return;
      }
      if (fresh.length && !this.o.watching(s.id)) void this.toAll(questionNotice(s, fresh[fresh.length - 1]));
      if (was && !s.working) this.finished(s);
    });
  }

  private finished(s: SessionView): void {
    if (this.o.watching(s.id)) return;
    const n = notice(s, this.o.client.chat(s.id));
    if (n) void this.toAll(n);
  }

  // To every browser of a passkey that still exists.
  async toAll(n: Notice): Promise<void> {
    const live = new Set(this.o.passkeys());
    await Promise.all(this.o.store.subscriptions().filter((x) => live.has(x.passkeyId)).map((x) => this.to(x, n)));
  }

  // To one browser: "sent", or why not. A subscription the push service
  // says is gone is forgotten.
  async to(sub: Subscription, n: Notice): Promise<string> {
    const where = new URL(sub.endpoint).host;
    try {
      const { status, said } = await send(sub, n, this.o.store.keys(), this.o.subject, { ttlSeconds: TTL_SECONDS, topic: topicOf(n.tag) });
      if (status === 404 || status === 410) {
        this.o.store.remove(sub.endpoint);
        this.o.logLine?.(`push: a subscription at ${where} has ended (${status}${said ? `: ${said}` : ""}); forgotten`);
        return "the browser's subscription has ended";
      }
      if (status < 200 || status >= 300) {
        this.o.logLine?.(`push: ${where} answered ${status}${said ? `: ${said}` : ""}`);
        return `the push service answered ${status}${said ? `: ${said}` : ""}`;
      }
      return "sent";
    } catch (e) {
      this.o.logLine?.(`push: ${where}: ${(e as Error).message}`);
      return `the push service could not be reached: ${(e as Error).message}`;
    }
  }
}
