// A message's images (docs/web.md, section 6): thumbnails that open full
// screen.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ImageView } from "../../core/view.ts";
import { Icon } from "./icons.tsx";
import { useLayer } from "./layer.ts";

// A message's images in a row; each opens full screen. One the server no
// longer keeps, or that was never sent in full, is a placeholder.
export function Thumbs(p: { images: (ImageView & { url?: string })[]; onRemove?: (i: number) => void }) {
  const [open, setOpen] = useState<string>();
  const layer = useLayer(open !== undefined, () => setOpen(undefined));
  return (
    <div className="flex flex-wrap gap-1.5">
      {p.images.map((im, i) => {
        const url = im.url ?? (im.key ? `/api/images/${encodeURIComponent(im.key)}` : undefined);
        return (
          <span key={i} className="relative">
            <Thumb url={url} open={(u) => {
              layer.show();
              setOpen(u);
            }} />
            {p.onRemove && (
              <button className="absolute -top-2 -right-2 grid size-6 place-items-center rounded-full bg-ink text-[13px] text-paper ring-2 ring-paper" aria-label="Remove image" onClick={() => p.onRemove!(i)}>
                <Icon name="close" />
              </button>
            )}
          </span>
        );
      })}
      {open && <Viewer url={open} close={layer.close} />}
    </div>
  );
}

function Thumb(p: { url: string | undefined; open: (url: string) => void }) {
  const [broken, setBroken] = useState(false);
  if (!p.url || broken) {
    return <span className="grid h-16 min-w-16 place-items-center rounded-lg bg-wash2 px-2 text-[12.5px] text-ink2">Image</span>;
  }
  return (
    <button
      className="block overflow-hidden rounded-lg"
      aria-label="Open image"
      onClick={(e) => {
        // Not the message's own offer to go back or fork.
        e.stopPropagation();
        p.open(p.url!);
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <img src={p.url} alt="" className="block h-24 max-w-48 object-cover" onError={() => setBroken(true)} />
    </button>
  );
}

function Viewer(p: { url: string; close: () => void }) {
  const shut = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    shut.current?.focus();
    return () => back?.focus();
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Image" onClick={p.close}>
      <div className="flex justify-end pt-[env(safe-area-inset-top)] pr-[max(0.5rem,env(safe-area-inset-right))]">
        <button ref={shut} className="grid size-11 place-items-center text-xl text-white" onClick={p.close} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <img src={p.url} alt="" className="min-h-0 flex-1 object-contain pb-[env(safe-area-inset-bottom)]" onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  );
}
