// The page's look: Quiet (type and hairlines), Triage (cards on grey, one
// blue accent), Native (the phone's own system: grouped cards, round
// status badges, the system font) or Cockpit (a terminal's pane: Catppuccin,
// monospace for names). All are the same screens with the same behaviour;
// the look is the palette, the fonts and the shape of things, chosen by
// data-look on the root element, with data-shape naming the shape it
// builds on: "page" (Quiet's, which Cockpit dresses) or "cards" (Triage's,
// which Native dresses). index.css redefines colours and fonts under them;
// classes prefixed "cards:" apply to both card looks, and "triage:",
// "native:" and "cockpit:" to one look only. Kept in this browser only,
// like which hosts are open.
import { useSyncExternalStore } from "react";

export type Look = "quiet" | "triage" | "native" | "cockpit";
export const LOOKS: Look[] = ["quiet", "triage", "native", "cockpit"];

const SHAPE: Record<Look, "page" | "cards"> = { quiet: "page", triage: "cards", native: "cards", cockpit: "page" };

const KEY = "pirc.look";

// The browser's bar and the app's splash follow the page's paper. These
// are index.css's, which the meta tags must name before any CSS loads.
const PAPER: Record<Look, { light: string; dark: string }> = {
  quiet: { light: "#fbfbf9", dark: "#16171a" },
  triage: { light: "#f5f6f8", dark: "#111317" },
  native: { light: "#f2f2f7", dark: "#000000" },
  cockpit: { light: "#eff1f5", dark: "#1e1e2e" },
};

export function isLook(v: unknown): v is Look {
  return LOOKS.includes(v as Look);
}

function load(): Look {
  try {
    const v = localStorage.getItem(KEY);
    return isLook(v) ? v : "quiet";
  } catch {
    return "quiet";
  }
}

let look: Look = load();
const listeners = new Set<() => void>();

// Puts the look on the page; main.tsx calls it before the first render, so
// that the page never shows in another look first.
export function applyLook(): void {
  document.documentElement.dataset.look = look;
  document.documentElement.dataset.shape = SHAPE[look];
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = meta.media.includes("dark") ? PAPER[look].dark : PAPER[look].light;
  }
}

export function setLook(next: Look): void {
  if (next === look) return;
  look = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not kept; it still applies for this visit.
  }
  applyLook();
  for (const f of listeners) f();
}

function subscribe(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

// For the few places whose markup, not only style, differs by look.
export function useLook(): Look {
  return useSyncExternalStore(subscribe, () => look);
}
