// Opening a new pi beside a running one, in its tmux session or herdr
// workspace (docs/design.md, section 4): in that pi's folder, one this
// machine's sessions have used, or one typed in; its window named after
// the folder unless named here. Once the new pi connects, its chat opens.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SessionView } from "../../core/view.ts";
import { afterLayers } from "./layer.ts";
import { live } from "./live.ts";
import { Sheet, SheetGroup, SheetRow } from "./Sheet.tsx";

// How long a new pi has to connect before the sheet stops waiting for it.
const CONNECT_MS = 45_000;

const hostOf = (s: SessionView) => s.hostLabel || s.hostname;

// Where a new pi beside s opens, as the sheet says it.
export function besideWhere(s: SessionView): string {
  return s.place?.group ? `${s.place.group} on ${hostOf(s)}` : hostOf(s);
}

// The session a group's new pi opens beside: the most recent one that can.
export function launchable(sessions: SessionView[]): SessionView | undefined {
  return sessions.filter((s) => s.launcher).sort((a, b) => (b.last?.at ?? b.startedAt ?? 0) - (a.last?.at ?? a.startedAt ?? 0))[0];
}

// The window name a folder gives: its last part ("" for ~ or /, which
// leaves it to the multiplexer).
export function folderName(cwd: string): string {
  const last = cwd.replace(/\/+$/, "").split("/").pop() ?? "";
  return last === "~" ? "" : last;
}

const field = "min-w-0 flex-1 border-b-[1.5px] border-ink bg-transparent py-2 text-[15px] text-ink outline-none placeholder:text-ink3 cards:min-h-11 cards:rounded-xl cards:border cards:border-rule cards:bg-card cards:px-3.5 cards:py-0 cards:focus:border-accent cockpit:min-h-11 cockpit:rounded-lg cockpit:border cockpit:border-rule cockpit:bg-card cockpit:px-3 cockpit:py-0 cockpit:focus:border-accent";

export function LaunchSheet(p: { beside: SessionView; close: () => void; open: (id: string) => void }) {
  const s = p.beside;
  const { sessions } = useSyncExternalStore(live.subscribe, live.getState);
  const [past, setPast] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<{ kind: "choosing" } | { kind: "starting"; requestId: string; cwd: string } | { kind: "failed"; message: string }>({ kind: "choosing" });
  const opened = useRef(false);

  // The folders of the host's sessions, live, then saved, newest first.
  useEffect(() => {
    let current = true;
    live.command(s.id, "past", { allFolders: true }).then((r) => {
      if (current && r.ok && r.result.kind === "pastSessions") setPast(r.result.sessions.map((x) => x.cwd));
    }, () => {});
    return () => {
      current = false;
    };
  }, [s.id]);
  const here = sessions.filter((x) => hostOf(x) === hostOf(s) && x.id !== s.id).map((x) => x.cwd);
  const folders = [...new Set([s.cwd, ...here, ...past].filter(Boolean))];

  // The new pi, once it has connected.
  const started = state.kind === "starting" ? sessions.find((x) => x.launchId === state.requestId) : undefined;
  useEffect(() => {
    if (!started || opened.current) return;
    opened.current = true;
    p.close();
    const id = started.id;
    afterLayers(() => p.open(id));
    // Once, when it appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);
  useEffect(() => {
    if (state.kind !== "starting") return;
    const t = setTimeout(() => setState({ kind: "failed", message: `pi opened in ${state.cwd} but has not connected yet; it shows in the list once it does.` }), CONNECT_MS);
    return () => clearTimeout(t);
  }, [state]);

  const launch = async (cwd: string) => {
    const requestId = crypto.randomUUID();
    setState({ kind: "starting", requestId, cwd });
    try {
      const r = await live.command(s.id, "launch", { cwd, name: name.trim() || folderName(cwd), requestId });
      if (!r.ok) setState({ kind: "failed", message: r.message });
    } catch (e) {
      setState({ kind: "failed", message: (e as Error).message });
    }
  };

  const say = (text: string, bad = false) => <p className={`px-5 pb-3 text-[14.5px] cards:px-3.5 ${bad ? "text-block" : "text-ink2"}`} role={bad ? "alert" : undefined}>{text}</p>;
  const starting = state.kind === "starting";
  return (
    <Sheet title="New agent" sub={`Beside this one, in ${besideWhere(s)}`} done="Done" close={p.close}>
      {starting && say(`Opening pi in ${state.cwd}…`)}
      {state.kind === "failed" && say(state.message, true)}
      <div className="flex px-5 pb-3 cards:px-3.5">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Window name"
          placeholder="Window name (the folder's if empty)"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={starting}
          className={field}
        />
      </div>
      <SheetGroup>
        {folders.map((f, i) => <SheetRow key={f} label={f} sub={i === 0 ? "This agent's folder" : undefined} disabled={starting} onClick={() => void launch(f)} />)}
      </SheetGroup>
      <form className="flex gap-2.5 px-5 pt-1 cards:px-3.5" onSubmit={(e) => {
        e.preventDefault();
        if (typed.trim() && !starting) void launch(typed.trim());
      }}>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          aria-label="Another folder"
          placeholder="Another folder: ~/src/…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          className={`${field} font-mono`}
        />
        <button className="min-h-11 rounded-full px-4 text-[15px] font-semibold text-paper bg-ink disabled:opacity-40 cards:rounded-[12px] cards:bg-accent cards:text-on-accent cockpit:rounded-[10px] cockpit:bg-accent cockpit:text-on-accent" disabled={!typed.trim() || starting}>Open</button>
      </form>
    </Sheet>
  );
}
