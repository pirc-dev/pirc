// The page's screens with made-up content, for looking at the design
// without a relay, a pi or a sign-in: every state at once, which the demo
// cannot easily produce (docs/testing.md). Served by `vite` in development
// only, at /gallery.html?screen=…; never part of the built page. Requests
// the screens make are answered here, from the same made-up content.
// &look=quiet, triage, native or cockpit chooses the look, as the switch
// in Settings does; screen=settings opens Settings.
import "./fonts.ts";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import type { Answer, Body, CommandName } from "../../core/api.ts";
import type { ModelChoice } from "../../core/results.ts";
import type { ChatItem, ChatView, DeviceView, ImageView, PendingHostView, QuestionView, SessionView } from "../../core/view.ts";
import { Banner, Layout, Splash, useWide } from "./App.tsx";
import { Chat } from "./Chat.tsx";
import "./index.css";
import { api, live } from "./live.ts";
import { applyLook, isLook, setLook } from "./look.ts";
import { type Scope, scopePath, Sessions } from "./Sessions.tsx";
import { Settings } from "./Settings.tsx";
import { Pair, SignIn } from "./SignIn.tsx";

const now = Date.now();
const min = 60_000;
let n = 0;
// Windows numbered as a terminal would, each its own across a host's group.
const numbers = new Map<string, number>();
const session = (host: string, group: string | undefined, window: string, o: Partial<SessionView> & { said?: string; you?: boolean; ago?: number } = {}): SessionView => {
  const key = `${host}/${group}/${window}`;
  if (!numbers.has(key)) numbers.set(key, numbers.size);
  return {
    id: `s${n}`,
    sessionId: `pi-${n++}`,
    hostLabel: host,
    hostname: host,
    name: "",
    cwd: `~/src/${window}`,
    model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
    thinking: "medium",
    working: false,
    compacting: false,
    piVersion: "0.70.0",
    extensionVersion: "0.1.0",
    place: { kind: "tmux", ...(group ? { group } : {}), window, windowNumber: numbers.get(key) },
    // In tmux, a pi can open another beside it.
    ...(group ? { launcher: "tmux" } : {}),
    ...(o.said ? { last: { who: o.you ? "user" : "assistant", text: o.said, at: now - (o.ago ?? 5) * min } } : {}),
    ...o,
  };
};

// Named by pi's /name, or else by the first message; two windows hold
// two agents each.
const sessions: SessionView[] = [
  session("studio", "work", "api", { name: "Migrations for orgs", said: "All 42 tests pass. I left the migration unapplied.", ago: 12 }),
  session("studio", "work", "api", { first: "Why is the users endpoint slow on cold start?", said: "The pool warms on first request; I moved it to boot.", ago: 40 }),
  session("studio", "work", "web", { name: "Bundle diet", said: "The bundle is down to 182 kB. Open a PR?", ago: 3 }),
  session("studio", "work", "relay", { name: "Reconnect after sleep", working: true, said: "Go with B and add a test for it", you: true, ago: 1 }),
  session("studio", "work", "relay", { first: "Review the relay's half-open handling", working: true, said: "Reading the passkey code next.", ago: 2 }),
  session("studio", "work", "docs", { first: "Tidy the README's install section", said: "thanks, that's all for today", you: true, ago: 180 }),
  session("studio", "work", "billing", { name: "Invoice template", said: "Updated the invoice template and its snapshot.", ago: 60 * 24 * 2 }),
  session("studio", "infra", "backups", { name: "Restic check", said: "Restic snapshot verified: 2.1 GB, 0 errors.", ago: 25 }),
  session("studio", "infra", "terraform", { first: "Plan the DNS changes for the new relay", compacting: true, said: "Planning 3 changes to dns.tf", ago: 1 }),
  session("studio", "infra", "grafana", { name: "Relay latency panel", said: "Added the relay latency panel.", ago: 300 }),
  session("studio", "notes", "journal", { first: "Add Sunday's entry", said: "Added Sunday's entry.", ago: 60 * 24 }),
  session("laptop", "main", "pirc", { name: "Deploy pipeline", said: "Pushed to master; the deploy is green.", ago: 60 }),
  session("laptop", "main", "blog", { first: "Draft a post about sleepy sockets", working: true, said: "Writing the post about sleepy sockets.", ago: 0 }),
  session("laptop", "main", "photos", { name: "Photo import", said: "keep the originals", you: true, ago: 300 }),
  session("laptop", "main", "scripts", { first: "Add a dry-run flag to sync.sh", said: "Added --dry-run to sync.sh.", ago: 60 * 24 * 10 }),
  session("build-box", "ci", "runners", { name: "arm64 runners", working: true, said: "Rebuilding the arm64 image.", ago: 4 }),
  session("build-box", "ci", "cache", { first: "Why did the cache hit rate drop?", said: "The cache hit rate is back to 94%.", ago: 90 }),
  session("build-box", "bench", "rel-bench", { name: "Reconnect bench", said: "p95 reconnect is 0.8 s on arm64.", ago: 60 * 24 * 3 }),
  session("build-box", undefined, "~/sandbox", { cwd: "~/sandbox" }),
];
// Finished since last opened: their latest message is newer than what this
// browser read, which is nothing, so mark the rest read.
const fresh = new Set(["Migrations for orgs", "Bundle diet", "Restic check", "Deploy pipeline"]);
try {
  const seen: Record<string, number> = {};
  for (const s of sessions) if (s.last) seen[s.id] = fresh.has(s.name) ? s.last.at - 1 : s.last.at;
  localStorage.setItem("pirc.seen", JSON.stringify(seen));
  localStorage.setItem("pirc.sessions.open", JSON.stringify(["h:studio", "h:laptop", "h:build-box", "g:studio/work", "g:studio/infra", "g:build-box/ci"]));
} catch {
  // Shown without.
}

