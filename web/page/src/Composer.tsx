// Where a message is written and sent, with Stop and how long the turn
// has taken.
import { useEffect, useRef, useState } from "react";
import type { SessionView } from "../../core/view.ts";
import { useNow } from "./time.ts";
import { type Run } from "./chat.ts";
import { Ask } from "./Ask.tsx";
import { Icon } from "./icons.tsx";
import { type Attachment, shrink } from "./attach.ts";
import { Thumbs } from "./Images.tsx";
import { useKeyboard, useKeys } from "./keys.ts";
import { live } from "./live.ts";
import { IMAGES_MAX } from "../../core/api.ts";

// How long the turn has run, by the host's clock.
// What pi is doing and for how long. On a phone's width "Working" goes,
// the sign before it and the time saying as much.
function Status(p: { since: number | undefined; compacting: boolean }) {
  const now = useNow(1000);
  const s = p.since === undefined ? -1 : Math.floor((now - p.since) / 1000);
  const elapsed = s < 0 || s > 24 * 3600 ? undefined : s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className={elapsed && !p.compacting ? "hidden @[24rem]:inline" : undefined}>{p.compacting ? "Compacting" : "Working"}{elapsed && " · "}</span>
      {elapsed}
    </span>
  );
}

// Whether the session's model is known not to take images, asked of pi
// once images are attached, and again when the model changes.
function useBlind(s: SessionView, attached: boolean): boolean {
  const [blind, setBlind] = useState(false);
  const model = s.model && `${s.model.provider}/${s.model.id}`;
  useEffect(() => {
    setBlind(false);
    if (!attached || !model) return;
    let current = true;
    // Quietly: sending works without it.
    void live.command(s.id, "models", {}).then((r) => {
      if (!current || !r.ok || r.result.kind !== "models") return;
      const m = r.result.current;
      if (m && `${m.model.provider}/${m.model.id}` === model) setBlind(!m.images);
    }, () => {});
    return () => {
      current = false;
    };
  }, [s.id, model, attached]);
  return blind;
}

