// A question pi is asking in its terminal for an extension (core/view.ts,
// QuestionView), in the composer's place while it waits (docs/design.md,
// section 8): "pi asks", "Dismiss and stop", the question with its text kept as
// written (asked.ts), then the answer. A confirm's No and Yes and a
// select's options go with a note for pi, if one is written, which pi
// reads with what follows from the answer; an input's own text is the
// answer. "Dismiss and stop" closes the question and stops the turn. The terminal can
// still answer it; whichever answers first wins, and the composer comes
// back once it is gone. An editor or a custom dialog can be answered only
// in pi's terminal: it says so, with where pi runs, and Stop, which ends
// the turn but leaves the dialog open there.
import { useEffect, useRef, useState } from "react";
import type { QuestionView, SessionView } from "../../core/view.ts";
import { parts, type Part } from "./asked.ts";
import type { Run } from "./chat.ts";
import { where } from "./names.ts";

// An answer is tinted with the accent: a grey fill is what a button that
// cannot be pressed has (Composer.tsx's Send), and an outline what the note
// field has, so either would read as something else. In Cards, whose
// buttons are tinted, its own light tint.
const choice = "min-h-12 w-full rounded-[13px] bg-accent-soft px-4 text-[15.5px] font-semibold text-ink disabled:opacity-40 hover:bg-accent/25 cards:bg-wash cards:hover:bg-wash2 native:rounded-xl cockpit:rounded-[10px] cockpit:font-ui";
const primary = "min-h-12 w-full rounded-[13px] bg-accent px-4 text-[15.5px] font-semibold text-on-accent disabled:opacity-40 native:rounded-xl cockpit:rounded-[10px] cockpit:font-ui";
const field = "w-full min-w-0 rounded-[14px] border border-rule bg-paper px-3 py-2.5 text-base text-ink outline-none placeholder:text-ink3 focus:border-accent cards:bg-card native:rounded-xl cockpit:rounded-[10px] cockpit:text-[15px] touch:text-base!";

