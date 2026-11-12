// What a session raises that is worth a notification (docs/design.md,
// section 12, step 13): a turn that ended, not by an abort; a turn that
// failed; a question. The rules are the web app's server's before the
// notice moved here (docs/web.md, section 6).
import { create } from "@bufbuild/protobuf";
import { NoticeKind, NoticeSchema, type Notice, type Question } from "@pirc/protocol";

import type { AgentMessage } from "./convert.ts";

// How much of the reply, the error or the question a notice carries, in
// Unicode code points.
export const NOTICE_CHARS = 120;

// How much of a reply plainText reads: far more than a notice keeps, and
// few enough that no line is long enough to make its patterns slow.
const PLAIN_CHARS = 2000;

// Markdown as the text it reads as, for a notification, which shows no
// markup: the marks of headings, quotes, lists, rules and tables dropped, a
// link and an image as their text, emphasis and code without their marks,
// and a heading followed by a colon unless it ends in punctuation. Code
// spans and fenced blocks keep what is inside them. Only the first
// PLAIN_CHARS are read.
export function plainText(md: string): string {
  let head = md.slice(0, PLAIN_CHARS);
  if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of head.split("\n")) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (f && f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length)) fence = undefined;
      else lines.push(line);
      continue;
    }
    if (f) {
      fence = f;
      continue;
    }
    // Rules, a table's separator and a heading's underline.
    if (/^\s*([-*_]\s*){3,}$/.test(line) || /^\s*=+\s*$/.test(line)) continue;
    if (/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) continue;
    let l = line.replace(/^(\s*>)+\s?/, "");
    const heading = /^\s{0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/.exec(l);
    if (heading) {
      const h = inline(heading[1]).trim();
      lines.push(h && !/[.:!?…]$/.test(h) ? `${h}:` : h);
      continue;
    }
    l = l.replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "");
    if (/^\s*\|.*\|\s*$/.test(l)) {
      l = l.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim()).join(" · ");
    }
    lines.push(inline(l));
  }
  return lines.join("\n");
}

// One line's inline Markdown as text. Escaped marks, then code spans, are
// held aside as private-use characters while the marks around them go, then
// put back: an escaped mark as itself, a code span as what is inside it.
function inline(s: string): string {
  const spans: string[] = [];
  return s
    .replace(/\\([\\`*_{}\[\]()#+\-.!|~>])/g, (_, c: string) => String.fromCharCode(0xe000 + c.charCodeAt(0)))
    .replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => {
      spans.push(code.trim() ? code.trim() : code);
      return String.fromCharCode(0xe100 + spans.length - 1);
    })
    .replace(/!\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/<((https?|mailto):[^>\s]+)>/g, "$1")
    // Not inside a word or a path, so that src/**/*.ts and snake_case stay.
    .replace(/(^|[^\w/])(\*\*|__)(?=\S)(.+?)(?<=\S)\2(?![\w/])/g, "$1$3")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(^|[^\w*/])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*/])/g, "$1$2")
    .replace(/(^|[^\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, "$1$2")
    .replace(/[-]/g, (c) => spans[c.charCodeAt(0) - 0xe100] ?? c)
    .replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xe000));
}

// Runs of whitespace made one space, then cut to NOTICE_CHARS code points,
// "…" included when cut.
export function noticeText(s: string): string {
  const points = [...s.replace(/\s+/g, " ").trim()];
  if (points.length <= NOTICE_CHARS) return points.join("");
  return `${points.slice(0, NOTICE_CHARS - 1).join("").trimEnd()}…`;
}

// The number after `last`: now, or one past the last if the clock went back.
export function nextNumber(last: bigint | undefined, now = Date.now()): bigint {
  const n = BigInt(now);
  return last !== undefined && n <= last ? last + 1n : n;
}

// The notice for a turn that ended with `reply` its last assistant message,
// if any; none for an abort.
export function turnNotice(reply: AgentMessage | undefined, number: bigint): Notice | undefined {
  const r = reply?.role === "assistant" ? reply : undefined;
  if (r?.stopReason === "aborted") return undefined;
  if (r?.stopReason === "error") return create(NoticeSchema, { number, kind: NoticeKind.FAILED, text: noticeText(r.errorMessage ?? "") });
  const text = (r?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  return create(NoticeSchema, { number, kind: NoticeKind.FINISHED, text: noticeText(plainText(text)) });
}

export function questionNotice(q: Question, number: bigint): Notice {
  return create(NoticeSchema, { number, kind: NoticeKind.QUESTION, text: noticeText(plainText([q.title, q.message].join("\n"))) });
}
