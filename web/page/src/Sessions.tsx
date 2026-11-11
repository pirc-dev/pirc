// The live sessions, by host, then by the tmux session or herdr workspace
// they run in, each closed until opened, the most recent first; or one
// host's, or one group's, on a page of its own; or, with a search, every
// session there that matches. Each shows pi's name for it, its window's
// above it, when it last had a message, and whether it has news: finished
// since it was last open here.
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { rank } from "../../core/fuzzy.ts";
import type { PendingHostView, SessionView } from "../../core/view.ts";
import { JoinRequests } from "./Hosts.tsx";
import { useLayer } from "./layer.ts";
import { launchable, LaunchSheet } from "./Launch.tsx";
import { Icon } from "./icons.tsx";
import { Marked } from "./Marked.tsx";
import { resubscribe } from "./Notify.tsx";
import { free, useKey, useKeys } from "./keys.ts";
import { compare, nextWaiting, Starts } from "../../core/order.ts";
import { onSeen, withNews } from "./seen.ts";
import { useHold } from "./update.ts";
import { ago, details, title, where, windowOf } from "./names.ts";
import { useNow } from "./time.ts";
import { Status, tone } from "./Status.tsx";

// Which hosts and groups are open, kept in this browser only. Everything
// starts closed.
const OPEN_KEY = "pirc.sessions.open";

function loadOpen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function saveOpen(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // Not kept; it still works for this visit.
  }
}

interface Group {
  name: string;
  number: number;
  sessions: SessionView[];
}

// A host's sessions by the tmux session or herdr workspace they run in;
// those outside one come after, ungrouped. All in one says nothing, so
// they are listed as if ungrouped.
function groups(list: SessionView[], order: (a: SessionView, b: SessionView) => number): { groups: Group[]; loose: SessionView[] } {
  const by = new Map<string, Group>();
  const loose: SessionView[] = [];
  for (const s of list) {
    const g = s.place?.group;
    if (!g) {
      loose.push(s);
      continue;
    }
    const group = by.get(g) ?? { name: g, number: s.place?.groupNumber ?? Infinity, sessions: [] };
    group.sessions.push(s);
    by.set(g, group);
  }
  if (by.size === 1 && loose.length === 0) return { groups: [], loose: list.slice().sort(order) };
  for (const g of by.values()) g.sessions.sort(order);
  return {
    groups: [...by.values()].sort((a, b) => a.number - b.number || a.name.localeCompare(b.name)),
    loose: loose.sort(order),
  };
}

// The one tmux session or herdr workspace all of these run in, if so:
// then a host's list shows no group headers, and its own offers a new
// agent there.
function oneGroup(list: SessionView[]): string | undefined {
  const names = new Set(list.map((s) => s.place?.group));
  const [only] = names;
  return names.size === 1 && only ? only : undefined;
}

// What a search reads: the title, the first message, where it runs, its
// folder and model, and the latest message. A result marks what matched in
// the two it shows, the title and where it runs.
const searched = (s: SessionView) => `${title(s)} ${s.first ?? ""} ${where(s)} ${details(s)} ${s.last?.text ?? ""}`;
const whereAt = (s: SessionView) => title(s).length + 1 + (s.first ?? "").length + 1;

// Kept while the page is open, across visits to a chat.
const STARTS = new Starts();

const hostOf = (s: SessionView) => s.hostLabel || s.hostname;

// What a list shows: every session, one host's, or one group's of a host.
export interface Scope {
  host?: string;
  group?: string;
}

// Where a scope's list lives: /, /h/<host>, /h/<host>/<group>.
export function scopePath(scope: Scope): string {
  if (!scope.host) return "/";
  return `/h/${encodeURIComponent(scope.host)}${scope.group ? `/${encodeURIComponent(scope.group)}` : ""}`;
}

// A list of rows: plain in Quiet and Cockpit, on a card in Triage and
// Native.
const rows = "cards:mx-3 cards:divide-y cards:divide-rule cards:overflow-hidden cards:rounded-[14px] cards:border cards:border-rule cards:bg-card native:mx-4 native:border-0";

