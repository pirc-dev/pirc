// One session's chat: its items, the composer, and the session's actions.
import { createContext, memo, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { AssistantItem, ChatItem, ChatView, SessionView, UserItem } from "../../core/view.ts";
import { live } from "./live.ts";
import { IMAGES_MAX } from "../../core/api.ts";
import { Icon } from "./icons.tsx";
import { free, useKey, useKeys } from "./keys.ts";
import { useLayer } from "./layer.ts";
import { answered, type Pending as SentPending, quiet, settle, userIds } from "../../core/pending.ts";
import { markSeen } from "./seen.ts";
import { title, where } from "./names.ts";
import { Status } from "./Status.tsx";
import { useHold } from "./update.ts";
import { type Run } from "./chat.ts";
import { type Part, partKey, runs, signature } from "../../core/chat.ts";
import { useMarkdown } from "./Markdown.tsx";
import { Folded, Tool } from "./Tool.tsx";
import { Composer } from "./Composer.tsx";
import { CopyButton } from "./Copy.tsx";
import { loadDraft, saveDraft } from "./drafts.ts";
import type { Attachment } from "./attach.ts";
import { Thumbs } from "./Images.tsx";
import { Actions, type FromMessage, MessageSheet } from "./SessionSheets.tsx";

type Pending = SentPending<Attachment>;

// Offers to go back or fork from a user message; undefined where pi cannot
// (a message pi has not saved yet, a session that has ended).
const OfferFrom = createContext<((it: UserItem) => void) | undefined>(undefined);

const DONE: Record<FromMessage, string> = {
  back: "Went back to before the message; it is back in the box below",
  summary: "Went back to before the message, with a summary of what came after; the message is back in the box below",
  fork: "Forked into a new session; the message is back in the box below",
};

// A line under the header: what an action answered, or why it failed.
interface Notice {
  text: string;
  bad?: boolean;
}

export function Chat(p: { id: string; session: SessionView | undefined; chat: ChatView | undefined; back: () => void; wide?: boolean; open?: (id: string) => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const markdown = useMarkdown();
  const menu = useLayer(menuOpen, () => setMenuOpen(false));
  // The session gone (pi quit, its host dropped): its menu goes too.
  const gone = !p.session;
  useEffect(() => {
    if (gone && menuOpen) menu.close();
    // menu.close reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone, menuOpen]);
  const [notice, setNotice] = useState<Notice>();
  // What is being written, kept when the chat is left (drafts.ts).
  const [text, setText] = useState(() => loadDraft(p.id));
  useEffect(() => saveDraft(p.id, text), [p.id, text]);
  // Images to send with it; not kept with the draft.
  const [images, setImages] = useState<Attachment[]>([]);
  // The message going back or a fork is being offered from.
  const [from, setFrom] = useState<UserItem>();
  const fromLayer = useLayer(from !== undefined, () => setFrom(undefined));
  useEffect(() => {
    if (gone && from) fromLayer.close();
    // fromLayer.close reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gone, from]);
  // Stable, so that the items it reaches do not render again.
  const offerFrom = useRef((it: UserItem) => {
    fromLayer.show();
    setFrom(it);
  }).current;
  const [pending, setPending] = useState<Pending[]>([]);
  // On a phone, the header lies over the chat, and folds to one line while
  // the reader is back in it: neither at its end, where one arrives and
  // writes, nor at its top. The chat starts below the header unfolded, so
  // that folding moves nothing.
  const [folded, setFolded] = useState(false);
  const fold = folded && !p.wide;
  const over = useRef<HTMLDivElement>(null);
  const [overHeight, setOverHeight] = useState(0);
  useLayoutEffect(() => {
    const el = over.current;
    if (!el || p.wide) return;
    const measure = () => {
      if (!foldedNow.current) setOverHeight(el.offsetHeight);
    };
    // From the wide layout, where it may have been left folded.
    setFolded(false);
    setOverHeight(el.offsetHeight);
    const sized = new ResizeObserver(measure);
    sized.observe(el);
    return () => sized.disconnect();
  }, [p.wide]);
  const foldedNow = useRef(fold);
  foldedNow.current = fold;
  // A reload for a new version would lose both.
  useHold(text !== "" || pending.length > 0);
  const s = p.session;
  const items = p.chat?.items;
  // Sending needs the chat as it is, to tell pi's copy of a message from an
  // earlier one with the same text.
  const ready = Boolean(p.chat && !(p.chat.loading && p.chat.items.length === 0));
  const itemsNow = useRef(items ?? []);
  itemsNow.current = items ?? [];
  const nextKey = useRef(0);
  const change = (key: number, f: (x: Pending) => Pending | undefined) =>
    setPending((ps) => settle(ps.flatMap((x) => (x.key === key ? (f(x) ?? []) : [x])), itemsNow.current));
  useEffect(() => {
    if (items) setPending((ps) => settle(ps, items));
  }, [items]);
  // Open, its latest message has been read.
  const lastAt = s?.last?.at;
  useEffect(() => {
    if (lastAt !== undefined) markSeen(p.id, lastAt);
  }, [p.id, lastAt]);
  // pi idle with a message still queued: stopped, pi puts its queue back
  // in its input box, unsent.
  const idle = s && !s.working && !s.compacting;
  const waiting = (x: Pending) => x.state === "queued" || x.state === "sent";
  const queued = pending.some(waiting);
  useEffect(() => {
    if (!idle || !queued) return;
    const t = setTimeout(() => setPending((ps) => ps.map((x) => (waiting(x) ? { ...x, state: "lost" } : x))), LOST_MS);
    return () => clearTimeout(t);
  }, [idle, queued]);
  const pendingNow = useRef(pending);
  pendingNow.current = pending;
  const send = async (body: string, images: Attachment[], delivery?: "steer" | "followUp", key = nextKey.current++) => {
    // A retry is the same request: if pi has it already, it is not run again.
    const requestId = pendingNow.current.find((x) => x.key === key)?.requestId ?? crypto.randomUUID();
    const sent: Pending = { key, requestId, text: body, ...(images.length ? { images } : {}), delivery, state: "sending", before: userIds(itemsNow.current) };
    setPending((ps) => [...ps.filter((x) => x.key !== key), sent]);
    try {
      const r = await live.command(p.id, "prompt", {
        requestId, text: body,
        ...(images.length ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}),
        ...(delivery ? { delivery } : {}),
      });
      change(key, (x) => answered(x, r.ok, r.ok ? undefined : r.message));
    } catch (e) {
      change(key, (x) => answered(x, false, `no answer (${(e as Error).message}); pi may have it`, true));
    }
  };
  const run: Run = async (name, body) => {
    setNotice(undefined);
    try {
      const r = await live.command(p.id, name, body);
      if (!r.ok) setNotice({ text: `${r.code}: ${r.message}`, bad: true });
      return r;
    } catch (e) {
      setNotice({ text: (e as Error).message, bad: true });
      return undefined;
    }
  };
  // The turn under way started at its user message, by the host's clock.
  const last = items?.at(-1);
  const since = last?.turnId ? items?.find((x) => x.kind === "user" && x.turnId === last.turnId)?.at : undefined;
  // Esc stops pi, as in its terminal; not while it asks a question, which
  // has its own answers, nor from a field (Esc leaves the box first).
  const keys = useKeys();
  useKey(keys && Boolean((s?.working || s?.compacting) && !s?.questions?.length), (e) => {
    if (e.key !== "Escape" || !free(e)) return;
    e.preventDefault();
    void run("abort", {});
  });
  const spend = useSpend(s, items?.filter((x) => x.kind === "assistant").length ?? 0);
  const actions = s && (
    <button className="grid size-11 flex-none place-items-center text-xl" aria-label="Session actions" onClick={() => {
      menu.show();
      setMenuOpen(true);
    }}>
      <Icon name="more" />
    </button>
  );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={over} className={p.wide ? "contents" : "absolute inset-x-0 top-0 z-10 bg-paper cards:bg-card native:bg-card/85 native:backdrop-blur-xl native:backdrop-saturate-[1.8]"}>
        <header className={`flex-none border-b border-rule ${p.wide ? "bg-paper pt-3 pb-2.5 cards:bg-card" : fold ? "pb-0" : "pb-2.5"}`}>
          {/* Beside the list, the chat has nowhere to go back to, and its
              actions sit by its title. Folded, one line holds the way
              back, the title and the actions. */}
          {!p.wide && (
            <div className="flex min-h-11 items-center pr-2 pl-1">
              <button className="flex min-h-11 flex-none items-center gap-0.5 px-2 text-[15px] text-ink2 cards:text-[16px] cards:text-accent native:text-[17px] cockpit:font-mono cockpit:text-sm" onClick={p.back} aria-label={fold ? "Sessions" : undefined}>
                <Icon name="back" className="size-5" />{!fold && "Sessions"}
              </button>
              {fold && s
                ? (
                  <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <Status on={s.working} compacting={s.compacting} asks={Boolean(s.questions?.length)} className="w-4 text-[15px]" />
                    <h1 className="min-w-0 flex-1 truncate font-read text-[17px] font-medium cards:font-ui cards:font-[650] native:font-semibold cockpit:font-mono cockpit:text-[15px] cockpit:font-bold">{title(s)}</h1>
                    {spend}
                  </div>
                )
                : fold
                ? <h1 className="min-w-0 flex-1 truncate font-read text-[17px] font-medium cards:font-ui cards:font-[650] native:font-semibold cockpit:font-mono cockpit:text-[15px] cockpit:font-bold">Session ended</h1>
                : <span className="flex-1" />}
              {actions}
            </div>
          )}
          {!fold && (
            <div className={`flex items-center ${p.wide ? "pr-2" : ""}`}>
              <div className="mx-auto min-w-0 max-w-[44rem] flex-1">
                <div className="flex items-baseline gap-2 px-4">
                  {s && <Status on={s.working} compacting={s.compacting} asks={Boolean(s.questions?.length)} className="w-4 text-[17px]" />}
                  <h1 className="min-w-0 flex-1 truncate font-read text-2xl font-medium tracking-[-0.01em] cards:text-xl cards:font-[650] native:text-lg native:font-semibold cockpit:font-mono cockpit:text-base cockpit:font-bold">{s ? title(s) : "Session ended"}</h1>
                  {spend}
                </div>
                {s && <p className="truncate pt-0.5 pr-4 pl-10 text-[12.5px] text-ink2 cards:font-mono cards:text-xs cards:text-ink3 native:pl-[54px] native:font-ui native:text-xs native:text-ink2 cockpit:font-mono cockpit:text-[11.5px] cockpit:text-ink3"><Meta session={s} /></p>}
              </div>
              {p.wide && actions}
            </div>
          )}
        </header>
        {notice && (
          <div className={`flex flex-none items-center gap-2 border-b border-rule py-1.5 pr-2 pl-5 text-[13.5px] ${notice.bad ? "text-block cards:bg-block-wash cockpit:bg-block-wash" : "text-ink2 cards:bg-wash cockpit:bg-card"} cockpit:font-mono cockpit:text-xs`} role="status">
            <div className="notice min-w-0 flex-1"><Markdown {...markdown}>{notice.text}</Markdown></div>
            <button className="grid size-11 flex-none place-items-center" onClick={() => setNotice(undefined)} aria-label="Dismiss"><Icon name="close" /></button>
          </div>
        )}
      </div>
      {menuOpen && s && <Actions session={s} run={run} close={menu.close} say={(text) => setNotice({ text })} open={p.open} />}
      {from && s && (
        <MessageSheet
          session={s}
          item={from}
          close={fromLayer.close}
          go={async (how) => {
            const it = from;
            fromLayer.close();
            // Offered only once pi has saved the message (User).
            if (!it.entryId) return;
            const r = how === "fork" ? await run("fork", { entryId: it.entryId }) : await run("tree", { entryId: it.entryId, summarize: how === "summary" });
            if (!r?.ok) return;
            // As pi's /fork and /tree: the message comes back, to edit and send.
            setText((t) => (t.trim() ? `${it.text}\n\n${t}` : it.text));
            setNotice({ text: DONE[how] });
          }}
        />
      )}
      <OfferFrom.Provider value={s ? offerFrom : undefined}>
        <Items
          chat={p.chat}
          working={Boolean(s?.working || s?.compacting)}
          compacting={Boolean(s?.compacting)}
          asking={Boolean(s?.questions?.length)}
          pending={pending}
          retry={(x) => void send(x.text, x.images ?? [], x.delivery, x.key)}
          edit={(x) => {
            setPending((ps) => ps.filter((y) => y.key !== x.key));
            setText(text.trim() ? `${x.text}\n\n${text}` : x.text);
            if (x.images) setImages((was) => [...x.images!, ...was].slice(0, IMAGES_MAX));
          }}
          dismiss={(x) => setPending((ps) => ps.filter((y) => y.key !== x.key))}
          top={p.wide ? 0 : overHeight}
          fold={p.wide ? noFold : setFolded}
        />
      </OfferFrom.Provider>
      {s && (
        <Composer
          session={s}
          run={run}
          text={text}
          setText={setText}
          images={images}
          setImages={setImages}
          ready={ready}
          since={since}
          turn={last?.turnId}
          send={(delivery) => {
            if ((!text.trim() && images.length === 0) || !ready) return;
            void send(text, images, delivery);
            setText("");
            setImages([]);
          }}
        />
      )}
    </div>
  );
}

// How full the context is and what the session has cost, asked of pi when
// the chat opens, after each reply and when the model changes. Nothing
// while it is not known. Asked here, once, for wherever the header shows it.
function useSpend(s: SessionView | undefined, replies: number): React.ReactNode {
  const [text, setText] = useState<string>();
  const model = s?.model && `${s.model.provider}/${s.model.id}`;
  const idle = s && !s.working && !s.compacting;
  const id = s?.id;
  useEffect(() => {
    if (!id) return;
    let current = true;
    // Quietly: the header works without it.
    void live.command(id, "stats", {}).then((r) => {
      if (!current || !r.ok || r.result.kind !== "stats") return;
      const st = r.result;
      // A little is not none.
      const pct = st.contextWindow > 0 && st.contextTokens !== undefined ? Math.round((st.contextTokens / st.contextWindow) * 100) : undefined;
      const used = pct === undefined ? "" : pct === 0 && st.contextTokens! > 0 ? "<1% · " : `${pct}% · `;
      setText(`${used}${st.cost > 0 && st.cost < 0.005 ? "<$0.01" : `$${st.cost.toFixed(2)}`}`);
    }, () => {});
    return () => {
      current = false;
    };
  }, [id, model, idle, replies]);
  if (!text || !s) return null;
  return <span className="flex-none text-[13px] text-ink3 tabular-nums cockpit:font-mono cockpit:text-xs" title="Context used · cost so far">{text}</span>;
}

// Where it runs, its folder, then the model in ink and the thinking level.
function Meta(p: { session: SessionView }) {
  const s = p.session;
  const model = s.model && (s.model.name || s.model.id);
  return (
    <>
      {[where(s), s.cwd].filter(Boolean).join(" · ")}
      {model && <> · <b className="font-semibold text-ink">{model}</b></>}
      {s.thinking && ` · ${s.thinking}`}
    </>
  );
}

// Beside the list, the header does not fold.
const noFold = () => {};

// How long pi may sit idle with a message queued before the page says it
// was not sent.
const LOST_MS = 5000;

function Items(p: {
  chat: ChatView | undefined;
  working: boolean;
  compacting: boolean;
  asking: boolean;
  pending: Pending[];
  retry: (x: Pending) => void;
  edit: (x: Pending) => void;
  dismiss: (x: Pending) => void;
  // Room for the header over the chat, and whether it should fold.
  top: number;
  fold: (folded: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const folded = useRef(false);
  // Follow the end while the reader is there, and after sending.
  const atEnd = useRef(true);
  const sent = useRef(p.pending.length);
  if (p.pending.length > sent.current) atEnd.current = true;
  sent.current = p.pending.length;
  // Scrolled up: a button goes back to the end, and says when there is
  // more there than when the reader left it: another item, more of a reply,
  // a tool's result. (Not by identity: a reload makes every item anew.)
  const [away, setAway] = useState(false);
  const [more, setMore] = useState(false);
  // A reload would lose the place.
  useHold(away);
  const last = signature(p.chat?.items.at(-1));
  const lastSeen = useRef(last);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // Nothing to scroll (a short chat, or one emptied by a new session).
    if (el.scrollHeight - el.clientHeight < 80) {
      atEnd.current = true;
      if (away) setAway(false);
      if (more) setMore(false);
    }
    if (atEnd.current) {
      el.scrollTop = el.scrollHeight;
      lastSeen.current = last;
    } else if (last !== lastSeen.current && !more) setMore(true);
  });
  // Content that grows without a render (fonts arriving, a table laid
  // out) keeps a reader at the end there.
  useEffect(() => {
    const el = box.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    // Opening a thought or a tool call grows it too, but the reader wants
    // to read it from its top.
    let opened = false;
    const toggled = () => (opened = true);
    el.addEventListener("toggle", toggled, true);
    const grown = new ResizeObserver(() => {
      if (atEnd.current && !opened) el.scrollTop = el.scrollHeight;
      opened = false;
    });
    grown.observe(inner);
    return () => {
      grown.disconnect();
      el.removeEventListener("toggle", toggled, true);
    };
  }, [p.chat === undefined]);
  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAway(!atEnd.current);
    // Back in the chat: away from its end and from its top, folding a
    // little further down than it unfolds, so that it does not flicker.
    const fold = !atEnd.current && el.scrollTop > (folded.current ? 8 : 56);
    if (fold !== folded.current) p.fold((folded.current = fold));
    if (atEnd.current) {
      setMore(false);
      lastSeen.current = last;
    }
  };
  const toEnd = () => {
    const el = box.current;
    if (!el) return;
    atEnd.current = true;
    el.scrollTop = el.scrollHeight;
  };
  if (!p.chat) return <div className="flex-1" />;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col native:bg-card">
      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-4 native:px-3.5 cockpit:px-3.5" style={p.top ? { paddingTop: p.top + 16 } : undefined}>
        <div className="mx-auto flex max-w-[40rem] flex-col gap-4">
          {p.chat.truncated && <Note>Earlier messages are not shown</Note>}
          {p.chat.loading && p.chat.items.length === 0 && <Loading />}
          {runs(p.chat.items).map((run) =>
            // A run of tool calls keeps its wrapper as it shrinks, so that a
            // fold opened in it stays open when the last call finishes.
            run.length > 1 || "tools" in run[0] || run[0].item.kind === "tool"
              ? <div key={partKey(run[0])} className="flex flex-col cards:gap-1.5 cockpit:gap-1.5">{run.map((x) => <PartView key={partKey(x)} part={x} />)}</div>
              : <PartView key={partKey(run[0])} part={run[0]} />
          )}
          {p.working && quiet(p.chat.items) && <Dots label={p.compacting ? "Compacting" : undefined} />}
          {p.pending.map((x) => <Unsent key={x.key} pending={x} asking={p.asking} compacting={p.compacting} retry={() => p.retry(x)} edit={() => p.edit(x)} dismiss={() => p.dismiss(x)} />)}
        </div>
      </div>
      {away && (
        <button
          onClick={toEnd}
          aria-label={more ? "New messages: go to the end" : "Go to the end"}
          className="absolute right-4 bottom-3 inline-flex h-9 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13.5px] font-semibold text-paper shadow-[0_6px_20px_rgb(0_0_0/0.18)]"
        >
          <Icon name="down" />{more && "New messages"}
        </button>
      )}
    </div>
  );
}

function PartView(p: { part: Part }) {
  return "tools" in p.part ? <Folded tools={p.part.tools} /> : <Item item={p.part.item} />;
}

// Grey lines where the conversation will be, while its history loads.
function Loading() {
  const line = "h-3 rounded-[3px] bg-wash";
  return (
    <div className="flex flex-col gap-3" aria-label="Loading the conversation" role="status">
      <div className="h-9 w-[55%] self-end rounded-[18px] bg-wash" />
      {[92, 97, 88, 60].map((w) => <div key={w} className={line} style={{ width: `${w}%` }} />)}
      <div className="-mx-5 h-20 bg-wash cards:mx-0 cards:rounded-xl cockpit:mx-0 cockpit:rounded-lg" />
      {[94, 70].map((w) => <div key={w} className={line} style={{ width: `${w}%` }} />)}
      <Note>Loading the conversation</Note>
    </div>
  );
}

// A line between messages, in small capitals.
function Note(p: { children: React.ReactNode }) {
  return <p className="text-center text-[11.5px] font-semibold tracking-[0.14em] text-ink3 uppercase native:text-[13px] native:font-normal native:tracking-normal native:text-ink2 native:normal-case cockpit:font-mono cockpit:text-xs cockpit:font-normal cockpit:tracking-normal cockpit:normal-case">{p.children}</p>;
}

// A finished item does not change: keep it from rendering again while
// another streams.
const Item = memo(function Item(p: { item: ChatItem }) {
  const it = p.item;
  switch (it.kind) {
    case "user":
      return <User item={it} />;
    case "assistant":
      return <Assistant item={it} />;
    case "tool":
      return <Tool item={it} />;
    case "compaction":
      return <Summary label={`Context compacted · ${it.tokensBefore.toLocaleString()} tokens before`} text={it.summary} />;
    case "branchSummary":
      return <Summary label="Went back · what came after, summarised" text={it.summary} />;
  }
});

// A summary pi wrote, folded under a line.
function Summary(p: { label: string; text: string }) {
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none justify-center gap-1.5 text-[11.5px] font-semibold tracking-[0.14em] text-ink3 uppercase [&::-webkit-details-marker]:hidden native:text-[13px] native:font-normal native:tracking-normal native:text-ink2 native:normal-case cockpit:font-mono cockpit:text-xs cockpit:font-normal cockpit:tracking-normal cockpit:normal-case">
        {p.label}
      </summary>
      <p className="mt-2 border-l border-rule pl-3.5 font-read text-[15px] leading-relaxed text-ink2 italic whitespace-pre-wrap">{p.text}</p>
    </details>
  );
}

// The user's message. Tapping it offers going back or a fork from there,
// once pi has saved it (its ID is pi's entry); a tap that ends selecting
// its text does not.
function User(p: { item: UserItem }) {
  const it = p.item;
  const from = useContext(OfferFrom);
  const offer = from && it.entryId
    ? () => {
      if (!window.getSelection()?.toString()) from(it);
    }
    : undefined;
  return (
    <Bubble offer={offer}>
      {it.images.length > 0 && <div className={it.text ? "pb-1.5" : ""}><Thumbs images={it.images} /></div>}
      {it.text}
    </Bubble>
  );
}

function Bubble(p: { faded?: boolean; refused?: boolean; offer?: () => void; children: React.ReactNode }) {
  return (
    <div
      role={p.offer ? "button" : undefined}
      tabIndex={p.offer ? 0 : undefined}
      aria-haspopup={p.offer ? "dialog" : undefined}
      title={p.offer ? "Go back or fork from here" : undefined}
      onClick={p.offer}
      onKeyDown={p.offer && ((e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          p.offer!();
        }
      })}
      className={`max-w-[82%] self-end ${p.offer ? "cursor-pointer" : ""} rounded-[18px_18px_4px_18px] px-3.5 py-2 text-[15.5px] leading-snug whitespace-pre-wrap cards:rounded-[20px_20px_6px_20px] cards:py-[9px] native:text-base cockpit:rounded-[14px_14px_4px_14px] cockpit:px-3 cockpit:text-[15px] ${p.refused ? "ring-1 ring-block ring-inset cards:bg-block-wash" : "bg-wash cards:bg-accent cards:text-on-accent"} ${p.faded ? "opacity-50" : ""}`}>
      {p.children}
    </div>
  );
}

