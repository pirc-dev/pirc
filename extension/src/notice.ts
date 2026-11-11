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
  const text = (r?.content ?? []).flatMap((c) => (c.type === "text" ? [c.text] : [])).join(" ");
  return create(NoticeSchema, { number, kind: NoticeKind.FINISHED, text: noticeText(text) });
}

export function questionNotice(q: Question, number: bigint): Notice {
  return create(NoticeSchema, { number, kind: NoticeKind.QUESTION, text: noticeText([q.title, q.message].join(" ")) });
}