export function Sessions(p: { sessions: SessionView[]; pendingHosts?: PendingHostView[]; scope: Scope; open: (id: string) => void; go: (scope: Scope) => void; selected?: string; settings?: () => void; inSettings?: boolean }) {
  const { host, group } = p.scope;
  const [query, setQuery] = useState("");
  useHold(query !== "");
  const [open, setOpen] = useState(loadOpen);
  // A session read in the chat beside it is marked read here at once.
  const [, seen] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onSeen(seen), []);
  const now = useNow();
  // The session a new agent is being opened beside.
  const [beside, setBeside] = useState<SessionView>();
  useEffect(() => void resubscribe(), []);
  // Back from Settings, focus returns to its button, if nothing else has it.
  const settingsButton = useRef<HTMLButtonElement>(null);
  const wasInSettings = useRef(p.inSettings);
  useEffect(() => {
    if (wasInSettings.current && !p.inSettings && (document.activeElement === document.body || !document.activeElement)) settingsButton.current?.focus({ preventScroll: true });
    wasInSettings.current = p.inSettings;
  }, [p.inSettings]);
  const launching = useLayer(beside !== undefined, () => setBeside(undefined));
  const launchBeside = (s: SessionView) => {
    launching.show();
    setBeside(s);
  };
  // A button for a new agent beside the newest of these that can open one;
  // className places it in its header.
  const newAgent = (sessions: SessionView[], where: string, className = "") => {
    const s = launchable(sessions);
    return s && (
      <button className={`flex min-h-11 min-w-11 flex-none items-center justify-center text-ink2 hover:text-ink cards:text-accent cockpit:text-link ${className}`} onClick={() => launchBeside(s)} aria-label={`New agent in ${where}`} title={`New agent in ${where}`}>
        <Icon name="plus" className="size-[18px]" />
      </button>
    );
  };
  const news = withNews(p.sessions);
  const starts = STARTS.update(p.sessions);
  const order = compare(starts, title);
  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    setOpen(next);
    saveOpen(next);
  };
  const shown = p.sessions.filter((s) => (!host || hostOf(s) === host) && (!group || s.place?.group === group));
  const hosts = new Map<string, SessionView[]>();
  for (const s of shown) hosts.set(hostOf(s), [...(hosts.get(hostOf(s)) ?? []), s]);
  const found = useMemo(() => (query.trim() ? rank(query, shown, searched) : []),
    // shown is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, p.sessions, host, group]);
  const working = shown.filter((s) => s.working || s.compacting).length;
  const asking = shown.filter((s) => s.questions?.length).length;
  const fresh = shown.filter((s) => news.has(s.id)).length;
  const row = (s: SessionView, window?: string) => <Row key={s.id} session={s} window={window} open={p.open} news={news.has(s.id)} now={now} selected={s.id === p.selected} />;
  // Each with its window's name above its own, the most recent first.
  const listed = (sessions: SessionView[], className = "") => (
    <ul className={`${rows} ${className}`}>
      {sessions.slice().sort(order).map((s) => row(s, windowOf(s)))}
    </ul>
  );
  // A host's groups, each folding, and the sessions in none.
  const body = (h: string, list: SessionView[]) => {
    const { groups: gs, loose } = groups(list, order);
    return (
      <>
        {gs.map((g) => {
          const groupKey = `g:${h}/${g.name}`;
          return (
            <div key={g.name}>
              <div className="flex min-h-11 items-center pr-5">
                <button className="flex min-h-11 max-w-[60%] items-center gap-2.5 pl-5 text-left native:pl-8 cockpit:pl-[30px]" onClick={() => p.go({ host: h, group: g.name })} aria-label={`Open ${g.name}`}>
                  <span className="truncate text-xs font-semibold tracking-[0.12em] text-ink2 uppercase underline-offset-4 hover:underline cards:font-mono cards:text-[13px] cards:font-medium cards:tracking-normal cards:normal-case native:font-ui native:text-[15px] native:font-semibold native:text-ink cockpit:font-mono cockpit:font-medium cockpit:tracking-normal cockpit:normal-case">{g.name}</span>
                </button>
                {/* Beside the name, so that the chevron is at the end whether or
                    not there is a plus. */}
                {newAgent(g.sessions, g.name)}
                <button className="flex min-h-11 flex-1 items-center gap-2.5 pl-2.5 text-left" onClick={() => toggle(groupKey)} aria-expanded={open.has(groupKey)} aria-label={`${open.has(groupKey) ? "Fold" : "Unfold"} ${g.name}`}>
                  <Counts sessions={g.sessions} news={news} />
                  <span className="flex-1 border-t border-rule cards:border-transparent cockpit:border-transparent" />
                  <Chevron open={open.has(groupKey)} />
                </button>
              </div>
              {open.has(groupKey) && listed(g.sessions)}
            </div>
          );
        })}
        {loose.length > 0 && listed(loose, gs.length ? "cards:mt-2" : "pt-1.5")}
      </>
    );
  };
  // Once the header has scrolled under where the bar is, as the search
  // reaches it, the bar shows the title in one line, held at the top over
  // the list.
  const box = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLElement>(null);
  const [folded, setFolded] = useState(false);
  useEffect(() => {
    const root = box.current;
    const h = heading.current;
    if (!root || !h) return;
    const seen = new IntersectionObserver(([e]) => {
      // Hidden (a chat over the list on a phone) says nothing.
      if (e.boundingClientRect.height === 0 || !e.rootBounds) return;
      setFolded(!e.isIntersecting && e.boundingClientRect.top < e.rootBounds.top);
    }, { root, rootMargin: `-${BAR}px 0px 0px 0px` });
    seen.observe(h);
    return () => seen.disconnect();
  }, []);
  // j and k move through the rows shown, Enter opening one as a click
  // would; n opens the next session waiting. Not while the list is hidden
  // behind a chat.
  const keys = useKeys();
  useKey(keys, (e) => {
    if (!free(e) || !["j", "k", "n"].includes(e.key)) return;
    const root = box.current;
    if (!root || root.offsetParent === null) return;
    e.preventDefault();
    if (e.key === "n") {
      const s = nextWaiting(shown, news, order, p.selected);
      if (s) p.open(s.id);
      return;
    }
    const rows = [...root.querySelectorAll<HTMLElement>("[data-row]")];
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const from = at >= 0 ? at : rows.findIndex((r) => r.getAttribute("aria-current"));
    const to = from < 0 ? (e.key === "j" ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, from + (e.key === "j" ? 1 : -1)));
    rows[to].focus();
  });
  // ? opens Settings, which lists the keys; even with a chat over the list.
  useKey(keys, (e) => {
    if (e.key !== "?" || !free(e) || !p.settings || p.inSettings) return;
    e.preventDefault();
    p.settings();
  });
  const up: Scope | undefined = group ? { host } : host ? {} : undefined;
  const pill = "cards:inline-flex cards:h-[26px] cards:items-center cards:rounded-full cards:border cards:border-rule cards:bg-card cards:px-2.5 cards:text-[13px] native:border-0";
  return (
    <div ref={box} className="flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
      <Bar folded={folded} title={group ?? host ?? "Sessions"} asking={asking} fresh={fresh} working={working} top={() => box.current?.scrollTo({ top: 0, behavior: "smooth" })} />
      <header ref={heading} className="px-5 pt-3 cards:px-4 cockpit:px-3.5">
        <div className={`flex min-h-8 items-center text-xs font-semibold tracking-[0.12em] text-ink2 uppercase ${up ? "" : "cards:hidden cockpit:hidden"}`}>
          {up
            ? (
              <button className="-ml-1 flex min-h-11 items-center gap-0.5 text-[15px] font-normal tracking-normal normal-case cards:text-[16px] cards:text-accent cockpit:font-mono cockpit:text-sm" onClick={() => p.go(up)}>
                <Icon name="back" className="size-5" />{group ? host : "Sessions"}
              </button>
            )
            : new Date(now).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
        </div>
        <div className="flex items-center gap-2">
          <h1 className={`mt-0.5 mb-1.5 min-w-0 flex-1 truncate font-read text-[34px] leading-tight tracking-[-0.015em] cards:mb-2.5 cards:text-[28px] cards:font-[650] cards:tracking-[-0.03em] native:text-[34px] native:font-bold native:tracking-[0.01em] cockpit:mt-1 cockpit:mb-1 cockpit:font-mono cockpit:text-[22px] cockpit:font-bold cockpit:tracking-[-0.02em] ${host && !group ? "italic cards:not-italic cockpit:not-italic" : ""} ${group ? "cards:font-mono cards:text-[24px] cards:font-medium cards:tracking-normal native:font-ui native:text-[28px] native:font-bold cockpit:text-[20px]" : ""}`}>{group ?? host ?? "Sessions"}</h1>
          {!host && p.settings && (
            <button ref={settingsButton} className="-mr-2.5 flex min-h-11 min-w-11 flex-none items-center justify-center rounded-full text-ink2 hover:text-ink aria-pressed:bg-wash aria-pressed:text-ink cards:text-accent cockpit:rounded-md cockpit:text-link" onClick={p.settings} aria-label={p.inSettings ? "Close settings" : "Settings"} title={p.inSettings ? "Close settings" : "Settings"} aria-pressed={p.inSettings ?? false}>
              <Icon name="settings" className="size-[22px]" />
            </button>
          )}
        </div>
        {shown.length > 0 && (
          <p className="flex flex-wrap gap-3 text-sm text-ink2 cards:gap-1.5 cockpit:font-mono cockpit:text-[13px]">
            {asking > 0 && <span className={`${tone.blocked} ${pill} native:bg-block-wash`}><Sym>×</Sym><b className="mr-1 font-mono font-semibold cockpit:mr-0">{asking}</b><Word>asking</Word></span>}
            {fresh > 0 && <span className={`${tone.done} ${pill} native:bg-done-wash`}><Sym>✓</Sym><b className="mr-1 font-mono font-semibold cockpit:mr-0">{fresh}</b><Word>done</Word></span>}
            {working > 0 && <span className={`${tone.working} ${pill} native:bg-work-wash`}><Sym>◐</Sym><b className="mr-1 font-mono font-semibold cockpit:mr-0">{working}</b><Word>working</Word></span>}
            <span className={`${pill} native:bg-wash`}><Sym>·</Sym><b className="mr-1 font-mono font-semibold cockpit:mr-0 cockpit:font-medium">{shown.length}</b><Word>in all</Word></span>
            {host && (group ?? oneGroup(shown)) && launchable(shown) && (
              <button className={`${pill} -my-1 flex min-h-9 items-center gap-1 text-ink cards:text-accent native:bg-wash cockpit:text-link`} onClick={() => launchBeside(launchable(shown)!)}>
                <Icon name="plus" className="size-4" />New agent
              </button>
            )}
          </p>
        )}
      </header>
      <JoinRequests hosts={p.pendingHosts ?? []} />
      {shown.length > 0 && (
        <div className="sticky top-11 z-10 bg-paper px-5 pt-3 pb-1 cards:px-3 cards:pt-2 cards:pb-1.5 native:px-4 cockpit:px-3.5 cockpit:pt-2.5 cockpit:pb-1.5">
          <label className="flex h-11 items-center gap-2.5 border-b border-rule text-ink3 focus-within:border-ink focus-within:text-ink cards:h-[46px] cards:gap-2 cards:rounded-full cards:border cards:bg-card cards:px-4 cards:focus-within:border-accent cards:focus-within:text-ink3 cards:focus-within:ring-3 cards:focus-within:ring-accent-soft native:h-[38px] native:rounded-[11px] native:border-0 native:bg-wash native:px-2.5 native:focus-within:ring-0 cockpit:h-10 cockpit:gap-2 cockpit:rounded-lg cockpit:border cockpit:bg-card cockpit:px-3 cockpit:focus-within:border-accent">
            <Icon name="search" className="size-4" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && found[0]) p.open(found[0].item.id);
                if (e.key === "Escape") setQuery("");
              }}
              placeholder={`Search ${shown.length} session${shown.length === 1 ? "" : "s"}${group ? ` in ${group}` : host ? ` on ${host}` : ""}`}
              aria-label="Search sessions"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink3 native:text-[17px] cockpit:font-mono cockpit:text-sm"
            />
            {query && <button className="min-h-11 text-[15px] text-ink cards:text-accent cockpit:font-mono cockpit:text-[13px] cockpit:text-link" onClick={() => setQuery("")}>Cancel</button>}
          </label>
        </div>
      )}
      {shown.length === 0 && (
        <div className="flex flex-col gap-2.5 px-8 py-20">
          <h2 className="font-read text-2xl">{host ? `No pi sessions ${group ? `in ${group}` : `on ${host}`} now.` : "No pi sessions are running."}</h2>
          {!host && <p className="max-w-[30ch] font-read leading-relaxed text-ink2">Start pi with the PiRC extension on any of your machines and it appears here.</p>}
        </div>
      )}
      {query.trim()
        ? (
          <>
            <p className="px-5 pt-3.5 pb-1 text-[11.5px] font-semibold tracking-[0.14em] text-ink2 uppercase">
              {found.length === 0 ? `No session matches “${query.trim()}”` : `${found.length} ${found.length === 1 ? "match" : "matches"}, best first`}
            </p>
            <ul className={rows}>{found.map(({ item: s, match }) => <Row key={s.id} session={s} open={p.open} matched={new Set(match.positions)} news={news.has(s.id)} now={now} selected={s.id === p.selected} />)}</ul>
          </>
        )
        : group
        ? listed(shown, "pt-1.5 cards:pt-0")
        : host
        ? <div className="pt-1">{body(host, shown)}</div>
        : [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([h, list]) => {
          const hostKey = `h:${h}`;
          return (
            <section key={h} className="pb-1">
              <div className="flex items-baseline pr-5">
                <button className="min-w-0 max-w-[60%] pt-4.5 pb-1 pl-5 text-left native:pl-8 cockpit:pl-3.5" onClick={() => p.go({ host: h })} aria-label={`Open ${h}`}>
                  <h2 className="truncate font-read text-[21px] font-medium italic underline-offset-4 hover:underline cards:text-[17px] cards:font-[650] cards:tracking-[-0.01em] cards:not-italic native:text-[13px] native:font-normal native:tracking-[0.03em] native:text-ink2 native:uppercase cockpit:font-mono cockpit:text-[13px] cockpit:font-bold cockpit:tracking-[0.06em] cockpit:not-italic cockpit:uppercase">{h}</h2>
                </button>
                {/* The plus beside the name, so that the chevron is at the end
                    whether or not there is one. The counts on the name's
                    baseline; the plus, having no text to line up, padded as the
                    fold button is and as tall, its icon centred as the chevron. */}
                <div className="flex flex-1 items-baseline self-baseline">
                  {oneGroup(list) && newAgent(list, oneGroup(list)!, "self-stretch pt-4.5 pb-1")}
                  <button className="flex min-h-11 flex-1 items-center justify-end gap-2.5 pt-4.5 pb-1 pl-2.5" onClick={() => toggle(hostKey)} aria-expanded={open.has(hostKey)} aria-label={`${open.has(hostKey) ? "Fold" : "Unfold"} ${h}`}>
                    <Counts sessions={list} news={news} />
                    <Chevron open={open.has(hostKey)} />
                  </button>
                </div>
              </div>
              {open.has(hostKey) && body(h, list)}
            </section>
          );
        })}
      {beside && <LaunchSheet beside={beside} close={launching.close} open={p.open} />}
    </div>
  );
}

