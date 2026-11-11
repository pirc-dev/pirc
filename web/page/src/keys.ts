// Keys on a computer, as in a terminal: j and k move through the list, n
// opens the next session waiting, Esc stops pi. A computer is told by its
// mouse or trackpad, taken as a sign of a hardware keyboard (as Enter
// sending is). On in every look, and turned off in Settings, kept in this
// browser only; Cockpit also prints them on its buttons.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { layerOpen } from "./layer.ts";

const KEYBOARD = "(pointer: fine)";

export function useKeyboard(): boolean {
  const [fine, setFine] = useState(() => matchMedia(KEYBOARD).matches);
  useEffect(() => {
    const m = matchMedia(KEYBOARD);
    const on = () => setFine(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return fine;
}

const KEY = "pirc.keys";

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let on = load();
const listeners = new Set<() => void>();

export function setKeys(next: boolean): void {
  on = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    // Kept for this visit only.
  }
  for (const l of listeners) l();
}

// Whether the keys are on: a computer, and not turned off.
export function useKeys(): boolean {
  const chosen = useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => on);
  return useKeyboard() && chosen;
}

export function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

// A key press the app's keys may take: no modifier, no input method
// composing, nothing over the page, and not typed into a field.
export function free(e: KeyboardEvent): boolean {
  return !e.defaultPrevented && !e.metaKey && !e.ctrlKey && !e.altKey && !e.isComposing && !layerOpen() && !typing(e.target);
}

// Listens for keys while enabled.
export function useKey(enabled: boolean, handle: (e: KeyboardEvent) => void): void {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    if (!enabled) return;
    const key = (e: KeyboardEvent) => latest.current(e);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [enabled]);
}
