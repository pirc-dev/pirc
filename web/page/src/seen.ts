// How far each session's chat has been read, in this browser only: the
// time of its latest message when it was last open. A session whose latest
// message is newer, and which has stopped working, has news. Times are the
// host's, as the messages', so clocks that disagree do not matter.
import type { SessionView } from "../../core/view.ts";

const KEY = "pirc.seen";
// Kept for the most recently read sessions only.
const KEEP = 500;

function load(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

function save(seen: Record<string, number>): void {
  const kept = Object.entries(seen).sort((a, b) => b[1] - a[1]).slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Not kept; every session shows as read next time.
  }
}

// Told when a session is marked read, so that a list on screen beside the
// chat that read it moves it at once.
const listeners = new Set<() => void>();
export function onSeen(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

export function markSeen(id: string, at: number): void {
  const seen = load();
  if ((seen[id] ?? -1) >= at) return;
  seen[id] = at;
  save(seen);
  for (const f of listeners) f();
}

// The sessions with news. One not seen here before counts as read up to
// its latest message once it has one (its history may still be loading),
// so that a first visit, or a session resumed in its terminal, marks
// nothing.
export function withNews(sessions: SessionView[]): Set<string> {
  const seen = load();
  const news = new Set<string>();
  let changed = false;
  for (const s of sessions) {
    if (!(s.id in seen)) {
      if (!s.last) continue;
      seen[s.id] = s.last.at;
      changed = true;
    } else if (s.last && s.last.at > seen[s.id] && !s.working && !s.compacting) news.add(s.id);
  }
  if (changed) save(seen);
  return news;
}
