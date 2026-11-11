// The order of sessions under a host or group, as Claude's apps order
// conversations: the most recent first, whatever its status. A working
// session is as recent as its turn's start, so that its replies do not
// move it; the others, as their latest message. Among equals, by window.
import type { SessionView } from "./view.ts";

// When each working session's turn started, as this client saw it: the
// user's message that started it (or a later one, steering it), else its
// latest message when first seen working. Not the latest message itself,
// which the turn's replies move, and the row with them. Host times, as
// every other time in the list.
export class Starts {
  private starts = new Map<string, number>();

  // Called with every list of sessions; returns the working ones' starts.
  update(sessions: SessionView[]): Map<string, number> {
    const next = new Map<string, number>();
    for (const s of sessions) {
      if (!(s.working || s.compacting) || !s.last) continue;
      const before = this.starts.get(s.id);
      const start = before === undefined ? s.last.at : s.last.who === "user" ? Math.max(before, s.last.at) : before;
      next.set(s.id, start);
    }
    this.starts = next;
    return next;
  }
}

export const byWindow = (a: SessionView, b: SessionView, title: (s: SessionView) => string) =>
  (a.place?.windowNumber ?? Infinity) - (b.place?.windowNumber ?? Infinity) || title(a).localeCompare(title(b));

export function compare(starts: Map<string, number>, title: (s: SessionView) => string) {
  const at = (s: SessionView) => starts.get(s.id) ?? s.last?.at ?? s.startedAt ?? 0;
  return (a: SessionView, b: SessionView): number => at(b) - at(a) || byWindow(a, b, title);
}

// The session n opens: the next one waiting for the reader after the one
// open, round to the first. Those asking a question come first, then those
// finished since last open, each in the list's order.
export function nextWaiting(sessions: SessionView[], news: Set<string>, order: (a: SessionView, b: SessionView) => number, open?: string): SessionView | undefined {
  const asking = sessions.filter((s) => s.questions?.length).sort(order);
  const done = sessions.filter((s) => !s.questions?.length && news.has(s.id)).sort(order);
  const waiting = [...asking, ...done];
  const at = waiting.findIndex((s) => s.id === open);
  return waiting[(at + 1) % waiting.length];
}