// The composer. Idle, the message and Send. While pi works: Stop on its
// own line, by how long the turn has run and away from the send button; a
// small switch on that line choosing whether the message waits for the
// turn to end (Queue, the default) or interrupts it (Steer); and
// one send button that says which. Images come with the button beside
// the box, or pasted or dropped anywhere on the page. Cmd/Ctrl+Enter sends
// as the button would; so does Enter where there is a mouse or trackpad, taken as a sign
// of a hardware keyboard (keys.ts), Shift+Enter there making a new line. On a touch
// screen Enter is the keyboard's return key, a new line. With the keys on,
// Esc leaves the box, and a second stops pi (Chat.tsx).
export function Composer(p: {
  session: SessionView;
  run: Run;
  text: string;
  setText: (t: string) => void;
  images: Attachment[];
  setImages: (f: (was: Attachment[]) => Attachment[]) => void;
  ready: boolean;
  since: number | undefined;
  turn: string | undefined;
  send: (delivery?: "steer" | "followUp") => void;
}) {
  const { text, setText } = p;
  const area = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"followUp" | "steer">("followUp");
  const keyboard = useKeyboard();
  const keys = useKeys();
  const busy = p.session.working || p.session.compacting;
  const send = () => p.send(busy ? mode : undefined);
  // Each turn starts on Queue: a Steer chosen for the last one is not kept,
  // also when a queued message starts the next without pi going idle.
  useEffect(() => {
    setMode("followUp");
  }, [busy, p.turn]);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);
  const empty = (!text.trim() && p.images.length === 0) || !p.ready;
  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const add = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setProblem(undefined);
    const room = IMAGES_MAX - p.images.length;
    if (images.length > room) setProblem(`At most ${IMAGES_MAX} images in a message.`);
    for (const f of images.slice(0, Math.max(0, room))) {
      try {
        const a = await shrink(f);
        p.setImages((was) => (was.length < IMAGES_MAX ? [...was, a] : was));
      } catch (e) {
        setProblem((e as Error).message);
      }
    }
  };
  const adding = useRef(add);
  adding.current = add;
  // Dropped anywhere on the page, rather than opened by the browser in
  // place of it.
  useEffect(() => {
    const files = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const over = (e: DragEvent) => {
      if (files(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      void adding.current([...e.dataTransfer!.files]);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
  const blind = useBlind(p.session, p.images.length > 0);
  // Small, on the working line: a choice that sends nothing, so it may sit
  // near Stop; its title says what each side does.
  const switcher = (
    <div className="ml-auto flex flex-none rounded-full bg-wash p-[2px] text-[12.5px] cards:rounded-[9px] cockpit:rounded-lg cockpit:bg-card cockpit:font-ui" role="group" aria-label="When pi gets the message">
      {([["followUp", "Queue", "Send after this turn"], ["steer", "Steer", "Interrupt pi now"]] as const).map(([m, label, title]) => (
        <button
          key={m}
          className="h-7 rounded-full px-2.5 text-ink2 aria-pressed:bg-paper aria-pressed:font-semibold aria-pressed:text-ink aria-pressed:ring-1 aria-pressed:ring-ink3 cards:rounded-[7px] cards:aria-pressed:bg-card cards:aria-pressed:shadow-card cards:aria-pressed:ring-wash2 native:aria-pressed:bg-sheet-card cockpit:rounded-md cockpit:aria-pressed:ring-accent"
          onClick={() => setMode(m)}
          aria-pressed={mode === m}
          title={title}
        >
          {label}
        </button>
      ))}
    </div>
  );
  return (
    <div className="flex-none border-t border-rule bg-paper px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] cards:bg-card cards:px-3 native:bg-paper cockpit:px-3">
      <div className="@container mx-auto flex max-w-[40rem] flex-col gap-2.5">
        {p.session.questions?.[0] && <Ask key={p.session.questions[0].id} q={p.session.questions[0]} more={p.session.questions.length - 1} run={p.run} />}
        {busy && (
          <div className="flex items-center gap-2.5 text-[13.5px] text-ink2 cockpit:font-mono cockpit:text-xs">
            <span className="w-4 text-center font-mono font-semibold text-work" aria-hidden="true">◐</span>
            <Status since={p.since} compacting={Boolean(p.session.compacting)} />
            {switcher}
            <button className="ml-1.5 inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-semibold text-block ring-1 ring-block ring-inset cards:bg-block-wash cards:ring-0 native:rounded-xl cockpit:rounded-[10px] cockpit:bg-block-wash cockpit:font-ui" onClick={() => p.run("abort", {})}>
              <span className="size-[9px] rounded-[1.5px] bg-current" aria-hidden="true" />Stop{keys && <Key>esc</Key>}
            </button>
          </div>
        )}
        {p.images.length > 0 && (
          <div className="pt-2">
            <Thumbs images={p.images} onRemove={(i) => p.setImages((was) => was.filter((_, j) => j !== i))} />
          </div>
        )}
        {(problem || blind) && <p className="text-[13.5px] text-block" role="alert">{problem ?? "The current model does not take images; pi will leave them out or the model will refuse them."}</p>}
        <div className="flex items-end gap-2.5 cards:gap-2">
          <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }} />
          <button className="-mr-1.5 grid size-11 flex-none place-items-center text-[22px] text-ink2 hover:text-ink disabled:opacity-40 cards:h-[46px] native:h-[38px]" aria-label="Add an image" disabled={p.images.length >= IMAGES_MAX} onClick={() => picker.current?.click()}>
            <Icon name="image" />
          </button>
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
              if (files.length === 0) return;
              // An image alone is attached; text with it still pastes.
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              void add(files);
            }}
            onKeyDown={(e) => {
              // Not while an input method is composing: its Enter picks the word.
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape" && keys) {
                e.preventDefault();
                e.currentTarget.blur();
                return;
              }
              if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
              if (e.metaKey || e.ctrlKey || keyboard) {
                e.preventDefault();
                send();
              }
            }}
            enterKeyHint={keyboard ? "send" : "enter"}
            placeholder={busy ? "Steer, or queue a follow-up" : "Message"}
            aria-label="Message"
            className="min-h-11 min-w-0 flex-1 resize-none rounded-[22px] bg-wash px-4 py-[11px] text-base leading-[1.35] outline-none placeholder:text-ink3 cards:min-h-[46px] cards:rounded-[23px] cards:py-3 cards:text-[15.5px] native:min-h-[38px] native:rounded-[19px] native:border native:border-rule native:bg-card native:py-2 native:text-base cockpit:rounded-[10px] cockpit:border cockpit:border-rule cockpit:bg-card cockpit:px-3 cockpit:text-[15px]"
          />
          {/* Native's idle send is a round arrow, as a messaging app's. */}
          <button
            className={`h-11 flex-none rounded-full bg-ink px-4.5 text-[15px] font-semibold text-paper disabled:bg-wash2 disabled:text-ink3 cards:h-[46px] cards:bg-accent cards:text-on-accent cards:disabled:bg-accent cards:disabled:text-on-accent cards:disabled:opacity-40 native:h-[38px] native:disabled:bg-wash2 native:disabled:text-ink3 native:disabled:opacity-100 cockpit:rounded-[10px] cockpit:bg-accent cockpit:text-on-accent ${busy ? "native:rounded-xl" : "native:w-[38px] native:px-0 native:text-xl"}`}
            disabled={empty}
            onClick={send}
            aria-label={busy ? undefined : "Send"}
          >
            {busy
              ? (mode === "steer" ? "Steer" : "Queue")
              : <><span className="native:hidden">Send</span><span className="hidden native:inline" aria-hidden="true">↑</span></>}
            {keys && <Key>⏎</Key>}
          </button>
        </div>
      </div>
    </div>
  );
}

// A key's name on its button, printed in Cockpit only.
function Key(p: { children: string }) {
  return <kbd className="ml-2 hidden rounded-[3px] border border-current/40 px-1 font-mono text-[11px] font-normal opacity-80 cockpit:inline" aria-hidden="true">{p.children}</kbd>;
}
