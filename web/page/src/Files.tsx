// A message's files: chips with each one's name and size. Only their names
// come back from pi, so they do not open.
import type { AttachmentView } from "../../core/view.ts";
import { Icon } from "./icons.tsx";

// A size in bytes for people: B, KB or MB, by 1024.
export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

export function FileChips(p: { files: Pick<AttachmentView, "name" | "size">[]; onRemove?: (i: number) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {p.files.map((f, i) => (
        <span key={i} className="inline-flex h-9 max-w-full min-w-0 items-center gap-1.5 rounded-lg bg-wash2 pr-1 pl-2.5 text-[13.5px] leading-none whitespace-nowrap text-ink cards:rounded-[10px] cockpit:rounded-md cockpit:font-mono cockpit:text-[12.5px]" title={f.name}>
          <Icon name="file" className="size-4 text-ink2" />
          <span className="min-w-0 truncate">{f.name}</span>
          <span className="flex-none pr-1.5 text-ink2 tabular-nums">{size(f.size)}</span>
          {p.onRemove && (
            <button className="-my-1 grid size-7 flex-none place-items-center rounded-full text-[13px] text-ink2 hover:bg-wash hover:text-ink" aria-label={`Remove ${f.name}`} onClick={() => p.onRemove!(i)}>
              <Icon name="close" />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
