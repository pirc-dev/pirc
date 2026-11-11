// The session's sheets: its actions, resuming a saved session, switching
// branches, and going back or forking from a message.
import { useEffect, useState } from "react";
import { THINKING_NAMES } from "@pirc/protocol";
import type { Branch, ModelChoice, PastSession } from "../../core/results.ts";
import type { SessionView, UserItem } from "../../core/view.ts";
import { live } from "./live.ts";
import { Icon } from "./icons.tsx";
import { useLayer } from "./layer.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { ago, title, where, windowOf } from "./names.ts";
import { useNow } from "./time.ts";
import { Answers, Sheet, SheetGroup, SheetRow } from "./Sheet.tsx";
import { type Run } from "./chat.ts";
import { besideWhere, LaunchSheet } from "./Launch.tsx";

// Short enough for all seven to fit one row on a phone.
const SHORT: Record<string, string> = { minimal: "min", medium: "med" };

// Whether the session's extension moves in pi's tree. The announcement
// lists requests by their field names; one that lists none is asked
// anyway, and says if it cannot.
const takes = (s: SessionView, request: string) => !s.requests || s.requests.includes(request);
const movesInTree = (s: SessionView) => takes(s, "navigate_tree");

// What can be done from one of the user's messages: going back to before
// it, in this session, or forking a new session there. Either gives the
// message back to edit and send.
export type FromMessage = "back" | "summary" | "fork";
export function MessageSheet(p: { session: SessionView; item: UserItem; close: () => void; go: (how: FromMessage) => void }) {
  const s = p.session;
  const busy = s.working || s.compacting;
  return (
    <Sheet title="From this message" close={p.close}>
      <p className="mx-5 mb-3 line-clamp-3 border-l-2 border-rule pl-3 font-read text-[15.5px] leading-snug whitespace-pre-wrap text-ink2">{p.item.text}</p>
      {busy && <p className="px-5 pb-3 text-[14px] text-ink2 cards:px-3.5">pi is working; stop it first.</p>}
      <SheetGroup>
        {movesInTree(s) && (
          <>
            <SheetRow label="Go back to here" sub="Carry on from before it; what came after stays as a branch" disabled={busy} onClick={() => p.go("back")} />
            <SheetRow label="Go back with a summary" sub="pi also summarises what came after, for the model" disabled={busy} onClick={() => p.go("summary")} />
          </>
        )}
        <SheetRow label="Fork from here" sub={`A new session${windowOf(s) ? ` in ${windowOf(s)}` : ""} with what came before it`} disabled={busy} onClick={() => p.go("fork")} />
      </SheetGroup>
    </Sheet>
  );
}

