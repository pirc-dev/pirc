// A tool call and its result, and tool calls folded into one line.
import { memo } from "react";
import type { ToolItem } from "../../core/view.ts";
import { Icon } from "./icons.tsx";
import { useNow } from "./time.ts";
import { diffLines, took } from "../../core/chat.ts";

// A tool's time shows once it is a second or more: a quick tool's is noise.
const SHOWN_MS = 1000;

// How long a running tool has run, by the host's clock.
function Running(p: { since: number }) {
  const now = useNow(1000);
  const ms = now - p.since;
  return ms >= SHOWN_MS ? <span className="flex-none text-ink3 tabular-nums">{took(ms)}</span> : null;
}

const LINE = { add: "bg-done-wash text-done", del: "bg-block-wash text-block", hunk: "text-ink3", same: "text-ink2" } as const;

function Diff(p: { diff: string }) {
  return (
    <pre className="max-h-96 overflow-auto leading-[1.55]">
      {/* As wide as the widest line, so that each line's colour spans it. */}
      <div className="inline-block min-w-full">
        {diffLines(p.diff).map((l, i) => <div key={i} className={`px-1 whitespace-pre ${LINE[l.kind]}`}>{l.text || " "}</div>)}
      </div>
    </pre>
  );
}

// A one-line summary of a tool call's arguments.
function summary(t: ToolItem): string {
  try {
    const a = JSON.parse(t.args) as Record<string, unknown>;
    const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url ?? Object.values(a).find((x) => typeof x === "string");
    return typeof v === "string" ? v : "";
  } catch {
    return t.args;
  }
}

// A tool call's arguments as lines of name and value, the names lined up;
// anything nested, as indented JSON.
function argLines(t: ToolItem): string {
  try {
    const a = JSON.parse(t.args) as unknown;
    if (!a || typeof a !== "object" || Array.isArray(a)) return JSON.stringify(a, null, 2);
    const entries = Object.entries(a);
    if (entries.some(([, v]) => v !== null && typeof v === "object")) return JSON.stringify(a, null, 2);
    const width = Math.max(...entries.map(([k]) => k.length));
    return entries.map(([k, v]) => `${k.padEnd(width)}  ${String(v)}`).join("\n");
  } catch {
    return t.args;
  }
}

// A tool call as a line of a log; it opens to its arguments and output,
// and is open while it runs and shows output. In Triage, a small card.
export function Tool(p: { item: ToolItem }) {
  const t = p.item;
  const running = !t.result;
  const r = t.result;
  const out = r?.text ?? t.progress ?? "";
  // An edit shows its changes; its output says only that it was made.
  const diff = r?.diff && !r.isError ? r.diff : undefined;
  const label = "font-ui text-[10.5px] font-semibold tracking-[0.14em] text-ink3 uppercase";
  const pre = "max-h-96 overflow-auto whitespace-pre leading-[1.55]";
  return (
    <details open={running && Boolean(t.progress)} className={`font-mono text-[12.5px] cards:overflow-hidden cards:rounded-xl cards:border cards:bg-card native:bg-paper cockpit:overflow-hidden cockpit:rounded-lg cockpit:border ${t.result?.isError ? "cards:border-block cockpit:border-block" : "cards:border-rule native:border-transparent cockpit:border-rule"}`}>
      <summary className="flex min-h-[30px] cursor-pointer list-none items-baseline gap-2.5 py-1 [&::-webkit-details-marker]:hidden cards:min-h-10 cards:items-center cards:gap-2 cards:px-3 cockpit:min-h-9 cockpit:items-center cockpit:gap-2 cockpit:px-2.5">
        <span className={`w-3 flex-none text-center font-semibold ${t.result?.isError ? "text-block" : running ? "animate-pulse text-work" : "text-done"}`}>{t.result?.isError ? "✕" : running ? "●" : "✓"}</span>
        <span className="flex-none font-semibold text-ink cards:font-ui cards:text-sm cockpit:font-bold">{t.name || "tool"}</span>
        <span className="min-w-0 flex-1 truncate text-ink2">{summary(t)}</span>
        {r?.exitCode !== undefined && r.exitCode !== 0 && <span className="flex-none font-semibold text-block">exit {r.exitCode}</span>}
        {running ? <Running since={t.at} /> : r?.durationMs !== undefined && r.durationMs >= SHOWN_MS && <span className="flex-none text-ink3 tabular-nums">{took(r.durationMs)}</span>}
      </summary>
      <div className="mt-0.5 mb-2 ml-1.5 flex flex-col gap-1.5 border-l border-rule py-1 pl-4 cards:m-0 cards:border-t cards:border-l-0 cards:bg-wash cards:px-3 cards:py-2 native:border-t-0 native:bg-transparent native:pt-0 cockpit:m-0 cockpit:border-t cockpit:border-l-0 cockpit:bg-card cockpit:px-2.5 cockpit:py-2">
        {diff
          ? (
            <>
              <span className={label}>Changes</span>
              <Diff diff={diff} />
            </>
          )
          : (
            <>
              <span className={label}>Arguments</span>
              <pre className={`${pre} text-ink2`}>{argLines(t)}</pre>
            </>
          )}
        {out && !diff && <span className={label}>{running ? "Output so far" : "Output"}</span>}
        {out && !diff && <pre className={`${pre} ${t.result?.isError ? "text-block" : "text-ink2"}`}>{out.length > 20000 ? `${out.slice(0, 20000)}\n…` : out}</pre>}
      </div>
    </details>
  );
}

// Tool calls one after another, all finished well: one line, "✓ 3 tools:
// grep, read, edit", that opens to them.
export const Folded = memo(function Folded(p: { tools: ToolItem[] }) {
  return (
    <details className="group">
      <summary className="flex min-h-[30px] cursor-pointer list-none items-baseline gap-2.5 py-1 font-mono text-[12.5px] text-ink2 [&::-webkit-details-marker]:hidden cards:items-center cards:gap-1.5 cards:font-ui cards:text-[13px] cards:text-ink3">
        <span className="w-3 flex-none text-center font-semibold text-done">✓</span>
        <span className="min-w-0 truncate"><span className="font-semibold text-ink cards:font-normal cards:text-ink3">{p.tools.length} tools</span> {p.tools.map((t) => t.name || "tool").join(", ")}</span>
        <Icon name="chevron" className="size-3 self-center transition-transform group-open:rotate-90" />
      </summary>
      <div className="ml-1.5 flex flex-col border-l border-rule pl-3 cards:mt-1.5 cards:ml-0 cards:gap-1.5 cards:border-l-0 cards:pl-0 cockpit:mt-1.5 cockpit:ml-0 cockpit:gap-1.5 cockpit:border-l-0 cockpit:pl-0">{p.tools.map((t) => <Tool key={t.id} item={t} />)}</div>
    </details>
  );
}, (a, b) => a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i]));
