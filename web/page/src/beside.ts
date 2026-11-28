// Which running pi opens a new one (Launch.tsx), on the sessions page and
// in an ended session's place.
import type { SessionView } from "../../core/view.ts";

export const hostOf = (s: SessionView) => s.hostLabel || s.hostname;

// The session a group's new pi opens beside: the most recent one that can.
export function launchable(sessions: SessionView[]): SessionView | undefined {
  return sessions.filter((s) => s.launcher).sort((a, b) => (b.last?.at ?? b.startedAt ?? 0) - (a.last?.at ?? a.startedAt ?? 0))[0];
}

// The one a new pi in an ended session's folder opens beside: one in its
// tmux session or herdr workspace, else one on its machine; none on
// another machine, which has other folders.
export function besideEnded(was: SessionView, sessions: SessionView[]): SessionView | undefined {
  const host = sessions.filter((x) => x.id !== was.id && hostOf(x) === hostOf(was));
  return launchable(host.filter((x) => (x.place?.group ?? "") === (was.place?.group ?? ""))) ?? launchable(host);
}
