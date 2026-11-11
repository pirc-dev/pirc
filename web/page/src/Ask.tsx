// A question pi is asking in its terminal for an extension (core/view.ts,
// QuestionView), above the composer: a select's options, a confirm's yes
// and no, an input's box, each with Dismiss, as Escape in the terminal.
// The terminal can still answer it; whichever answers first wins. An
// editor or a custom dialog is only said to be waiting there.
import { useState } from "react";
import type { QuestionView } from "../../core/view.ts";
import type { Run } from "./chat.ts";

const choice = "min-h-11 rounded-full px-4 text-[15px] font-semibold ring-1 ring-rule ring-inset text-ink disabled:opacity-40 hover:bg-wash cards:rounded-[12px] cards:bg-card native:rounded-xl cockpit:rounded-[10px] cockpit:font-ui";
const primary = "min-h-11 rounded-full px-4 text-[15px] font-semibold bg-ink text-paper disabled:opacity-40 cards:rounded-[12px] cards:bg-accent cards:text-on-accent native:rounded-xl cockpit:rounded-[10px] cockpit:bg-accent cockpit:text-on-accent cockpit:font-ui";

export function Ask(p: { q: QuestionView; more: number; run: Run }) {
  const q = p.q;
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const answer = async (body: { option?: number; confirmed?: boolean; text?: string; dismissed?: boolean }) => {
    setSending(true);
    try {
      await p.run("answer", { questionId: q.id, ...body });
    } finally {
      setSending(false);
    }
  };
  const lines = q.title.split("\n");
  return (
    <section className="flex flex-col gap-2.5 rounded-2xl bg-block-wash px-3.5 py-3 cockpit:rounded-lg" aria-label="pi asks" role="group">
      <div className="flex items-baseline gap-2.5">
        <span className="w-4 flex-none text-center font-mono font-semibold text-block" aria-hidden="true">×</span>
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <p className="text-[15px] font-semibold text-ink">{lines[0] || (q.answerable ? "pi asks" : "A dialog in pi's terminal")}</p>
          {lines.slice(1).concat(q.message ? q.message.split("\n") : []).map((l, i) => <p key={i} className="text-[14.5px] text-ink2">{l}</p>)}
          {!q.answerable && <p className="text-[13.5px] text-ink3">Waiting in pi's terminal; it can be answered only there.</p>}
          {p.more > 0 && <p className="text-[13.5px] text-ink3">{p.more} more after this one</p>}
        </div>
      </div>
      {q.answerable && q.kind === "select" && (
        <div className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
          {(q.options ?? []).map((o, i) => (
            <button key={i} className={`${choice} py-2 text-left font-medium [overflow-wrap:anywhere]`} disabled={sending} onClick={() => void answer({ option: i })}>{o}</button>
          ))}
        </div>
      )}
      {q.answerable && q.kind === "confirm" && (
        <div className="flex gap-2">
          <button className={primary} disabled={sending} onClick={() => void answer({ confirmed: true })}>Yes</button>
          <button className={choice} disabled={sending} onClick={() => void answer({ confirmed: false })}>No</button>
        </div>
      )}
      {q.answerable && q.kind === "input" && (
        <form className="flex gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (!sending) void answer({ text });
        }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={lines[0] || "Answer"}
            placeholder={q.placeholder}
            enterKeyHint="send"
            className="min-w-0 flex-1 rounded-xl border border-rule bg-paper px-3 text-[15px] text-ink outline-none placeholder:text-ink3 focus:border-accent cards:bg-card"
          />
          <button className={primary} disabled={sending}>Send</button>
        </form>
      )}
      {q.answerable && (
        <button className="self-start px-1 text-[14px] text-ink2 underline-offset-4 hover:underline disabled:opacity-40" disabled={sending} onClick={() => void answer({ dismissed: true })}>Dismiss</button>
      )}
    </section>
  );
}
