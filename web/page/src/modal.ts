// Something over the page (a sheet, the model picker, an image or a table
// full screen) holds the focus while it is open: everything else is inert,
// out of reach of Tab and of a screen reader's cursor, as a native modal
// dialog's page is. Focus goes into it, and back to where it was after.
// They stack: the top one is the one not inert, and closing it gives the
// one under it back. The screen reader's announcements (announce.ts) stay.
import { type RefObject, useLayoutEffect } from "react";

const open: HTMLElement[] = [];
// The elements made inert, which were not so already.
const made = new Set<HTMLElement>();

// Everything beside the path from the top one up to the page's body.
function apply(): void {
  const keep = new Set<Element>();
  const top = open.at(-1);
  for (let el: Element | null = top ?? null; el && el !== document.body; el = el.parentElement) keep.add(el);
  const want = new Set<HTMLElement>();
  if (top) {
    for (const el of keep) {
      for (const sib of el.parentElement?.children ?? []) {
        if (!keep.has(sib) && sib instanceof HTMLElement && !sib.hasAttribute("data-announce")) want.add(sib);
      }
    }
  }
  for (const el of made) {
    if (!want.has(el)) {
      el.inert = false;
      made.delete(el);
    }
  }
  for (const el of want) {
    if (!el.inert) {
      el.inert = true;
      made.add(el);
    }
  }
}

// [holder] is what holds the focus, while [open]; [first] what has it on
// opening, or else the first field or button in [within] (by default the
// holder).
export function useModal(holder: RefObject<HTMLElement | null>, o: { open?: boolean; first?: RefObject<HTMLElement | null>; within?: RefObject<HTMLElement | null> } = {}): void {
  const on = o.open ?? true;
  useLayoutEffect(() => {
    const el = holder.current;
    if (!on || !el) return;
    const before = document.activeElement as HTMLElement | null;
    open.push(el);
    apply();
    const within = o.within?.current ?? el;
    (o.first?.current ?? within.querySelector<HTMLElement>("input, textarea, button:not(:disabled), [tabindex='0']") ?? within).focus({ preventScroll: true });
    return () => {
      open.splice(open.indexOf(el), 1);
      apply();
      // Back where it was, unless that has gone (or is under another one
      // still open).
      if (before?.isConnected && !before.closest("[inert]")) before.focus({ preventScroll: true });
    };
    // As it opens and closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
}
