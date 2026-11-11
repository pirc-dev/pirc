// The page's screens: pairing, signing in, the session list and a chat;
// on a screen as wide as a laptop's, the list and the chat side by side.
// Routing is the address bar's path: /, /h/<host>, /h/<host>/<group>,
// /s/<session ID>, /settings and /pair.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Chat } from "./Chat.tsx";
import { live } from "./live.ts";
import { Mark, Pair, SignIn } from "./SignIn.tsx";
import { type Scope, scopePath, Sessions } from "./Sessions.tsx";
import { Settings } from "./Settings.tsx";
import { check } from "./update.ts";

function usePath(): [string, (p: string) => void] {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  // The screen follows even when the address is there already (pairing
  // replaces its own address before it is done).
  const go = (p: string) => {
    if (p !== location.pathname) history.pushState(null, "", p);
    setPath(p);
  };
  return [path, go];
}

// The session an address names; none for a malformed one, which would
// otherwise throw and blank the page.
function chatOf(path: string): string | undefined {
  if (!path.startsWith("/s/")) return undefined;
  try {
    return decodeURIComponent(path.slice(3)) || undefined;
  } catch {
    return undefined;
  }
}

// The list an address names: one host's (/h/<host>), one group's of it
// (/h/<host>/<group>), or every session's.
function scopeOf(path: string): Scope | undefined {
  if (path === "/") return {};
  const m = /^\/h\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (!m) return undefined;
  try {
    return { host: decodeURIComponent(m[1]), ...(m[2] ? { group: decodeURIComponent(m[2]) } : {}) };
  } catch {
    return undefined;
  }
}

export function App() {
  const state = useSyncExternalStore(live.subscribe, live.getState);
  const [path, go] = usePath();
  const chatId = chatOf(path);
  const settings = path === "/settings";
  // A chat goes back to the list it was opened from, and on a laptop that
  // list stays beside it.
  const list = useRef("/");
  if (!chatId && scopeOf(path)) list.current = path;
  // Settings goes back to the chat or list it was opened from.
  const before = useRef("/");
  if (!settings) before.current = path;
  const scope = scopeOf(list.current) ?? {};
  const wide = useWide();

  useEffect(() => {
    void live.start();
  }, []);
  useEffect(() => {
    if (state.signedIn) void live.watch(chatId);
  }, [state.signedIn, chatId]);
  // A notification tapped while the app is open opens its chat here
  // (public/sw.js).
  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const on = (e: MessageEvent) => {
      const to = (e.data as { open?: unknown } | null)?.open;
      if (typeof to === "string" && to.startsWith("/")) go(to);
    };
    sw.addEventListener("message", on);
    return () => sw.removeEventListener("message", on);
    // go keeps no state of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A stream open again may be a server deployed anew.
  useEffect(() => {
    if (state.stream === "open") void check();
  }, [state.stream]);

  if (path === "/pair") return <Pair done={() => go("/")} />;
  if (state.signedIn === undefined) return <Splash />;
  if (!state.signedIn) return <SignIn />;
  const session = chatId ? state.sessions.find((s) => s.id === chatId) : undefined;
  return (
    <Layout
      wide={wide}
      banner={<Banner relay={state.relay.state} reason={state.relay.reason} stream={state.stream} />}
      list={<Sessions key={list.current} sessions={state.sessions} pendingHosts={state.pendingHosts} scope={scope} open={(id) => go(`/s/${encodeURIComponent(id)}`)} go={(s) => go(scopePath(s))} selected={chatId} settings={() => go(settings ? before.current : "/settings")} inSettings={settings} />}
      chat={settings ? <Settings back={() => go(before.current)} wide={wide} devices={state.devices} connected={state.relay.state === "ready"} /> : chatId ? <Chat key={chatId} id={chatId} session={session} chat={state.chat} back={() => go(list.current)} wide={wide} open={(id) => go(`/s/${encodeURIComponent(id)}`)} /> : undefined}
    />
  );
}

// Wide enough for the list and a chat side by side.
const WIDE = "(min-width: 1024px)";
export function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const m = matchMedia(WIDE);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

// On a phone, the list or the chat; wide, the list beside the chat (or
// beside a word on what to do, before one is chosen). Both are in the same
// place either way, so that crossing the width (a tablet turned, a window
// resized) keeps the chat's draft and the list's search; on a phone the
// list is only hidden while a chat is open.
export function Layout(p: { wide: boolean; banner: React.ReactNode; list: React.ReactNode; chat: React.ReactNode | undefined }) {
  return (
    <div className="flex h-dvh flex-col bg-paper pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-ink">
      {p.banner}
      <div className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] ${p.wide ? "grid-cols-[380px_1fr]" : "grid-cols-1"}`}>
        <div className={`min-h-0 flex-col ${p.wide ? "flex border-r border-rule" : p.chat ? "hidden" : "flex"}`}>{p.list}</div>
        {(p.wide || p.chat) && (
          <div className={`flex min-h-0 min-w-0 flex-col ${p.wide ? "cards:bg-card" : ""}`}>
            {p.chat ?? <p className="m-auto font-read text-lg text-ink3 italic cards:text-base cards:text-ink2 cards:not-italic cockpit:font-mono cockpit:text-sm cockpit:not-italic">Choose a session to see its chat.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export function Splash() {
  return <div className="flex h-dvh items-center justify-center bg-paper"><Mark /></div>;
}

export function Banner(p: { relay: string; reason?: string; stream: string }) {
  let text: string | undefined;
  let refused = false;
  if (p.stream !== "open") text = "Connecting to the server…";
  else if (p.relay === "refused") {
    text = `The relay refused this server${p.reason ? `: ${p.reason}` : ""}`;
    refused = true;
  } else if (p.relay !== "ready") text = `Reconnecting to the relay${p.reason ? `: ${p.reason}` : "…"}`;
  if (!text) return null;
  return (
    <div className={`flex flex-none items-center gap-2.5 border-b border-rule px-5 py-2.5 text-sm cards:mx-3 cards:mt-1.5 cards:mb-1 cards:rounded-[10px] cards:border-0 cards:px-3 cards:text-[13.5px] native:mx-0 native:mt-0 native:mb-0 native:rounded-none native:px-4 native:font-medium cockpit:px-3.5 cockpit:py-2 cockpit:font-mono cockpit:text-[12.5px] ${refused ? "bg-block-wash text-block" : "bg-work-wash text-work"}`} role="status">
      {refused ? <span className="font-mono font-semibold">×</span> : <span className="size-3 flex-none animate-spin rounded-full border-[1.5px] border-current border-r-transparent" />}
      {text}
    </div>
  );
}