let i = 0;
const at = () => now - 30 * min + i++ * 20_000;
const user = (text: string, images: ImageView[] = []): ChatItem => ({ kind: "user", id: `i${i}`, turnId: "", at: at(), text, images });
const reply = (text: string, o: Partial<Extract<ChatItem, { kind: "assistant" }>> = {}): ChatItem =>
  ({ kind: "assistant", id: `i${i}`, turnId: "", at: at(), blocks: [{ kind: "text", text }], streaming: false, stop: "stop", ...o });
type Facts = { durationMs?: number; exitCode?: number; diff?: string };
const tool = (name: string, args: Record<string, unknown>, result?: string, isError = false, progress?: string, facts: Facts = {}): ChatItem =>
  ({ kind: "tool", id: `i${i}`, turnId: "", at: at(), name, args: JSON.stringify(args), ...(progress ? { progress } : {}), ...(result !== undefined ? { result: { text: result, isError, ...facts } } : {}) });

const patch = `--- src/relay/socket.ts
+++ src/relay/socket.ts
@@ -84,7 +84,11 @@ export function onClose(socket: Socket) {
   socket.on("close", (code) => {
-    if (code === 4409) return; // gives up
-    scheduleReconnect(backoff.next());
+    if (code === 4409) {
+      // Replaced by a newer connection: reconnect at once.
+      return scheduleReconnect(0);
+    }
+    scheduleReconnect(backoff.next());
   });
 }`;

const answer = `### What happens

The laptop's socket stays half-open while it sleeps. The relay holds it for 90 seconds, so your phone's new connection is refused with \`4409\`, and the client stops trying:

\`\`\`ts src/relay/socket.ts
socket.on("close", (code) => {
  if (code === 4409) return; // gives up
  scheduleReconnect(backoff.next());
});
\`\`\`

| Option | Change | Reconnect | Risk | Effort |
|---|---|--:|---|--:|
| A | Ping every 15 s | ≤ 15 s | More traffic | 1 h |
| B | Replace the old connection on a duplicate | < 1 s | The old tab loses its stream | 3 h |
| C | Resume token | < 1 s | Protocol change | 2 d |

1. **A** is the smallest change but leaves a 15 second gap.
2. **B** fixes the reconnect at once; the old tab is closed with a reason.
3. **C** is the cleanest, but every client needs an update.

> RFC 6455 §7.4 lists the close codes.

I would start with **B**; see [the RFC](https://www.rfc-editor.org/rfc/rfc6455#section-7.4).`;

const finished: ChatItem[] = [
  user("Why does my phone stop getting updates after the laptop sleeps?"),
  { kind: "assistant", id: `i${i}`, turnId: "", at: at(), blocks: [{ kind: "thinking", text: "The close code 4409 means a duplicate connection. The client treats it as final. Check the relay's half-open handling." }], streaming: false, stop: "tool_use" },
  tool("grep", { pattern: "4409", path: "src/relay" }, "src/relay/socket.ts:88:  if (code === 4409) return;", false, undefined, { durationMs: 38 }),
  // As pi sends them: an empty message of its own before each call.
  reply("", { stop: "tool_use", blocks: [] }),
  tool("read", { path: "src/relay/socket.ts" }, "…120 lines…", false, undefined, { durationMs: 12 }),
  reply(answer),
];