// The session's actions, in a sheet, with what the session has cost so far
// and how full its context is. New session and Rename ask in it.
export function Actions(p: {
  session: SessionView;
  run: Run;
  close: () => void;
  say: (s: string) => void;
  // Opens a session's chat: a new agent's, once it has connected.
  open?: (id: string) => void;
}) {
  const [models, setModels] = useState<ModelChoice[]>();
  const [cost, setCost] = useState<string>();
  const [picking, setPicking] = useState(false);
  const picker = useLayer(picking, () => setPicking(false));
  const [mode, setMode] = useState<"menu" | "new" | "rename" | "resume" | "branches" | "stop" | "launch">("menu");
  const [name, setName] = useState(p.session.name);
  const s = p.session;
  useEffect(() => {
    void p.run("models", {}).then((r) => {
      if (r?.ok && r.result.kind === "models") setModels(r.result.models);
    });
    // Quietly: the sheet works without it.
    void live.command(s.id, "stats", {}).then((r) => {
      if (r.ok && r.result.kind === "stats") {
        const st = r.result;
        const pct = st.contextWindow > 0 && st.contextTokens !== undefined ? ` · ${Math.round((st.contextTokens / st.contextWindow) * 100)}%` : "";
        setCost(`$${st.cost.toFixed(2)}${pct}`);
      }
    }, () => {});
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const current = s.model ? `${s.model.provider}/${s.model.id}` : "";
  const busy = s.working || s.compacting;
  const act: Run = async (name, body) => {
    p.close();
    return p.run(name, body);
  };
  if (mode === "new") {
    return (
      <Sheet key="new" title="Start a new session?" close={p.close}>
        <div className="flex flex-col gap-3.5 px-5">
          <p className="font-read text-[17px] leading-relaxed text-ink2 cards:text-[15.5px] cockpit:text-[15px]">
            pi starts an empty conversation{windowOf(s) ? <> in <i>{windowOf(s)}</i></> : ""}. This one stays in pi's history, to resume later.
          </p>
          <Answers cancel={() => setMode("menu")} label="New session" danger disabled={busy} go={() => void act("new", {})} />
        </div>
      </Sheet>
    );
  }
  if (mode === "stop") {
    return (
      <Sheet key="stop" title="Stop pi?" close={p.close}>
        <div className="flex flex-col gap-3.5 px-5">
          <p className="font-read text-[17px] leading-relaxed text-ink2 cards:text-[15.5px] cockpit:text-[15px]">
            pi quits, as it does at its terminal{windowOf(s) ? <>; <i>{windowOf(s)}</i> closes if pi was all it ran</> : ""}. The conversation stays in pi's history, to resume later.
          </p>
          {busy && <p className="text-[14px] text-ink2">pi is working; stop the turn first.</p>}
          <Answers cancel={() => setMode("menu")} label="Stop pi" danger disabled={busy} go={async () => {
            p.close();
            const r = await live.command(s.id, "stop", {}).catch((e: Error) => ({ ok: false as const, code: "", message: e.message }));
            // An answer lost as pi exits is still a stop.
            if (r.ok || r.code === "SESSION_GONE") p.say("pi has stopped");
            else p.say(`${r.code ? `${r.code}: ` : ""}${r.message}`);
          }} />
        </div>
      </Sheet>
    );
  }
  if (mode === "launch") return <LaunchSheet beside={s} close={p.close} open={(id) => p.open?.(id)} />;
  if (mode === "resume") {
    return (
      <Resume session={s} close={p.close} go={async (x) => {
        p.close();
        const r = await p.run("resume", { path: x.path });
        if (r?.ok) p.say(`Resumed ${pastTitle(x)}`);
      }} />
    );
  }
  if (mode === "branches") {
    return (
      <Branches session={s} close={p.close} go={async (x, summarize) => {
        p.close();
        const r = await p.run("tree", { entryId: x.leafId, summarize });
        if (r?.ok) p.say(`Switched to the branch ${branchTitle(x)}`);
      }} />
    );
  }
  if (mode === "rename") {
    return (
      <Sheet key="rename" title="Rename" sub="pi's name for the session, which the list shows" top close={p.close}>
        <form className="flex flex-col gap-3.5 px-5" onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void act("rename", { name });
        }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Session name"
            placeholder={title(s)}
            enterKeyHint="done"
            className="border-b-[1.5px] border-ink bg-transparent py-2 font-read text-xl outline-none placeholder:text-ink3 cockpit:min-h-11 cockpit:rounded-lg cockpit:border cockpit:border-rule cockpit:bg-card cockpit:px-3 cockpit:py-0 cockpit:font-mono cockpit:text-base cockpit:focus:border-accent cards:min-h-12 cards:rounded-xl cards:border cards:border-rule cards:bg-card cards:px-3.5 cards:py-0 cards:text-base cards:focus:border-accent"
          />
          <Answers cancel={() => setMode("menu")} label="Rename" disabled={!name.trim()} go={() => void act("rename", { name })} />
        </form>
      </Sheet>
    );
  }
  return (
    <Sheet key="menu" title={title(s)} sub={where(s)} done="Done" close={p.close}>
      <SheetGroup>
        <SheetRow
          label="Model"
          value={<span className="flex items-center gap-1.5 text-[15px] text-ink2"><code className="font-mono text-[13.5px] text-ink">{s.model ? s.model.name || s.model.id : "—"}</code><Icon name="chevron" /></span>}
          onClick={() => {
            picker.show();
            setPicking(true);
          }}
        />
        <div className="flex flex-col gap-2 border-t border-rule px-5 py-3 cards:px-3.5">
          <span className="text-base">Thinking level</span>
          <div className="-mx-1.5 grid grid-cols-7 gap-0.5 cards:mx-0 cards:rounded-[10px] cards:bg-wash cards:p-[3px] cockpit:mx-0 cockpit:gap-1" role="group" aria-label="Thinking level">
            {THINKING_NAMES.map((l) => (
              <button
                key={l}
                aria-pressed={s.thinking === l}
                aria-label={l}
                className="min-h-9 rounded-full text-[14px] text-ink2 aria-pressed:bg-ink aria-pressed:font-semibold aria-pressed:text-paper cards:rounded-[7px] cards:text-[12.5px] cards:aria-pressed:bg-accent cards:aria-pressed:text-on-accent cockpit:rounded-[5px] cockpit:font-mono cockpit:text-xs cockpit:ring-1 cockpit:ring-rule cockpit:ring-inset cockpit:aria-pressed:bg-accent cockpit:aria-pressed:font-bold cockpit:aria-pressed:text-on-accent cockpit:aria-pressed:ring-accent"
                onClick={() => (s.thinking === l ? p.close() : void act("thinking", { level: l }))}
              >
                {SHORT[l] ?? l}
              </button>
            ))}
          </div>
        </div>
      </SheetGroup>
      <SheetGroup>
        <SheetRow label="Cost and context" value={cost && <span className="text-[14.5px] text-ink2 tabular-nums">{cost}</span>} onClick={async () => {
          p.close();
          const r = await p.run("stats", {});
          if (r?.ok && r.result.kind === "stats") {
            const st = r.result;
            const ctx = st.contextWindow === 0 ? "unknown" : st.contextTokens === undefined
              ? `unknown until the next reply, of ${st.contextWindow.toLocaleString()} tokens`
              : `**${((st.contextTokens / st.contextWindow) * 100).toFixed(1)}%**, ${st.contextTokens.toLocaleString()} of ${st.contextWindow.toLocaleString()} tokens`;
            const cost = st.cost < 0.1 ? st.cost.toFixed(4) : st.cost.toFixed(2);
            p.say(`**$${cost}** so far · ${st.input.toLocaleString()} in, ${st.output.toLocaleString()} out, ${st.cacheRead.toLocaleString()} cached\n\nContext ${ctx}`);
          }
        }} />
        <SheetRow label="Compact" sub="Summarise the conversation to free context" disabled={busy} onClick={() => void act("compact", {})} />
        <SheetRow label="Rename" onClick={() => setMode("rename")} />
        <SheetRow label="Reload" sub="Load pi's extensions, skills, prompts and context files again" disabled={busy} onClick={async () => {
          p.close();
          const r = await p.run("reload", {});
          if (r?.ok) p.say("pi is reloading; the session carries on");
        }} />
      </SheetGroup>
      <SheetGroup>
        <SheetRow label="Clone" sub="Carry on in a copy; this one stays in pi's history" disabled={busy} onClick={async () => {
          p.close();
          const r = await p.run("clone", {});
          if (r?.ok) p.say("Now in a copy of the session; the original stays in pi's history");
        }} />
        {movesInTree(s) && <SheetRow label="Branches" sub="Switch to another branch of this conversation" disabled={busy} onClick={() => setMode("branches")} />}
        <SheetRow label="Resume" sub="Go back to a session pi has saved" disabled={busy} onClick={() => setMode("resume")} />
        <SheetRow label="New session" danger disabled={busy} onClick={() => setMode("new")} />
      </SheetGroup>
      <SheetGroup>
        {s.launcher && p.open && <SheetRow label="New agent" sub={`Another pi beside this one, in ${besideWhere(s)}`} onClick={() => setMode("launch")} />}
        {takes(s, "stop") && <SheetRow label="Stop pi" sub="Quit this pi; the conversation stays in its history" danger disabled={busy} onClick={() => setMode("stop")} />}
      </SheetGroup>
      {picking && (
        <ModelPicker
          models={models}
          current={s.model}
          close={picker.close}
          pick={(m) => {
            if (`${m.provider}/${m.id}` !== current) void act("model", { provider: m.provider, id: m.id });
            else p.close();
          }}
        />
      )}
    </Sheet>
  );
}

const pastTitle = (x: PastSession) => x.name || x.firstPrompt || "An empty session";

// The sessions pi has saved, to go back to one: those of the session's
// folder, or of every folder. pi moves to the folder of the one picked.
function Resume(p: { session: SessionView; close: () => void; go: (x: PastSession) => void }) {
  const [all, setAll] = useState(false);
  type Listed = { all: boolean } & ({ sessions: PastSession[]; truncated: boolean } | { error: string });
  const [listed, setListed] = useState<Listed>();
  const now = useNow();
  const s = p.session;
  useEffect(() => {
    let current = true;
    live.command(s.id, "past", { allFolders: all }).then((r) => {
      if (!current) return;
      if (r.ok && r.result.kind === "pastSessions") setListed({ all, sessions: r.result.sessions, truncated: r.result.truncated });
      else setListed({ all, error: r.ok ? "an unexpected answer" : r.message });
    }, (e) => current && setListed({ all, error: (e as Error).message }));
    return () => {
      current = false;
    };
  }, [s.id, all]);
  const busy = s.working || s.compacting;
  const shown = listed?.all === all ? listed : undefined;
  const scope = (value: boolean, label: string) => (
    <button
      aria-pressed={all === value}
      className="min-h-9 flex-1 rounded-full text-[14px] text-ink2 aria-pressed:bg-ink aria-pressed:font-semibold aria-pressed:text-paper cards:rounded-[7px] cards:text-[13px] cards:aria-pressed:bg-accent cards:aria-pressed:text-on-accent"
      onClick={() => setAll(value)}
    >
      {label}
    </button>
  );
  const say = (text: string) => <p className="px-5 py-3 text-[14.5px] text-ink2 cards:px-3.5">{text}</p>;
  return (
    <Sheet key="resume" title="Resume" sub={all ? "Sessions pi has saved, in every folder" : s.cwd} done="Done" close={p.close}>
      <div className="mx-5 mb-3 flex gap-0.5 cards:mx-3 cards:rounded-[10px] cards:bg-wash cards:p-[3px]" role="group" aria-label="Which sessions">
        {scope(false, "This folder")}
        {scope(true, "All folders")}
      </div>
      {busy && say("pi is working; stop it first.")}
      {!shown ? say("Loading…") : "error" in shown ? say(`pi could not list its sessions: ${shown.error}`) : shown.sessions.length === 0 ? say(all ? "pi has no other saved sessions." : "pi has no other saved sessions in this folder.") : (
        <SheetGroup>
          {shown.sessions.map((x) => (
            <SheetRow
              key={x.path}
              label={pastTitle(x)}
              sub={[ago(x.modified, now), x.messages === 1 ? "1 message" : `${x.messages} messages`, all && x.cwd !== s.cwd ? x.cwd : ""].filter(Boolean).join(" · ")}
              disabled={busy}
              onClick={() => p.go(x)}
            />
          ))}
        </SheetGroup>
      )}
      {shown && "truncated" in shown && shown.truncated && say("Older sessions are left out.")}
    </Sheet>
  );
}

const branchTitle = (x: Branch) => (x.prompt ? `“${x.prompt}”` : x.messages > 0 ? "with no prompt" : "before the first message");

// The conversation's branches, to switch to one: the current one first,
// then the others, the newest first, each by its first prompt after it
// leaves this one. Switching asks whether pi should summarise the branch
// left, as going back from a message does.
function Branches(p: { session: SessionView; close: () => void; go: (x: Branch, summarize: boolean) => void }) {
  type Listed = { branches: Branch[]; truncated: boolean } | { error: string };
  const [listed, setListed] = useState<Listed>();
  const [picked, setPicked] = useState<Branch>();
  const now = useNow();
  const s = p.session;
  useEffect(() => {
    let current = true;
    live.command(s.id, "branches", {}).then((r) => {
      if (!current) return;
      if (r.ok && r.result.kind === "tree") setListed({ branches: r.result.branches, truncated: r.result.truncated });
      else setListed({ error: r.ok ? "an unexpected answer" : r.message });
    }, (e) => current && setListed({ error: (e as Error).message }));
    return () => {
      current = false;
    };
  }, [s.id]);
  const busy = s.working || s.compacting;
  const say = (text: string) => <p className="px-5 py-3 text-[14.5px] text-ink2 cards:px-3.5">{text}</p>;
  const facts = (x: Branch) => [ago(x.modified, now), x.messages === 1 ? "1 message" : `${x.messages} messages`].join(" · ");
  if (picked) {
    return (
      <Sheet key="switch" title="Switch to this branch?" close={p.close}>
        <div className="mx-5 mb-3 border-l-2 border-rule pl-3 text-ink2">
          <p className="line-clamp-2 font-read text-[15.5px] leading-snug">{branchTitle(picked)}</p>
          {picked.last && picked.last !== picked.prompt && <p className="mt-1 line-clamp-2 text-[13.5px]">{picked.last}</p>}
        </div>
        {busy && say("pi is working; stop it first.")}
        <SheetGroup>
          <SheetRow label="Switch" sub="This branch stays, to come back to" disabled={busy} onClick={() => p.go(picked, false)} />
          <SheetRow label="Switch with a summary" sub="pi also summarises this branch, for the model" disabled={busy} onClick={() => p.go(picked, true)} />
        </SheetGroup>
      </Sheet>
    );
  }
  const others = listed && "branches" in listed ? listed.branches.filter((x) => !x.current) : [];
  const current = listed && "branches" in listed ? listed.branches.find((x) => x.current) : undefined;
  return (
    <Sheet key="branches" title="Branches" sub="Where the conversation went another way" done="Done" close={p.close}>
      {busy && say("pi is working; stop it first.")}
      {!listed ? say("Loading…") : "error" in listed ? say(`pi could not list the branches: ${listed.error}`) : (
        <>
          {current && (
            <SheetGroup>
              <SheetRow label={current.messages > 0 ? branchTitle(current) : "Before the first message"} sub={`This one · ${facts(current)}`} disabled />
            </SheetGroup>
          )}
          {others.length === 0 ? say("No other branches: nothing has been gone back from yet.") : (
            <SheetGroup>
              {others.map((x) => <SheetRow key={x.leafId} label={branchTitle(x)} sub={[facts(x), x.last !== x.prompt ? x.last : ""].filter(Boolean).join(" · ")} disabled={busy} onClick={() => setPicked(x)} />)}
            </SheetGroup>
          )}
          {listed.truncated && say("Older branches are left out.")}
        </>
      )}
    </Sheet>
  );
}