// The bar's height: the search is held under it.
const BAR = 44;

// The list's title in one line, over the top of the list once its large
// title has scrolled away, with what needs the reader as counts; it takes
// no room of its own. Tapped, the list goes back to the top. Native's is
// translucent, as its system's bars are.
function Bar(p: { folded: boolean; title: string; asking: number; fresh: number; working: number; top: () => void }) {
  return (
    <div className={`sticky top-0 z-20 -mb-11 h-11 transition-opacity duration-150 ${p.folded ? "opacity-100" : "pointer-events-none invisible opacity-0"}`}>
      <button
        className="flex size-full items-center gap-3 border-b border-rule bg-paper px-5 text-left cards:px-4 native:relative native:justify-center native:border-b-[0.5px] native:bg-paper/80 native:backdrop-blur-xl native:backdrop-saturate-[1.8] cockpit:px-3.5"
        onClick={p.top}
        aria-label={`${p.title}${[p.asking && `, ${p.asking} asking`, p.fresh && `, ${p.fresh} done`, p.working && `, ${p.working} working`].filter(Boolean).join("")}: scroll to the top`}
        tabIndex={p.folded ? 0 : -1}
      >
        <span className="min-w-0 truncate font-read text-lg cards:font-ui cards:text-[17px] cards:font-semibold cockpit:font-mono cockpit:text-[15px] cockpit:font-bold" aria-hidden="true">{p.title}</span>
        <span className="ml-auto flex flex-none gap-2.5 font-mono text-[13px] font-semibold tabular-nums native:absolute native:right-4 cockpit:font-medium" aria-hidden="true">
          {p.asking > 0 && <span className={tone.blocked}>×{p.asking}</span>}
          {p.fresh > 0 && <span className={tone.done}>✓{p.fresh}</span>}
          {p.working > 0 && <span className={tone.working}>◐{p.working}</span>}
        </span>
      </button>
    </div>
  );
}

