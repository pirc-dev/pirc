// A sheet over the page, from the bottom (or from the top, where the
// keyboard would cover it): a title, plain rows, and a scrim that closes
// it. Its owner opens and closes it through useLayer (layer.ts), so that
// going back closes it.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { useHold } from "./update.ts";

export function Sheet(p: { title: string; sub?: string; done?: string; top?: boolean; close: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useHold(true);
  // Focus moves into the sheet, and back to where it was after.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus({ preventScroll: true });
    return () => before?.focus({ preventScroll: true });
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-40">
      <button className="absolute inset-0 bg-scrim" aria-label="Close" tabIndex={-1} onClick={p.close} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={p.title}
        className={`absolute inset-x-0 mx-auto max-w-lg bg-sheet shadow-[0_-10px_40px_rgb(0_0_0/0.14)] native:shadow-[0_-8px_30px_rgb(0_0_0/0.15)] cockpit:border-wash2 ${p.top ? "native:rounded-b-[14px] cockpit:rounded-b-[18px] cockpit:border-b" : "native:rounded-t-[14px] cockpit:rounded-t-[18px] cockpit:border-t"} ${
          p.top
            ? "top-0 rounded-b-[22px] pt-[max(0.75rem,env(safe-area-inset-top))] pb-5"
            : "bottom-0 max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-[22px] pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
        }`}
      >
        {!p.top && <div className="mx-auto mb-2.5 h-1 w-9 rounded-full bg-wash2" />}
        <div className="flex items-start justify-between gap-3 px-5 pt-1 pb-3">
          <div className="min-w-0">
            <h2 className="truncate font-read text-2xl cards:text-xl cards:font-[650] native:text-[17px] native:font-semibold cockpit:font-mono cockpit:text-base cockpit:font-bold">{p.title}</h2>
            {p.sub && <p className="mt-0.5 truncate text-[13px] text-ink2 cockpit:font-mono cockpit:text-[11.5px] cockpit:text-ink3">{p.sub}</p>}
          </div>
          {p.done && <button className="flex min-h-11 min-w-11 items-center justify-end text-[15px] text-ink2 cards:font-medium cards:text-accent native:text-[17px] native:font-semibold cockpit:font-mono cockpit:text-sm cockpit:text-link" onClick={p.close}>{p.done}</button>}
        </div>
        {p.children}
      </div>
    </div>,
    document.body,
  );
}

// Rows that belong together: in Quiet and Cockpit, only ruled apart; in
// Triage and Native, on a card of their own.
export function SheetGroup(p: { children: React.ReactNode }) {
  return <div className="cards:mx-3 cards:mb-2.5 cards:overflow-hidden cards:rounded-[14px] cards:border cards:border-rule cards:bg-card native:mx-4 native:mb-4 native:border-0 native:bg-sheet-card">{p.children}</div>;
}

// A row of a sheet: a label, an optional line under it, and a value.
export function SheetRow(p: { label: string; sub?: string; value?: React.ReactNode; danger?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      className={`flex min-h-13 w-full items-center gap-3 border-t border-rule px-5 py-2 text-left text-base disabled:opacity-40 active:bg-wash cards:px-3.5 cards:first:border-t-0 native:min-h-12 native:px-4 cockpit:min-h-[50px] cockpit:px-4 cockpit:text-[15px] ${p.danger ? "text-block" : ""}`}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      {/* Wrapped anywhere: a label can be a long path. */}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {p.label}
        {p.sub && <small className="mt-px block truncate text-[13px] text-ink2 cockpit:font-mono cockpit:text-xs cockpit:text-ink3">{p.sub}</small>}
      </span>
      {p.value}
    </button>
  );
}

// Two answers side by side: Cancel, or another word for not doing it, and
// the action.
export function Answers(p: { cancel: () => void; cancelLabel?: string; label: string; danger?: boolean; disabled?: boolean; go: () => void }) {
  return (
    <div className="flex gap-2.5">
      <button className="h-12 flex-1 rounded-full text-[15.5px] font-semibold ring-1 ring-ink3 ring-inset cards:h-13 cards:rounded-[14px] cards:bg-wash cards:ring-0 cockpit:rounded-[10px] cockpit:ring-rule" onClick={p.cancel}>{p.cancelLabel ?? "Cancel"}</button>
      <button className={`h-12 flex-1 rounded-full text-[15.5px] font-semibold text-paper disabled:opacity-40 cards:h-13 cards:rounded-[14px] cockpit:rounded-[10px] ${p.danger ? "bg-block cards:bg-block-wash cards:text-block cockpit:bg-block-wash cockpit:text-block cockpit:ring-1 cockpit:ring-block cockpit:ring-inset" : "bg-ink cards:bg-accent cards:text-on-accent cockpit:bg-accent cockpit:text-on-accent"}`} disabled={p.disabled} onClick={p.go}>{p.label}</button>
    </div>
  );
}