const working: ChatItem[] = [
  ...finished,
  { kind: "compaction", id: `i${i}`, turnId: "", at: at(), summary: "The user asked why updates stop after sleep; the relay refuses duplicates with 4409 and the client gives up. Three options were compared; B chosen.", tokensBefore: 182_000 },
  { kind: "branchSummary", id: `i${i}`, turnId: "", at: at(), summary: "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\nOption A was tried: a second region. It still left a 15 second gap." },
  // The turn under way, which the composer times from its first message.
  ...([
    user("Go with B and add a test for it", [{ mimeType: "image/png" }]),
    tool("edit", { path: "src/relay/socket.ts" }, "Successfully replaced 1 block(s) in src/relay/socket.ts.", false, undefined, { durationMs: 21, diff: patch }),
    tool("bash", { command: "psql -c 'select count(*) from users'" }, "psql: error: connection refused\n\nCommand exited with code 2", true, undefined, { durationMs: 1_840, exitCode: 2 }),
    reply("There are **18,204** users; 312 have no email.", { stop: "aborted" }),
    reply("", { stop: "error", error: "overloaded (529)" }),
    tool("bash", { command: "npm test -- relay/reconnect" }, undefined, false, "✓ reconnects after sleep (812 ms)\n… 3 more"),
    { kind: "assistant", id: `i${i}`, turnId: "", at: at(), blocks: [{ kind: "text", text: "The replace path works in the unit test. Now I am checking that the old tab gets a clean `4000` close instead of an error, so that its" }], streaming: true },
  ] as ChatItem[]).map((x) => ({ ...x, turnId: "t2" })),
];

const models: ModelChoice[] = [
  ["anthropic", "claude-opus-5-5", "Opus 5.5", 1_000_000],
  ["anthropic", "claude-sonnet-5-5", "Sonnet 5.5", 1_000_000],
  ["anthropic", "claude-haiku-5-5", "Haiku 5.5", 200_000],
  ["openai", "gpt-6", "GPT-6", 400_000],
  ["openai", "gpt-6-mini", "GPT-6 mini", 400_000],
  ["google", "gemini-3-pro", "Gemini 3 Pro", 2_000_000],
  ["openrouter", "z-ai/glm-5.3-flash", "", 128_000],
].map(([provider, id, name, contextWindow]) => ({ model: { provider: provider as string, id: id as string, name: name as string }, reasoning: true, contextWindow: contextWindow as number, images: true }));

// Requests answered from here: a message with "refuse" in it is refused.
const answers: { [K in CommandName]?: (body: Body<K>) => Answer<K> } = {
  models: () => ({ ok: true, result: { kind: "models", models } }),
  stats: () => ({ ok: true, result: { kind: "stats", cost: 1.84, input: 412_000, output: 23_000, cacheRead: 380_000, cacheWrite: 12_000, contextTokens: 610_000, contextWindow: 1_000_000 } }),
  branches: () => ({
    ok: true,
    result: {
      kind: "tree",
      truncated: false,
      branches: [
        { leafId: "b0", current: true, prompt: "Go with B and add a test for it", last: "The replace path works in the unit test.", modified: Date.now() - 60_000, messages: 14 },
        { leafId: "b1", current: false, prompt: "Go with A instead; keep it small", last: "A works, but the phone still misses 15 seconds of updates.", modified: Date.now() - 40 * 60_000, messages: 6 },
        { leafId: "b2", current: false, prompt: "What would C take?", last: "Every client would need the new close code first.", modified: Date.now() - 3 * 3600_000, messages: 2 },
      ],
    },
  }),
  past: () => ({
    ok: true,
    result: {
      kind: "pastSessions",
      truncated: false,
      sessions: ["~/src/api", "~/src/web", "~/src/scratch"].map((cwd, i) => ({ path: `/s/${i}.jsonl`, sessionId: `p${i}`, cwd, name: "", firstPrompt: "", created: now - i * 3600_000, modified: now - i * 3600_000, messages: 4 })),
    },
  }),
  // A folder with "missing" in it does not exist on the host.
  launch: (body) => body.cwd.includes("missing")
    ? { ok: false, code: "INVALID", message: `no such folder: ${body.cwd}` }
    : { ok: true, result: { kind: "accepted" } },
  prompt: (body) => body.text.includes("refuse")
    ? { ok: false, code: "BUSY", message: "the session is being replaced" }
    : { ok: true, result: { kind: "accepted" } },
};
// Each command is logged, to see what a key or a button sent.
live.command = async <K extends CommandName>(_id: string, name: K, body: Body<K>): Promise<Answer<K>> => {
  console.info("command", name, JSON.stringify(body));
  await new Promise((r) => setTimeout(r, 400));
  const answer = answers[name] as ((body: Body<K>) => Answer<K>) | undefined;
  // Every other command is accepted.
  return answer ? answer(body) : ({ ok: true, result: { kind: "accepted" } } as Answer<K>);
};