export function Ask(p: { q: QuestionView; more: number; session: SessionView; run: Run }) {
  const q = p.q;
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const answer = async (body: { option?: number; confirmed?: boolean; text?: string; dismissed?: boolean }) => {
    setSending(true);
    try {
      const noted = note.trim() && (body.option !== undefined || body.confirmed !== undefined) ? { note: note.trim() } : {};
      await p.run("answer", { questionId: q.id, ...body, ...noted });
    } finally {
      setSending(false);
    }
  };
  // In the composer's place, it took the focus with it: the question has
  // it then, so that a screen reader reads it and the keys typed next are
  // not the page's (j, k, n: keys.ts).
  const self = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!document.activeElement || document.activeElement === document.body) self.current?.focus({ preventScroll: true });
  }, []);
  const [first = "", ...rest] = q.title.split("\n");
  const body = parts([rest.join("\n"), q.message ?? ""].filter((s) => s.trim()).join("\n\n"));
  const noteField = (
    <>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add a note for pi"
        aria-label="A note for pi"
        enterKeyHint="done"
        className={field}
      />
      {note.trim() && <p className="-mt-1 text-[12.5px] text-ink3">pi gets the note with your answer.</p>}
    </>
  );
  return (
    <section ref={self} tabIndex={-1} data-own-keys className="flex flex-col gap-2.5 outline-none" aria-label="pi asks" role="group">
      <div className="flex min-h-8 items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold tracking-[0.04em] text-accent uppercase cockpit:font-mono cockpit:tracking-normal">
          <span className="size-[7px] rounded-full bg-current" aria-hidden="true" />
          {q.answerable ? "pi asks" : "pi asks in its terminal"}
        </span>
        {p.more > 0 && <span className="text-[12.5px] text-ink3">{p.more} more after this one</span>}
        {q.answerable && (
          <button className="-my-1.5 ml-auto min-h-11 px-1 text-[14px] font-medium text-ink2 hover:text-ink disabled:opacity-40" disabled={sending} onClick={() => void answer({ dismissed: true })}>
            Dismiss and stop
          </button>
        )}
      </div>
      <div className="flex max-h-[45vh] flex-col gap-1.5 overflow-y-auto [overflow-wrap:anywhere]">
        <p className="text-[16px] font-semibold text-ink">{first || (q.answerable ? "pi asks" : "A dialog in pi's terminal")}</p>
        <Body parts={body} />
      </div>
      {!q.answerable && (
        <>
          <div className="flex flex-col gap-0.5 text-[14px] text-ink2">
            <p>Only pi's terminal can answer this. Once it does, the box to write in comes back here.</p>
            <p className="text-[12.5px] text-ink3">{[where(p.session), p.session.cwd].filter(Boolean).join(" · ")}</p>
          </div>
          <button className="inline-flex h-9 items-center gap-2 self-start rounded-full px-3.5 text-sm font-semibold text-block ring-1 ring-block ring-inset cards:bg-block-wash cards:ring-0 native:rounded-xl cockpit:rounded-[10px] cockpit:bg-block-wash cockpit:font-ui" onClick={() => void p.run("abort", {})}>
            <span className="size-[9px] rounded-[1.5px] bg-current" aria-hidden="true" />Stop
          </button>
          <p className="-mt-1 text-[12.5px] text-ink3">Stop ends pi's turn; the dialog stays in the terminal until it is answered there.</p>
        </>
      )}
      {q.answerable && q.kind === "confirm" && (
        <>
          {noteField}
          <div className="grid grid-cols-2 gap-2">
            <button className={choice} disabled={sending} onClick={() => void answer({ confirmed: false })}>No</button>
            <button className={primary} disabled={sending} onClick={() => void answer({ confirmed: true })}>Yes</button>
          </div>
        </>
      )}
      {q.answerable && q.kind === "select" && (
        <>
          <div className="flex max-h-[35vh] flex-col gap-2 overflow-y-auto">
            {(q.options ?? []).map((o, i) => (
              <button key={i} className={`${choice} flex items-center py-2.5 text-left font-medium [overflow-wrap:anywhere]`} disabled={sending} onClick={() => void answer({ option: i })}>
                <span className="mr-2.5 text-ink3 tabular-nums">{i + 1}</span>{o}
              </button>
            ))}
          </div>
          {noteField}
        </>
      )}
      {q.answerable && q.kind === "input" && (
        <form className="flex flex-col gap-2" onSubmit={(e) => {
          e.preventDefault();
          if (!sending) void answer({ text });
        }}>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label={first || "Answer"}
            placeholder={q.placeholder}
            // Often a name or a path, as the app's: no capital to undo.
            autoCapitalize="off"
            enterKeyHint="send"
            className={field}
          />
          <button className={primary} disabled={sending}>Send</button>
        </form>
      )}
    </section>
  );
}

// The question's text in its parts: label and value pairs together, code
// as code, the rest as written.
function Body(p: { parts: Part[] }) {
  const out: React.ReactNode[] = [];
  for (let i = 0; i < p.parts.length; i++) {
    const x = p.parts[i];
    if (x.kind === "field") {
      const fields: { label: string; value: string }[] = [];
      while (i < p.parts.length && p.parts[i].kind === "field") fields.push(p.parts[i++] as { label: string; value: string });
      i--;
      out.push(
        <dl key={i} className="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 text-[14px]">
          {fields.map((f, j) => [<dt key={`t${j}`} className="text-ink3">{f.label}</dt>, <dd key={`d${j}`} className="min-w-0 text-ink">{f.value}</dd>])}
        </dl>,
      );
    } else if (x.kind === "label") {
      out.push(<p key={i} className="text-[13px] text-ink3">{x.label}</p>);
    } else if (x.kind === "code") {
      out.push(<pre key={i} className="overflow-x-auto rounded-[10px] bg-wash px-3 py-2 font-mono text-[12.5px] leading-[1.45] whitespace-pre text-ink [overflow-wrap:normal] cockpit:rounded-md">{x.text}</pre>);
    } else {
      out.push(<p key={i} className="text-[14.5px] whitespace-pre-wrap text-ink2">{x.text}</p>);
    }
  }
  return <>{out}</>;
}
