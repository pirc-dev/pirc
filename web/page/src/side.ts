// The session list's column in the wide layout: how wide it is, dragged by
// its edge, and whether it is hidden, by the button at the start of what is
// beside it. Kept in this browser only.
import { useSyncExternalStore } from "react";

export const SIDE_WIDTH = 380;
export const SIDE_MIN = 280;
export const SIDE_MAX = 560;
// What is beside the list keeps at least this much.
export const SIDE_ROOM = 400;

const KEY = "pirc.side";

type Side = { width: number; hidden: boolean };

function load(): Side {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Side>;
    return { width: typeof v.width === "number" ? v.width : SIDE_WIDTH, hidden: v.hidden === true };
  } catch {
    return { width: SIDE_WIDTH, hidden: false };
  }
}

let side = load();
const listeners = new Set<() => void>();

function put(next: Side, keep: boolean): void {
  side = next;
  if (keep) {
    try {
      localStorage.setItem(KEY, JSON.stringify(side));
    } catch {
      // Kept for this visit only.
    }
  }
  for (const l of listeners) l();
}

// The width the column has in a window [room] wide.
export function sideWidth(width: number, room: number): number {
  return Math.round(Math.max(SIDE_MIN, Math.min(width, SIDE_MAX, room - SIDE_ROOM)));
}

// While dragged, the width follows without being kept; at the end it is.
export function setSideWidth(width: number, keep = true): void {
  put({ ...side, width: Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(width))) }, keep);
}

export function setSideHidden(hidden: boolean): void {
  put({ ...side, hidden }, true);
}

export function useSide(): Side {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, () => side);
}
