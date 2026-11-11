// Something over the page (a sheet, the model picker, a table full screen)
// is a step in the history, so that going back, the phone's back gesture,
// closes it rather than leaving the chat; Escape closes it too. Layers
// stack: each knows its depth, and closing one closes those over it with
// it, in one step back.
import { useEffect, useRef } from "react";

const depthNow = (): number => (history.state as { layer?: number } | null)?.layer ?? 0;

// Going back lands later. Until it does, where it is going counts as where
// the history is, so that a second close (a second Escape or tap, or two
// layers unmounting together) does not go back again, out of the chat.
let going: number | undefined;
window.addEventListener("popstate", () => (going = undefined));

// Whether something is over the page, which then has the keys.
export const layerOpen = (): boolean => (going ?? depthNow()) > 0;

// Back to just under the layer at this depth, if it is still there.
function backTo(depth: number): void {
  const now = going ?? depthNow();
  if (depth === 0 || now < depth) return;
  going = depth - 1;
  history.go(-(now - depth + 1));
}

// A reload keeps the step of a layer that is no longer open: leave it.
if (depthNow() > 0) backTo(1);

// Runs fn once the history has settled from closing layers: a step back
// lands later, and would undo a navigation pushed before it does.
export function afterLayers(fn: () => void): void {
  if (going === undefined) return fn();
  const on = () => {
    window.removeEventListener("popstate", on);
    // After the page's own listeners have followed the step back.
    setTimeout(fn, 0);
  };
  window.addEventListener("popstate", on);
}

export function useLayer(open: boolean, closed: () => void): { show: () => void; close: () => void } {
  const depth = useRef(0);
  const onClosed = useRef(closed);
  onClosed.current = closed;
  const close = () => backTo(depth.current);
  useEffect(() => {
    if (!open) return;
    const popped = () => {
      if (depthNow() < depth.current) onClosed.current();
    };
    // Only the top layer answers Escape, and it is taken: it does not
    // also stop pi (keys.ts).
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || depthNow() !== depth.current) return;
      e.preventDefault();
      close();
    };
    window.addEventListener("popstate", popped);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("popstate", popped);
      window.removeEventListener("keydown", key);
      // Gone while open (the chat trimmed, signed out): its step goes too.
      backTo(depth.current);
    };
    // close reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const show = () => {
    depth.current = (going ?? depthNow()) + 1;
    history.pushState({ layer: depth.current }, "");
  };
  return { show, close };
}
