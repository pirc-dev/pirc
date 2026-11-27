// Where a message is written and sent, with Stop and how long the turn
// has taken.
import { useEffect, useRef, useState } from "react";
import type { SessionView } from "../../core/view.ts";
import { useNow } from "./time.ts";
import { type Run } from "./chat.ts";
import { Ask } from "./Ask.tsx";
import { Icon } from "./icons.tsx";
import { type Attachment, type PickedFile, readFile, shrink } from "./attach.ts";
import { Thumbs } from "./Images.tsx";
import { FileChips, size } from "./Files.tsx";
import { useKeyboard, useKeys } from "./keys.ts";
import { live } from "./live.ts";
import { SHORT, useMedia } from "./media.ts";
import { FILES_BYTES_MAX, FILES_MAX, FILES_REQUEST, IMAGES_MAX } from "../../core/api.ts";

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
// own line, by how long the turn has run and away from the send button;
// Send then steers, pi reading the message after the step it is on (as
// Enter in pi), and held, or right-clicked, offers to queue it instead,
// for when the whole task is done (as Alt+Enter in pi). Neither interrupts
// pi: only Stop does. Images come with the button beside
// the box, or pasted or dropped anywhere on the page; so do other files,
// for a session that takes them, up to FILES_BYTES_MAX together. Cmd/Ctrl+Enter sends
// as the button would; so does Enter where there is a mouse or trackpad, taken as a sign
// of a hardware keyboard (keys.ts), Shift+Enter there making a new line, and
// Alt+Enter queues. On a touch
// screen Enter is the keyboard's return key, a new line. With the keys on,
// Esc leaves the box, and a second stops pi (Chat.tsx).
export function Composer(p: {
  session: SessionView;
  run: Run;
  text: string;
  setText: (t: string) => void;
  images: Attachment[];
  setImages: (f: (was: Attachment[]) => Attachment[]) => void;
  files: PickedFile[];
  setFiles: (f: (was: PickedFile[]) => PickedFile[]) => void;
  ready: boolean;
  since: number | undefined;
  send: (delivery?: "steer" | "followUp") => void;
}) {
  const { text, setText } = p;
  const area = useRef<HTMLTextAreaElement>(null);
  const keyboard = useKeyboard();
  const keys = useKeys();
  const short = useMedia(SHORT);
  const busy = p.session.working || p.session.compacting;
  const [problem, setProblem] = useState<string>();
  // What was refused is not said again once the message goes.
  const sendAs = (delivery?: "steer" | "followUp") => {
    if (empty) return;
    setProblem(undefined);
    p.send(delivery);
  };
  const send = () => sendAs(busy ? "steer" : undefined);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    // On a phone on its side, four lines, leaving the chat some room.
    el.style.height = `${Math.min(el.scrollHeight, short ? 100 : 200)}px`;
    // Also when it comes back, after a question.
  }, [text, Boolean(p.session.questions?.length), short]);
  const empty = (!text.trim() && p.images.length === 0 && p.files.length === 0) || !p.ready;
  const picker = useRef<HTMLInputElement>(null);
  // Whether the session's extension takes files (session.proto, Prompt).
  const takesFiles = p.session.requests?.includes(FILES_REQUEST) ?? false;
  // The files being read, counted with those attached against the limits.
  const reading = useRef({ count: 0, bytes: 0 });
  const attached = useRef(p.files);
  attached.current = p.files;
  // A file within the limits, read and attached; otherwise why not.
  const addFile = async (f: File) => {
    const count = attached.current.length + reading.current.count;
    const bytes = attached.current.reduce((n, x) => n + x.size, 0) + reading.current.bytes;
    if (count >= FILES_MAX) return setProblem(`At most ${FILES_MAX} files in a message.`);
    if (bytes + f.size > FILES_BYTES_MAX) {
      return setProblem(`${f.name} (${size(f.size)}) was not added: a message's files come to ${size(FILES_BYTES_MAX)} at most${bytes ? `, and ${size(bytes)} are attached` : ""}.`);
    }
    reading.current = { count: reading.current.count + 1, bytes: reading.current.bytes + f.size };
    try {
      const picked = await readFile(f);
      attached.current = [...attached.current, picked];
      p.setFiles((all) => [...all, picked]);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      reading.current = { count: reading.current.count - 1, bytes: reading.current.bytes - f.size };
    }
  };
  const add = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    if (files.length === 0) return;
    setProblem(undefined);
    if (others.length > 0 && !takesFiles) {
      setProblem(`This session's extension (${p.session.extensionVersion}) takes images only; update it to send other files.`);
    }
    const room = IMAGES_MAX - p.images.length;
    if (images.length > room) setProblem(`At most ${IMAGES_MAX} images in a message.`);
    for (const f of images.slice(0, Math.max(0, room))) {
      try {
        const a = await shrink(f);
        p.setImages((was) => (was.length < IMAGES_MAX ? [...was, a] : was));
      } catch (e) {
        // One the browser cannot draw still goes as it is, as a file.
        if (takesFiles) await addFile(f);
        else setProblem((e as Error).message);
      }
    }
    if (takesFiles) for (const f of others) await addFile(f);
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
  const shell = "flex-none border-t border-rule bg-paper px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] cards:bg-card cards:px-3 native:bg-paper cockpit:px-3";
  // While pi asks, the question is in the composer's place, "Dismiss and
  // stop" in Stop's; what was being written waits for it to go.
  const asked = p.session.questions?.[0];
  if (asked) {
    return (
      <div className={shell}>
        <div className="@container mx-auto max-w-[40rem]">
          <Ask key={asked.id} q={asked} more={p.session.questions!.length - 1} session={p.session} run={p.run} />
        </div>
      </div>
    );
  }
  return (
    <div className={shell}>
      <div className="@container mx-auto flex max-w-[40rem] flex-col gap-2.5">
        {busy && (
          <div className="flex items-center gap-2.5 text-[13.5px] text-ink2 cockpit:font-mono cockpit:text-xs">
            <span className="w-4 text-center font-mono font-semibold text-work" aria-hidden="true">◐</span>
            <Status since={p.since} compacting={Boolean(p.session.compacting)} />
            <button className="hit relative ml-auto inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-semibold text-block ring-1 ring-block ring-inset cards:bg-block-wash cards:ring-0 native:rounded-xl cockpit:rounded-[10px] cockpit:bg-block-wash cockpit:font-ui" onClick={() => p.run("abort", {})}>
              <span className="size-[9px] rounded-[1.5px] bg-current" aria-hidden="true" />Stop{keys && <Key>esc</Key>}
            </button>
          </div>
        )}
        {p.images.length > 0 && (
          <div className="pt-2">
            <Thumbs images={p.images} onRemove={(i) => p.setImages((was) => was.filter((_, j) => j !== i))} />
          </div>
        )}
        {p.files.length > 0 && (
          <div className={p.images.length > 0 ? "" : "pt-2"}>
            <FileChips files={p.files} onRemove={(i) => p.setFiles((was) => was.filter((_, j) => j !== i))} />
          </div>
        )}
        {(problem || blind) && <p className="text-[13.5px] text-block" role="alert">{problem ?? "The current model does not take images; pi will leave them out or the model will refuse them."}</p>}
        <div className="flex items-end gap-2.5 cards:gap-2">
          <input ref={picker} type="file" accept={takesFiles ? undefined : "image/*"} multiple hidden onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }} />
          {takesFiles
            ? (
              <button className="hit relative -mr-1.5 grid size-11 flex-none place-items-center text-[22px] text-ink2 hover:text-ink cards:h-[46px] native:h-[38px]" aria-label="Attach an image or file" title="Attach an image or file" onClick={() => picker.current?.click()}>
                <Icon name="clip" />
              </button>
            )
            : (
              <button className="hit relative -mr-1.5 grid size-11 flex-none place-items-center text-[22px] text-ink2 hover:text-ink disabled:opacity-40 cards:h-[46px] native:h-[38px]" aria-label="Add an image" disabled={p.images.length >= IMAGES_MAX} onClick={() => picker.current?.click()}>
                <Icon name="image" />
              </button>
            )}
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => takesFiles || f.type.startsWith("image/"));
              if (files.length === 0) return;
              // A file alone is attached; text with it still pastes.
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
              if (e.key !== "Enter" || e.shiftKey) return;
              if (e.altKey) {
                // Queued, as in pi; never a new line, which Option+Enter
                // would otherwise make.
                e.preventDefault();
                sendAs(busy ? "followUp" : undefined);
                return;
              }
              if (e.metaKey || e.ctrlKey || keyboard) {
                e.preventDefault();
                send();
              }
            }}
            enterKeyHint={keyboard ? "send" : "enter"}
            placeholder={busy ? "Steer, or hold to queue" : "Message"}
            aria-label="Message"
            className="min-h-11 min-w-0 flex-1 resize-none rounded-[22px] bg-wash px-4 py-[11px] text-base leading-[1.35] outline-none placeholder:text-ink3 cards:min-h-[46px] cards:rounded-[23px] cards:py-3 cards:text-[15.5px] native:min-h-[38px] native:rounded-[19px] native:border native:border-rule native:bg-card native:py-2 native:text-base cockpit:rounded-[10px] cockpit:border cockpit:border-rule cockpit:bg-card cockpit:px-3 cockpit:text-[15px] touch:text-base!"
          />
          <Send busy={busy} empty={empty} keys={keys} send={sendAs} />
        </div>
      </div>
    </div>
  );
}

