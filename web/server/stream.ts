// The server's event stream: every view event numbered, the latest kept
// for pages that reconnect, and passed to the pages listening
// (docs/web.md, section 3).
import type { ChatItem, ChatView, ViewEvent } from "../core/view.ts";

// Events kept for pages catching up, by number and by size; a page
// further behind loads a snapshot.
export const KEPT = 5000;
export const KEPT_BYTES = 16 << 20;

export interface Numbered {
  seq: number;
  event: ViewEvent;
  // The event as sent, once for every page.
  json: string;
}

type Listener = (e: Numbered) => void;

// The items of a chat a page is sent at first, in a snapshot or a
// chatReset, and asks for at a time after: the server keeps up to 1000
// (CHAT_LIMIT), which a page would take seconds to load and draw.
export const TAIL = 100;

// A chat's latest items, as a page is sent it; earlier says the server has
// more before them, and turnAt when the turn under way started, when its
// user message is among those left out.
export function tailOf(chat: ChatView, n = TAIL): ChatView {
  if (chat.items.length <= n) return chat;
  const items = chat.items.slice(-n);
  const turn = items.at(-1)!.turnId;
  const start = turn && !items.some((x) => x.kind === "user" && x.turnId === turn)
    ? chat.items.find((x) => x.kind === "user" && x.turnId === turn)
    : undefined;
  return { ...chat, items, earlier: true, ...(start ? { turnAt: start.at } : {}) };
}

// The items before the one with ID before, up to n; undefined when the
// chat no longer has it.
export function olderThan(chat: ChatView, before: string, n = TAIL): { items: ChatItem[]; earlier: boolean } | undefined {
  const i = chat.items.findIndex((x) => x.id === before);
  if (i < 0) return undefined;
  return { items: chat.items.slice(Math.max(0, i - n), i), earlier: i > n };
}

// An event as pages are sent it: a chatReset with the chat's latest items,
// and a chatItem that replaced one marked old, which a page without that
// one leaves for when it loads it.
export function forPages(e: ViewEvent, replaced = false): ViewEvent {
  if (e.type === "chatReset") return { ...e, chat: tailOf(e.chat) };
  if (e.type === "chatItem" && replaced) return { ...e, old: true };
  return e;
}

// The chat an event belongs to, if any; the others go to every page.
export function chatOf(e: ViewEvent): string | undefined {
  switch (e.type) {
    case "chatReset":
    case "chatItem":
    case "chatDelta":
    case "toolProgress":
      return e.id;
    default:
      return undefined;
  }
}

// Whether a page watching chat (or none) receives e.
export function wanted(e: ViewEvent, chat: string | undefined): boolean {
  const c = chatOf(e);
  return c === undefined || c === chat;
}

export class EventLog {
  private kept: Numbered[] = [];
  private keptBytes = 0;
  private last = 0;
  private listeners = new Set<Listener>();

  // Numbers start again when the server does: an event's ID on the stream
  // is "<run>.<seq>", so that a page holding one from an earlier run loads
  // a snapshot rather than skip what it never saw.
  constructor(readonly run: string, private readonly keep = KEPT, private readonly keepBytes = KEPT_BYTES) {}

  id(seq: number): string {
    return `${this.run}.${seq}`;
  }

  // The seq of an ID of this run's; undefined for any other.
  parse(id: string | undefined): number | undefined {
    const m = id ? /^([^.]+)\.(\d+)$/.exec(id) : null;
    return m && m[1] === this.run ? Number(m[2]) : undefined;
  }

  // The number of the latest event; 0 before the first.
  get seq(): number {
    return this.last;
  }

  // replaced: as Client's onEvent says (forPages).
  push(e: ViewEvent, replaced?: boolean): void {
    const event = forPages(e, replaced);
    const n: Numbered = { seq: ++this.last, event, json: JSON.stringify(event) };
    this.kept.push(n);
    this.keptBytes += n.json.length;
    let drop = 0;
    while (this.kept.length - drop > 1 && (this.kept.length - drop > this.keep || this.keptBytes > this.keepBytes)) {
      this.keptBytes -= this.kept[drop].json.length;
      drop++;
    }
    if (drop) this.kept.splice(0, drop);
    for (const l of this.listeners) l(n);
  }

  // The events after seq, or undefined when some are no longer kept (or
  // seq is from the future: another run of the server).
  since(seq: number): Numbered[] | undefined {
    if (seq > this.last) return undefined;
    if (seq === this.last) return [];
    const first = this.kept[0]?.seq ?? this.last + 1;
    if (seq + 1 < first) return undefined;
    return this.kept.slice(seq + 1 - first);
  }

  listen(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

// The chats pages are showing: one for each event stream open on a chat.
// A page closes its stream while hidden, so a chat counts only while it
// is on a screen.
export class Watchers {
  private open = new Map<string, number>();

  // Counted until the returned function is called.
  add(chat: string): () => void {
    this.open.set(chat, (this.open.get(chat) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.open.get(chat) ?? 1) - 1;
      if (n > 0) this.open.set(chat, n);
      else this.open.delete(chat);
    };
  }

  has(chat: string): boolean {
    return this.open.has(chat);
  }
}
