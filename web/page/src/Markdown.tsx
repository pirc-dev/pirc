// Replies as Markdown: GitHub's flavour, tables in the app's own style,
// and code blocks, highlighted when the reply names their language, each
// with its file when the reply names one (fence.ts), and Copy. The
// highlighter is a third of the page's size again, so it is fetched when
// the first code block shows, and blocks are highlighted once it has come.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./Copy.tsx";
import { remarkFence } from "./fence.ts";
import { Table, Td, Th } from "./Table.tsx";

let highlighting: NonNullable<Options["rehypePlugins"]> = [];
let fetching = false;
const waiting = new Set<() => void>();
function fetchHighlighter(): void {
  if (fetching) return;
  fetching = true;
  import("rehype-highlight").then((m) => {
    // Only a block that names its language: guessing one is slow, and
    // often wrong for a short block.
    highlighting = [[m.default, { detect: false }]];
    for (const l of waiting) l();
  }, () => {
    // Not highlighted, then; the next page load tries again.
  });
}
const subscribe = (l: () => void) => {
  waiting.add(l);
  return () => waiting.delete(l);
};

// The options for react-markdown, with the highlighter once it is here.
export function useMarkdown() {
  const rehypePlugins = useSyncExternalStore(subscribe, () => highlighting);
  return { ...MARKDOWN, rehypePlugins };
}

// Links in what a host sends open in a new tab, so that one cannot take
// the app itself somewhere else. Tables scroll on a narrow screen.
const MARKDOWN = {
  remarkPlugins: [remarkGfm, remarkFence],
  components: {
    a: (p: React.ComponentProps<"a">) => <a href={p.href} target="_blank" rel="noopener noreferrer">{p.children}</a>,
    table: Table,
    th: Th,
    td: Td,
    pre: Code,
  },
};

// A code block, edge to edge, with its language and its file when the
// reply names them, and Copy, which copies the code as written.
function Code(p: React.ComponentProps<"pre"> & { node?: unknown }) {
  const { node: _, children, ...rest } = p;
  const pre = useRef<HTMLPreElement>(null);
  useEffect(fetchHighlighter, []);
  const child = Array.isArray(children) ? children[0] : children;
  const props = (child as { props?: { className?: string; "data-file"?: string } } | undefined)?.props;
  const lang = /language-(\S+)/.exec(props?.className ?? "")?.[1];
  const file = props?.["data-file"];
  return (
    <div className="code">
      <div className="flex items-center gap-3 px-5 pt-1 cards:px-3 cockpit:px-3">
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {lang && <span className="flex-none text-[11px] font-semibold tracking-[0.1em] text-ink2 uppercase native:text-accent native:normal-case native:tracking-normal native:text-xs cockpit:font-mono cockpit:font-normal cockpit:tracking-normal cockpit:text-ink3 cockpit:normal-case">{lang}</span>}
          {/* A long path loses its start, so that the file's name shows. */}
          {file && <span className="min-w-0 truncate font-mono text-xs text-ink2 [direction:rtl] cards:text-ink3 native:text-ink2 cockpit:text-ink2" title={file}><bdi>{file}</bdi></span>}
        </span>
        <CopyButton text={() => pre.current?.textContent ?? ""} label="Copy code" />
      </div>
      <pre ref={pre} {...rest}>{children}</pre>
    </div>
  );
}