// Machines asking to join, on screen=join; one named with "refuse" in it
// cannot be decided on.
const joining: PendingHostView[] = [
  { key: "q3Vh0bXy2kLr9w1ZsT8nPcA6eJmD4fGiU7oKxYvB5tE", label: "build-box", software: "pirc-extension/0.1.9", remote: "203.0.113.24:51022", firstSeen: now - 2 * min },
  { key: "Zp0Wn4cR7dLs2xHq9mT1vBf6yKj3gEoA8uIiN5aSeCw", label: "refuse-me", software: "pirc-extension/0.1.8", remote: "198.51.100.7:40188 via 192.0.2.10", firstSeen: now - 50 * min },
];
let setJoining: (h: PendingHostView[]) => void = () => {};
let shownJoining = joining;
live.decide = async (key, _approve, label) => {
  await new Promise((r) => setTimeout(r, 400));
  const h = shownJoining.find((x) => x.key === key);
  if (!h || h.label.includes("refuse") || label?.includes("refuse")) return { ok: false, code: "INVALID", message: "no host awaiting approval has that key" };
  shownJoining = shownJoining.filter((x) => x !== h);
  setJoining(shownJoining);
  return { ok: true };
};

// The devices Settings lists; a name with "refuse" in it is refused,
// renaming to it or removing one under it.
let devices: DeviceView[] = [
  { key: "Hq2Lm8vB0xT5nR7cW1yK4dZs9pF3gJ6aEoUiN2bCtVw", role: "host", label: "desk", addedAt: now - 40 * 24 * 60 * min, online: true, self: false, push: false },
  { key: "Rk7Ts1nW9cM4xB2vL6yQ0dZh3pF8gJ5aEoUiN1bCuXe", role: "host", label: "build-box", addedAt: now - 9 * 24 * 60 * min, online: false, self: false, push: false },
  { key: "Wd5Yp3kC8nB1xT6vL0yQ2dZs7mF4gJ9aEoUiN3bRhGs", role: "client", label: "web", addedAt: now - 40 * 24 * 60 * min, online: true, self: true, push: false },
  { key: "Ab4Cd6Ef8Gh0Ij2Kl4Mn6Op8Qr0St2Uv4Wx6Yz8AbCd", role: "client", label: "cli", addedAt: now - 30 * 24 * 60 * min, online: false, self: false, push: false },
  { key: "Pn3Hx7Jq1Vb5Mc9Lz2Kd6Wf0Ty4Rg8Se1Ua3Oi5Ep7N", role: "client", label: "iPhone", addedAt: now - 2 * 24 * 60 * min, online: false, self: false, push: true },
];
let setDevices: (d: DeviceView[]) => void = () => {};
live.rename = async (key, label) => {
  await new Promise((r) => setTimeout(r, 400));
  if (label.includes("refuse")) return { ok: false, code: "INVALID", message: "label is too long" };
  devices = devices.map((d) => (d.key === key ? { ...d, label } : d));
  setDevices(devices);
  return { ok: true };
};
// A made-up token; a name with "refuse" in it is refused.
live.invite = async (_role, label) => {
  await new Promise((r) => setTimeout(r, 400));
  if (label.includes("refuse")) return { ok: false, code: "INVALID", message: "label is too long" };
  return { ok: true, token: "q3Vt8LmZ0xR5nW7cK1yB4d", expiresAt: Date.now() + 15 * min, relay: "wss://relay.example:7400" };
};
live.remove = async (key) => {
  await new Promise((r) => setTimeout(r, 400));
  if (devices.find((d) => d.key === key)?.label.includes("refuse")) return { ok: false, code: "INVALID", message: "no such key" };
  devices = devices.filter((d) => d.key !== key);
  setDevices(devices);
  return { ok: true };
};

const screen = new URLSearchParams(location.search).get("screen") ?? "list";
const banner = new URLSearchParams(location.search).get("banner");
const look = new URLSearchParams(location.search).get("look");
if (isLook(look)) setLook(look);
applyLook();