// pi is working, and nothing in the chat shows it.
function Dots(p: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-sm text-ink2" role="status" aria-label={p.label ?? "Working"}>
      <span className="flex gap-1.5">
        {[0, 200, 400].map((d) => <span key={d} className="size-1.5 animate-pulse rounded-full bg-ink2" style={{ animationDelay: `${d}ms` }} />)}
      </span>
      {p.label}
    </div>
  );
}

// A message sent from here that pi's chat does not show yet. One sent
// while pi asks a question waits for the answer: an extension may ask
// before the run starts.
function Unsent(p: { pending: Pending; asking: boolean; compacting: boolean; retry: () => void; edit: () => void; dismiss: () => void }) {
  const x = p.pending;
  const trouble = x.state === "failed" || x.state === "lost";
  const [state, why] = x.state === "sending"
    ? (p.asking ? ["Waiting", "pi asks something first"] : ["Sending", ""])
    : x.state === "sent"
    ? ["Sent", ""]
    : x.state === "queued"
    ? p.compacting ? ["Queued", "sends when pi finishes compacting"]
    : (x.delivery === "steer" ? ["Steering", "pi sends it after the current step"] : ["Queued", "sends when this turn ends"])
    : x.state === "failed"
    ? ["", `Not sent: ${x.error || "no answer"}`]
    : ["", "Not sent: pi stopped first, and put it back in its own input box"];
  const link = "min-h-9 px-2.5 text-sm font-semibold underline decoration-ink3 underline-offset-[3px]";
  return (
    <div className="flex max-w-[84%] flex-col items-end gap-1.5 self-end">
      <Bubble faded={!trouble} refused={trouble}>
        {x.images && <div className={x.text ? "pb-1.5" : ""}><Thumbs images={x.images} /></div>}
        {x.text}
      </Bubble>
      {trouble
        ? (
          <>
            <p className="text-right text-[13.5px] leading-snug text-block">{why}</p>
            <div className="flex">
              <button className={link} onClick={p.retry}>Retry</button>
              <button className={link} onClick={p.edit}>Edit</button>
              <button className={`${link} font-normal text-ink2`} onClick={p.dismiss}>Dismiss</button>
            </div>
          </>
        )
        : (
          <span className="flex items-center gap-1.5 text-[11.5px] font-semibold tracking-[0.1em] text-ink2 uppercase cards:text-[12.5px] cards:font-medium cards:tracking-normal cards:text-ink3 cards:normal-case cockpit:font-mono cockpit:font-normal cockpit:tracking-normal cockpit:text-ink3 cockpit:normal-case">
            {x.state === "sending" && <span className="size-2.5 animate-spin rounded-full border-[1.5px] border-current border-r-transparent" />}
            {state}
            {why && <span className="font-normal tracking-normal normal-case">· {why}</span>}
          </span>
        )}
    </div>
  );
}