function Chevron(p: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`size-3.5 flex-none self-center fill-none stroke-ink3 stroke-[1.6] transition-transform ${p.open ? "rotate-90" : ""}`} aria-hidden="true">
      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A count's status symbol, shown in Cockpit in place of its word ("✓3"
// for "3 done"), and its word, which Cockpit keeps for screen readers only.
function Sym(p: { children: string }) {
  return <span className="hidden cockpit:inline" aria-hidden="true">{p.children}</span>;
}

function Word(p: { children: string }) {
  return <span className="cockpit:sr-only">{p.children}</span>;
}

// A host's or group's counts, so that a closed one still says what it
// holds: how many ask a question, how many finished since last opened,
// how many working, how many.
// Native sets them on pills, Cockpit as symbols.
function Counts(p: { sessions: SessionView[]; news: Set<string> }) {
  const working = p.sessions.filter((s) => s.working || s.compacting).length;
  const fresh = p.sessions.filter((s) => p.news.has(s.id)).length;
  const asking = p.sessions.filter((s) => s.questions?.length).length;
  const pill = "native:rounded-full native:px-[7px] native:py-0.5 native:text-xs";
  return (
    <span className="flex flex-none gap-2.5 text-[12.5px] font-normal tracking-normal text-ink2 normal-case not-italic tabular-nums native:gap-1.5 cockpit:font-mono cockpit:text-xs">
      {asking > 0 && <span className={`font-semibold ${tone.blocked} ${pill} native:bg-block-wash cockpit:font-medium`}><Sym>×</Sym>{asking}<Word> asking</Word></span>}
      {fresh > 0 && <span className={`font-semibold ${tone.done} ${pill} native:bg-done-wash cockpit:font-medium`}><Sym>✓</Sym>{fresh}<Word> new</Word></span>}
      {working > 0 && <span className={`font-semibold ${tone.working} ${pill} native:bg-work-wash cockpit:font-medium`}><Sym>◐</Sym>{working}<Word> working</Word></span>}
      <span className="native:self-center"><Sym>· </Sym>{p.sessions.length}</span>
    </span>
  );
}

