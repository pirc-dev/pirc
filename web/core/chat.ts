// How a chat shows: how its items group into runs, what its end holds,
// and a tool's time and diff.
import type { ChatItem, ToolItem } from "./view.ts";

// An item, or tool calls folded into one line.
export type Part = { item: ChatItem } | { tools: ToolItem[] };

export const partKey = (x: Part) => ("tools" in x ? x.tools[0].id : x.item.id);

// Tool calls one after another read as one log: they are kept together.
// Within it, two or more in a row that finished well fold into one line;
// one running or failed stays in sight. pi sends a message of its own
// before each call, mostly empty; one that shows nothing does not break
// the run.
export function runs(items: ChatItem[]): Part[][] {
  const out: Part[][] = [];
  let run: Part[] | undefined;
  let fine: ToolItem[] = [];
  const flush = () => {
    if (fine.length > 1) run?.push({ tools: fine });
    else for (const t of fine) run?.push({ item: t });
    fine = [];
  };
  for (const it of items) {
    if (run && blank(it)) continue;
    if (it.kind !== "tool") {
      flush();
      run = undefined;
      out.push([{ item: it }]);
      continue;
    }
    if (!run) {
      run = [];
      out.push(run);
    }
    if (it.result && !it.result.isError) fine.push(it);
    else {
      flush();
      run.push({ item: it });
    }
  }
  flush();
  return out;
}

// A reply with nothing to show: finished, no text or thought, no error,
// not stopped.
function blank(it: ChatItem): boolean {
  return it.kind === "assistant" && !it.streaming && !it.error && it.stop !== "aborted" && it.stop !== "error" && it.blocks.every((b) => !b.text.trim());
}

// What the end of the chat holds, to tell when more has come.
export function signature(it: ChatItem | undefined): string {
  if (!it) return "";
  if (it.kind === "assistant") return `${it.id}:${it.blocks.reduce((n, b) => n + b.text.length, 0)}:${it.streaming}`;
  if (it.kind === "tool") return `${it.id}:${Boolean(it.result)}`;
  return it.id;
}

// A duration, shortly: "0.4s", "12s", "2m 05s".
export function took(ms: number): string {
  if (ms < 10_000) return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

// A unified diff's lines that say something: the changes and the context
// around them, not the file headers.
export function diffLines(diff: string): { kind: "add" | "del" | "hunk" | "same"; text: string }[] {
  return diff.split("\n")
    .filter((l) => !/^(---|\+\+\+|Index:|={3,}|diff )/.test(l))
    .map((l) => ({ kind: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "same", text: l }));
}
