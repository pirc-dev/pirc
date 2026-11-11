// A code block's file, from what follows its opening fence, so that it can
// be shown above the code: ```ts src/a.ts, ```ts title="src/a.ts" (or
// file=, filename=), ```ts:src/a.ts, or a fence naming the file alone,
// ```src/a.ts, whose language is then its extension.

export interface Fence {
  lang?: string;
  file?: string;
}

// Something that reads as a file: with a folder, or a name and an
// extension ("sync.sh"), not a version or a number ("1.2").
const PATH = /^(?:[^\s"'=]*\/[^\s"'=]+|[\w-]*[A-Za-z][\w-]*\.[A-Za-z][\w]{0,7})$/;

export function fence(lang: string | null | undefined, meta: string | null | undefined): Fence {
  let l = lang ?? undefined;
  let file: string | undefined;
  const colon = l?.indexOf(":") ?? -1;
  if (l && colon > 0 && PATH.test(l.slice(colon + 1))) {
    file = l.slice(colon + 1);
    l = l.slice(0, colon);
  } else if (l && PATH.test(l)) {
    file = l;
    l = /\.([A-Za-z]\w*)$/.exec(l)?.[1]?.toLowerCase();
  }
  if (!file && meta) {
    const named = /(?:^|\s)(?:title|file|filename)=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(meta);
    const first = meta.trim().split(/\s+/)[0];
    file = named ? (named[1] ?? named[2] ?? named[3]) : PATH.test(first) && !first.startsWith("//") && !first.includes("://") ? first : undefined;
  }
  return { ...(l ? { lang: l } : {}), ...(file ? { file } : {}) };
}

interface Node {
  type: string;
  lang?: string | null;
  meta?: string | null;
  data?: { hProperties?: Record<string, unknown> };
  children?: Node[];
}

// A remark plugin: each code block's language as the highlighter needs it,
// and its file, if named, as data-file on its <code>.
export function remarkFence() {
  const walk = (n: Node) => {
    if (n.type === "code") {
      const f = fence(n.lang, n.meta);
      n.lang = f.lang ?? null;
      if (f.file) n.data = { ...n.data, hProperties: { ...n.data?.hProperties, "data-file": f.file } };
    }
    n.children?.forEach(walk);
  };
  return walk;
}