// A session: its status, pi's name for it and when it last had a
// message; alone in its window, the window's name above. A search result
// also says where it runs, and marks what matched. One that finished since it was last open is set
// heavier, its time in teal.
function Row(p: { session: SessionView; window?: string; open: (id: string) => void; matched?: Set<number>; news: boolean; now: number; selected?: boolean }) {
  const s = p.session;
  const last = s.last;
  const lines = p.window !== undefined || p.matched !== undefined;
  // Beside the chat, the session open in it is marked.
  const selected = p.selected ? "bg-wash cards:bg-accent-soft cards:shadow-[inset_3px_0_0_var(--accent)] cockpit:shadow-[inset_2px_0_0_var(--accent)]" : "";
  const time = <span className={`text-[13px] tabular-nums cards:font-mono cards:text-[12.5px] native:font-ui native:text-[13px] cockpit:font-mono cockpit:text-xs ${p.news ? `font-bold ${tone.done} cards:font-semibold` : "text-ink2 cards:text-ink3 native:text-ink2 cockpit:text-ink3"}`}>{last ? ago(last.at, p.now) : ""}</span>;
  const name = <span className={`truncate text-base leading-[1.35] cards:text-[15px] native:text-base cockpit:font-mono cockpit:text-sm ${p.news ? "font-bold cards:font-[650] native:font-bold" : "font-medium cards:font-[550] native:font-medium"}`}>{p.matched ? <Marked text={title(s)} offset={0} positions={p.matched} /> : title(s)}</span>;
  return (
    <li>
      <button
        className={`grid min-h-11 w-full scroll-mt-28 scroll-mb-2 grid-cols-[22px_minmax(0,1fr)_auto] focus-visible:-outline-offset-2 focus-visible:rounded-none cards:focus-visible:rounded-[inherit] items-baseline gap-x-2.5 py-1.5 pr-5 pl-4.5 text-left active:bg-wash cards:min-h-12 cards:items-center cards:gap-y-px cards:px-3 cards:py-[9px] native:min-h-14 native:grid-cols-[32px_minmax(0,1fr)_auto] native:gap-x-3 native:pr-4 native:pl-3.5 cockpit:pr-3.5 cockpit:pl-7 ${selected}`}
        onClick={() => p.open(s.id)}
        aria-current={p.selected || undefined}
        data-row
      >
        {p.window !== undefined
          ? <>
            {/* The status and the time go with the name, under the window's. */}
            <span className="col-span-2 col-start-2 row-start-1 truncate text-[13px] leading-[1.4] text-ink2 cards:font-mono cards:text-[12.5px] cards:text-ink3 native:font-ui native:text-[13px] cockpit:font-mono cockpit:text-xs cockpit:text-ink3">{p.window}</span>
            <Status on={s.working} compacting={s.compacting} asks={Boolean(s.questions?.length)} news={p.news} className="col-start-1 row-start-2 w-[22px] text-[15px] leading-[1.35] native:row-span-2 native:row-start-1" />
            <span className="col-start-2 row-start-2 flex min-w-0">{name}</span>
            <span className="col-start-3 row-start-2">{time}</span>
          </>
          : <>
            <Status on={s.working} compacting={s.compacting} asks={Boolean(s.questions?.length)} news={p.news} className={`w-[22px] text-[15px] leading-[1.35] ${lines ? "row-span-2" : ""}`} />
            {name}{time}
          </>}
        {p.matched && <span className="col-span-2 col-start-2 truncate text-[12.5px] text-ink3 cards:font-mono cards:text-xs native:font-ui native:text-[12.5px] cockpit:font-mono cockpit:text-[11.5px]"><Marked text={where(s)} offset={whereAt(s)} positions={p.matched} /></span>}
      </button>
    </li>
  );
}
