// What a screen reader is told of an open chat as it changes (announce.ts):
// pi's reply when a turn ends, that it failed, or what it asks, by the
// session's latest notice; an extension's warning or error; a message not
// sent. Only what happens while the chat is open: not what it showed when
// it opened, nor earlier items loaded later.
import { cut } from "../../core/notices.ts";
import type { ChatItem, SessionView } from "../../core/view.ts";

export interface Heard {
  // The session's latest notice, by number; 0 for none.
  notice: number;
  // The last item, by ID: those after it are new.
  last: string | undefined;
  // Messages from here that failed to send, by key.
  failed: Set<number>;
}

export interface Saying {
  text: string;
  urgent: boolean;
}

interface Unsent {
  key: number;
  state: string;
  error?: string;
}

export function said(was: Heard | undefined, s: SessionView | undefined, items: ChatItem[] | undefined, pending: Unsent[]): { heard: Heard; say: Saying[] } {
  const failed = new Set(pending.filter((x) => x.state === "failed" || x.state === "lost").map((x) => x.key));
  const heard: Heard = { notice: s?.notice?.number ?? 0, last: items?.at(-1)?.id ?? was?.last, failed };
  if (!was) return { heard, say: [] };
  const say: Saying[] = [];
  const n = s?.notice;
  if (n && n.number > was.notice) {
    say.push(n.kind === "failed" ? { text: `pi failed: ${n.text || "it gave no reason"}`, urgent: true }
      : n.kind === "question" ? { text: `pi asks: ${n.text || "a question in its terminal"}`, urgent: false }
      : { text: n.text ? `pi: ${n.text}` : "pi finished", urgent: false });
  }
  const from = was.last === undefined ? -1 : (items ?? []).findIndex((x) => x.id === was.last);
  if (items && (from >= 0 || was.last === undefined)) {
    for (const it of items.slice(from + 1)) {
      if (it.kind === "notification" && it.level !== "info") say.push({ text: `${it.level === "error" ? "Error" : "Warning"}: ${cut(it.text, 200)}`, urgent: it.level === "error" });
    }
  }
  for (const x of pending) {
    if (!failed.has(x.key) || was.failed.has(x.key)) continue;
    say.push({ text: x.state === "lost" ? "Not sent: pi stopped first" : `Not sent: ${x.error || "no answer"}`, urgent: true });
  }
  return { heard, say };
}