// A key's name on its button, printed in Cockpit only.
function Key(p: { children: string }) {
  return <kbd className="ml-2 hidden rounded-[3px] border border-current/40 px-1 font-mono text-[11px] font-normal opacity-80 cockpit:inline" aria-hidden="true">{p.children}</kbd>;
}

// Send, idle or working, the same: working, it steers; held on a touch
// screen, right-clicked, or with the menu key, it offers to queue instead,
// as a messaging app offers other ways to send. Native's is a round arrow.
function Send(p: { busy: boolean; empty: boolean; keys: boolean; send: (delivery?: "steer" | "followUp") => void }) {
  const [menu, setMenu] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  // The click that ends a hold opens the menu, and does not send.
  const held = useRef(false);
  const offers = p.busy && !p.empty;
  useEffect(() => {
    if (!offers) setMenu(false);
  }, [offers]);
  useEffect(() => {
    if (!menu) return;
    box.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [menu]);
  const open = () => setMenu(true);
  const stopHold = () => clearTimeout(hold.current);
  return (
    <div ref={box} className="relative flex-none">
      {menu && (
        <div className="absolute right-0 bottom-full z-20 mb-2 w-64 overflow-hidden rounded-2xl bg-card text-left shadow-[0_8px_30px_rgb(0_0_0/0.18)] ring-1 ring-rule cards:rounded-[14px] cockpit:rounded-[10px]" role="menu" aria-label="Send">
          {([["steer", "Send now", "pi reads it after the step it is on"], ["followUp", "Queue", "pi reads it when the whole task is done"]] as const).map(([d, label, sub]) => (
            <button
              key={d}
              role="menuitem"
              className="block w-full border-b border-rule px-4 py-2.5 text-left last:border-0 hover:bg-wash focus-visible:bg-wash focus-visible:outline-none"
              onClick={() => {
                setMenu(false);
                p.send(d);
              }}
            >
              <span className="block text-[15px] font-semibold text-ink">{label}</span>
              <span className="block text-[12.5px] text-ink2">{sub}</span>
            </button>
          ))}
        </div>
      )}
      <button
        ref={button}
        className="hit relative h-11 flex-none touch-manipulation rounded-full bg-ink px-4.5 text-[15px] font-semibold text-paper select-none [-webkit-touch-callout:none] disabled:bg-wash2 disabled:text-ink3 cards:h-[46px] cards:bg-accent cards:text-on-accent native:h-[38px] native:w-[38px] native:px-0 native:text-xl cockpit:rounded-[10px] cockpit:bg-accent cockpit:text-on-accent disabled:cards:bg-wash2 disabled:cards:text-ink3 disabled:cockpit:bg-wash2 disabled:cockpit:text-ink3"
        disabled={p.empty}
        aria-label="Send"
        aria-haspopup={offers ? "menu" : undefined}
        aria-expanded={offers ? menu : undefined}
        title={offers ? "pi reads it after the step it is on; hold, or right-click, to queue it for when the whole task is done" : undefined}
        onClick={() => {
          if (held.current) held.current = false;
          else p.send(p.busy ? "steer" : undefined);
        }}
        onContextMenu={(e) => {
          if (!offers) return;
          e.preventDefault();
          stopHold();
          open();
        }}
        onPointerDown={(e) => {
          held.current = false;
          if (offers && e.pointerType !== "mouse") {
            hold.current = setTimeout(() => {
              held.current = true;
              open();
            }, 450);
          }
        }}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
        onPointerCancel={stopHold}
      >
        <span className="native:hidden">Send</span><span className="hidden native:inline" aria-hidden="true">↑</span>
        {p.keys && <Key>⏎</Key>}
      </button>
    </div>
  );
}
