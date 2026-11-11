// Markdown tables. On a narrow screen a table scrolls sideways rather than
// squeezing its columns to a letter each: text columns keep a readable
// width, the first column stays put while the rest scroll under it, and
// the edge that hides more is shaded. One wider than the screen can also
// open full screen, where a phone turned sideways shows more of it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./icons.tsx";
import { useLayer } from "./layer.ts";

type Props<T extends keyof React.JSX.IntrinsicElements> = React.ComponentProps<T> & { node?: unknown };

export function Table({ node: _, children }: Props<"table">) {
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const [full, setFull] = useState(false);
  // A table still streaming in grows, so its width is watched, not measured once.
  useLayoutEffect(() => {
    const el = box.current!;
    const check = () => setWide(el.scrollWidth > el.clientWidth + 1);
    check();
    const watch = new ResizeObserver(check);
    watch.observe(el);
    watch.observe(el.firstElementChild!);
    return () => watch.disconnect();
  }, []);
  // Full screen is a layer (layer.ts): going back closes it.
  const layer = useLayer(full, () => setFull(false));
  const opener = useRef<HTMLButtonElement>(null);
  const shut = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!full) return;
    shut.current?.focus();
    const back = opener.current;
    return () => back?.focus();
  }, [full]);
  const open = () => {
    layer.show();
    setFull(true);
  };
  return (
    <div>
      <div ref={box} className={`table-box ${wide ? "pinned" : ""}`}>
        <table>{children}</table>
      </div>
      {wide && (
        <button ref={opener} className="mt-1.5 inline-flex min-h-8 items-center gap-1.5 font-ui text-[13px] text-ink2 underline decoration-ink3 underline-offset-[3px] cards:text-[13.5px] cards:font-medium cards:text-accent cards:no-underline" onClick={open}>
          <Icon name="expand" />Full screen
        </button>
      )}
      {full &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col bg-paper text-ink" role="dialog" aria-modal="true" aria-label="Table">
            <div className="flex min-h-13 items-center gap-2.5 border-b border-rule pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(1.25rem,env(safe-area-inset-left))]">
              <span className="hidden flex-1 items-center gap-2 text-[13px] text-ink2 portrait:flex">
                <span className="h-[26px] w-[18px] flex-none -rotate-30 rounded border-[1.3px] border-current" />Turn the phone sideways to see more
              </span>
              <span className="flex-1 portrait:hidden" />
              <button ref={shut} className="grid size-11 place-items-center text-xl cards:mr-1 cards:rounded-full cards:bg-wash cards:text-lg" onClick={layer.close} aria-label="Close">
                <Icon name="close" />
              </button>
            </div>
            <div className="prose-chat min-h-0 flex-1 overflow-auto pt-5 pr-[max(1.25rem,env(safe-area-inset-right))] pb-[max(1.25rem,env(safe-area-inset-bottom))] pl-[max(1.25rem,env(safe-area-inset-left))]">
              <div className="table-box pinned">
                <table>{children}</table>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// Each cell's content takes the width it needs, up to a readable line,
// and keeps the column's alignment (GFM's |:--:| and |--:|), which
// react-markdown gives as a style.
function Cell({ style, children }: { style?: React.CSSProperties; children: React.ReactNode }) {
  const align = style?.textAlign;
  const place = align === "right" ? { marginLeft: "auto" } : align === "center" ? { marginInline: "auto" } : {};
  return (
    <div className="cell" style={align ? { textAlign: align, ...place } : undefined}>
      {children}
    </div>
  );
}

export function Th({ node: _, children, ...rest }: Props<"th">) {
  return (
    <th {...rest}>
      <Cell style={rest.style}>{children}</Cell>
    </th>
  );
}

export function Td({ node: _, children, ...rest }: Props<"td">) {
  return (
    <td {...rest}>
      <Cell style={rest.style}>{children}</Cell>
    </td>
  );
}