// A reply; one that ends a turn can be copied, as the Markdown it was
// written in.
function Assistant(p: { item: AssistantItem }) {
  const it = p.item;
  const markdown = useMarkdown();
  const text = it.blocks.filter((b) => b.kind === "text" && b.text).map((b) => b.text).join("\n\n");
  const done = !it.streaming && (it.stop === "stop" || it.stop === "length") && text.trim() !== "";
  return (
    <div className="flex flex-col gap-3">
      {it.blocks.map((b, i) => {
        if (!b.text) return null;
        if (b.kind === "thinking") {
          return (
            <details key={i} className="group">
              <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 font-read text-[15px] text-ink2 italic [&::-webkit-details-marker]:hidden cards:min-h-[30px] cards:rounded-full cards:bg-wash cards:px-3 cards:text-[13.5px] cards:text-ink3 cards:not-italic native:text-sm native:font-medium cockpit:font-mono cockpit:text-[12.5px] cockpit:text-ink3 cockpit:not-italic">
                Thinking<Icon name="chevron" className="size-3 transition-transform group-open:rotate-90" />
              </summary>
              <p className="mt-1 border-l border-rule pl-3.5 font-read text-[15px] leading-relaxed text-ink2 italic whitespace-pre-wrap cards:mt-2.5 cards:border-l-2 cards:border-wash2 cards:pl-3 cards:text-sm cockpit:border-l-2 cockpit:border-wash2 cockpit:pl-2.5 cockpit:text-sm">{b.text}</p>
            </details>
          );
        }
        // While it streams, a thin cursor follows the last word.
        const writing = it.streaming && i === it.blocks.length - 1;
        return <div key={i} className={`prose-chat ${writing ? "writing" : ""}`}><Markdown {...markdown}>{b.text}</Markdown></div>;
      })}
      {it.streaming && <span className={`cursor ${it.blocks.at(-1)?.kind === "text" ? "after-text" : ""}`} />}
      {it.stop === "error" && <p className="text-sm text-block">⚠ The model failed: {it.error || "no reason given"}</p>}
      {it.stop === "aborted" && <Note>Stopped</Note>}
      {done && <CopyButton text={() => text} label="Copy reply" className="-mt-2 -ml-1.5 self-start" />}
    </div>
  );
}
