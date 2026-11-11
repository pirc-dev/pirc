// Notifications, written by each client from the latest notice the host
// put in a session's announcement (docs/design.md, section 12, step 13):
// which sessions have one not yet shown, and its title and text.
import { title } from "./names.ts";
import type { SessionView } from "./view.ts";

export interface Notification {
  title: string;
  body: string;
}

// Cut to n Unicode code points, "…" included, as the host cuts a notice.
export function cut(s: string, n: number): string {
  const points = [...s];
  return points.length > n ? `${points.slice(0, n - 1).join("").trimEnd()}…` : s;
}

// The session's title and host, and what its notice says; none when it
// has no notice. The text is the host's, already cut: a prefix may take
// the body past 120.
export function notification(s: SessionView): Notification | undefined {
  const n = s.notice;
  if (!n) return undefined;
  const body = n.kind === "failed" ? `Failed: ${n.text || "pi gave no reason"}`
    : n.kind === "question" ? `Asks: ${n.text || "a question in pi's terminal"}`
    : n.text || "Finished";
  return { title: cut([title(s), s.hostLabel || s.hostname].filter(Boolean).join(" · "), 80), body };
}

// The sessions whose notice is past the last shown for them, and the
// numbers shown once they are: one for each session listed, 0 for one
// with no notice yet. A session seen for the first time is not news,
// unless since is given and its notice is later (a phone woken after
// since, the time it last looked, by the host's clock); one no longer
// listed is forgotten.
export function news(shown: Record<string, number>, sessions: SessionView[], since?: number): { notify: SessionView[]; shown: Record<string, number> } {
  const notify: SessionView[] = [];
  const next: Record<string, number> = {};
  for (const s of sessions) {
    const number = s.notice?.number ?? 0;
    const last = shown[s.id] ?? (since === undefined ? number : since);
    if (number > last) notify.push(s);
    next[s.id] = Math.max(number, shown[s.id] ?? 0);
  }
  return { notify, shown: next };
}
