// What a session is called, on screen and in a notification.
import type { SessionView } from "./view.ts";

export function folder(cwd: string): string {
  return cwd.split("/").filter(Boolean).pop() || cwd || "pi";
}

// A session is called by pi's name for it, else by its first message, as
// pi's own list does, else by its folder (docs/design.md, section 4). Not
// by its window or tab, which can hold several.
export function title(s: SessionView): string {
  return s.name.trim() || s.first || folder(s.cwd);
}

// The window or tab it runs in, as the terminal names it; absent when not
// known.
export function windowOf(s: SessionView): string | undefined {
  return s.place?.display || s.place?.window || undefined;
}

// What the title leaves out: the folder, the model.
export function details(s: SessionView): string {
  return [s.cwd, s.model && (s.model.name || s.model.id)].filter(Boolean).join(" · ");
}

// Where it runs, host first: "LC › work › api", or the display string an
// extension gave in place of the names.
export function where(s: SessionView): string {
  const place = s.place?.display ? [s.place.display] : [s.place?.group, s.place?.window];
  return [s.hostLabel || s.hostname, ...place].filter(Boolean).join(" › ");
}

// How long ago, shortly: "now", "5m", "3h", "Mon", "12 Oct". A host's clock
// ahead of this one's counts as now. Past a day, the date is written by the
// client in its own language: day(at, true) its weekday, day(at, false) its
// day and month.
export function ago(at: number, now: number, day: (at: number, weekday: boolean) => string): string {
  const m = Math.floor((now - at) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h`;
  return day(at, m < 6 * 24 * 60);
}
