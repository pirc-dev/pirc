// The session list's column in the wide layout (side.ts): a button that
// hides and shows it, at the start of what is beside it, so that it stays
// in one place either way; and its edge, dragged to make it wider or
// narrower, or moved by the arrow keys once focused. A double click puts
// it back as it was.
import { useRef } from "react";

import { Icon } from "./icons.tsx";
import { SIDE_MAX, SIDE_MIN, SIDE_WIDTH, setSideHidden, setSideWidth, sideWidth, useSide } from "./side.ts";

export function SideToggle() {
  const side = useSide();
  return (
    <button
      className="grid size-11 flex-none place-items-center text-ink2 cards:text-accent native:text-accent cockpit:text-ink3"
      aria-label={side.hidden ? "Show the list" : "Hide the list"}
      aria-expanded={!side.hidden}
      title={side.hidden ? "Show the list" : "Hide the list"}
      onClick={() => setSideHidden(!side.hidden)}
    >
      <Icon name="side" className="size-[22px]" />
    </button>
  );
}

export function SideEdge() {
  const side = useSide();
  const from = useRef<{ x: number; width: number; room: number } | undefined>(undefined);
  const column = (el: HTMLElement) => el.parentElement!;
  const room = (el: HTMLElement) => column(el).parentElement!.getBoundingClientRect().width;
  const shown = (el: HTMLElement) => column(el).getBoundingClientRect().width;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="List width"
      aria-valuenow={Math.round(side.width)}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_MAX}
      tabIndex={0}
      className="absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2 after:bg-accent after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-100"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        from.current = { x: e.clientX, width: shown(el), room: room(el) };
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const f = from.current;
        if (f) setSideWidth(sideWidth(f.width + e.clientX - f.x, f.room), false);
      }}
      onPointerUp={(e) => {
        const f = from.current;
        from.current = undefined;
        if (f) setSideWidth(sideWidth(f.width + e.clientX - f.x, f.room));
      }}
      onPointerCancel={() => {
        from.current = undefined;
      }}
      onDoubleClick={() => setSideWidth(SIDE_WIDTH)}
      onKeyDown={(e) => {
        const step = e.key === "ArrowLeft" ? -20 : e.key === "ArrowRight" ? 20 : 0;
        if (!step) return;
        e.preventDefault();
        const el = e.currentTarget;
        setSideWidth(sideWidth(shown(el) + step, room(el)));
      }}
    />
  );
}
