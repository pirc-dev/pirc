// A page left open keeps running the version it loaded. This one asks the
// server for its page now and then, and when that names other files (a
// deploy), reloads itself: at once if nothing would be lost, else once the
// person has nothing typed, nothing still sending and no sheet open
// (docs/web.md, section 3).
import { useEffect, useLayoutEffect, useRef } from "react";

// How often a page that stays on screen asks; it also asks when shown
// again and when its stream reconnects, no more than once a minute after
// an answer (a phone waking may ask before its network is back).
const EVERY_MS = 15 * 60_000;
const AT_MOST_MS = 60_000;
// How often a page waiting to reload looks again.
const WAIT_MS = 5_000;
// The version a reload was for, so that a page still served the old one
// after it does not reload again for the same.
const TRIED = "pirc.update.tried";

// What holds a reload back, each saying whether it does now: a draft, a
// message still sending, a chat read further up, an open sheet, a sign-in.
const holds = new Set<{ busy: boolean }>();

export function useHold(busy: boolean): void {
  const h = useRef({ busy });
  useLayoutEffect(() => {
    h.current.busy = busy;
  });
  useEffect(() => {
    const hold = h.current;
    holds.add(hold);
    return () => {
      holds.delete(hold);
    };
  }, []);
}

// The built files a page loads, as its HTML names them: these change with
// every build that changes anything.
function version(d: Document): string {
  return [...d.querySelectorAll<HTMLScriptElement | HTMLLinkElement>("script[src], link[rel=stylesheet][href], link[rel=modulepreload][href]")]
    .map((e) => e.getAttribute("src") ?? e.getAttribute("href"))
    .filter((u): u is string => !!u && u.startsWith("/assets/"))
    .sort()
    .join(" ");
}

const loaded = version(document);
let asked = 0;
let asking = false;
let waiting: ReturnType<typeof setInterval> | undefined;

export async function check(): Promise<void> {
  // Built pages only: the development server serves no /assets/.
  if (!loaded || waiting || asking || Date.now() - asked < AT_MOST_MS) return;
  asking = true;
  let now: string;
  try {
    const r = await fetch("/", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    now = version(new DOMParser().parseFromString(await r.text(), "text/html"));
    asked = Date.now();
  } catch {
    // Offline: the next check asks again.
    return;
  } finally {
    asking = false;
  }
  if (!now || now === loaded || tried() === now) return;
  if (reload(now)) return;
  waiting = setInterval(() => reload(now), WAIT_MS);
}

function reload(to: string): boolean {
  for (const h of holds) if (h.busy) return false;
  try {
    sessionStorage.setItem(TRIED, to);
  } catch {
    // Without storage, no guard against reloading again: a check a minute.
  }
  location.reload();
  return true;
}

function tried(): string | null {
  try {
    return sessionStorage.getItem(TRIED);
  } catch {
    return null;
  }
}

setInterval(() => {
  if (document.visibilityState === "visible") void check();
}, EVERY_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void check();
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) void check();
});