// Notifications as Settings shows them, by &notify=off (the default), on,
// blocked or unsupported: the browser's push and permission are made up
// here, since the gallery registers no service worker.
const notify = new URLSearchParams(location.search).get("notify") ?? "off";
{
  let subscribed = notify === "on";
  const sub = { endpoint: "https://push.example/gallery", toJSON: () => ({}), options: {}, unsubscribe: async () => (subscribed = false, true) };
  const reg = { pushManager: { getSubscription: async () => (subscribed ? sub : null), subscribe: async () => (subscribed = true, sub) } };
  if (notify === "unsupported") Reflect.deleteProperty(window, "PushManager");
  else Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve(reg), addEventListener() {}, removeEventListener() {} }, configurable: true });
  let permission = notify === "blocked" ? "denied" : notify === "on" ? "granted" : "default";
  Object.defineProperty(window, "Notification", { value: { get permission() { return permission; }, requestPermission: async () => (permission = "granted") }, configurable: true });
  const real = api.call;
  api.call = (async (path: string, body?: unknown) => {
    if (path === "/api/push") return { publicKey: "AA" };
    if (path.startsWith("/api/push/")) {
      console.info("push", path);
      return { ok: true };
    }
    return real(path, body);
  }) as typeof api.call;
}

// The question on screen=asks, by &ask=select|confirm|input|editor.
const QUESTIONS: Record<string, QuestionView> = {
  select: { id: "q-select", kind: "select", title: "Which branch should the release be cut from?", options: ["main", "release/2.4", "hotfix/payments-timeout-on-retry-after-gateway-503"], answerable: true, askedAt: 0 },
  confirm: { id: "q-confirm", kind: "confirm", title: "Delete 14 files?", message: "build/ and dist/ go; nothing else is touched.", answerable: true, askedAt: 0 },
  input: { id: "q-input", kind: "input", title: "Name for the new branch", placeholder: "e.g. fix/login", answerable: true, askedAt: 0 },
  editor: { id: "q-editor", kind: "editor", title: "Edit the commit message", answerable: false, askedAt: 0 },
};
const asking = QUESTIONS[new URLSearchParams(location.search).get("ask") ?? "select"] ?? QUESTIONS.select;
if (screen === "asks") sessions[3] = { ...sessions[3], working: true, questions: [asking, QUESTIONS.confirm] };

// As the app lays them out: on a phone the list or a chat, on a laptop
// both. A session opened from the list shows the made-up chat.
function Gallery() {
  const wide = useWide();
  const [open, setOpen] = useState<string>();
  const [scope, setScope] = useState<Scope>({});
  const [settings, setSettings] = useState(screen === "settings");
  const relay = sessions[3];
  const [pendingHosts, setPendingHosts] = useState(screen === "join" ? joining : []);
  setJoining = setPendingHosts;
  const [shownDevices, setShownDevices] = useState(devices);
  setDevices = setShownDevices;
  const chatOf = (items: ChatItem[], loading = false): ChatView => ({ items, truncated: true, loading });
  if (screen === "signin") return <SignIn />;
  if (screen === "pair") return <Pair done={() => {}} />;
  if (screen === "splash") return <Splash />;
  const list = <Sessions key={scopePath(scope)} sessions={screen === "empty" ? [] : sessions} pendingHosts={pendingHosts} scope={scope} open={(id) => { setSettings(false); setOpen(id); }} go={setScope} selected={open} settings={() => setSettings(!settings)} inSettings={settings} />;
  const back = () => setOpen(undefined);
  let chat: React.ReactNode;
  if (settings) chat = <Settings back={() => setSettings(false)} wide={wide} devices={shownDevices} connected />;
  else if (screen === "loading") chat = <Chat id={relay.id} session={sessions[4]} chat={{ items: [], truncated: false, loading: true }} back={back} wide={wide} />;
  else if (screen === "ended") chat = <Chat id="gone" session={undefined} chat={chatOf(finished)} back={back} wide={wide} />;
  else if (screen === "chat" || screen === "working" || screen === "asks" || open !== undefined) {
    const picked = sessions.find((s) => s.id === open) ?? relay;
    const done = screen === "chat" || (open !== undefined && !picked.working);
    chat = <Chat key={open ?? screen} id={picked.id} session={{ ...picked, working: !done }} chat={chatOf(done ? finished : working)} back={back} wide={wide} />;
  }
  return (
    <Layout
      wide={wide}
      banner={banner && <Banner relay={banner === "refused" ? "refused" : banner === "connecting" ? "ready" : "offline"} reason={banner === "refused" ? "its key is not on the allowed list" : undefined} stream={banner === "connecting" ? "connecting" : "open"} />}
      list={list}
      chat={chat}
    />
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Gallery /></StrictMode>);
