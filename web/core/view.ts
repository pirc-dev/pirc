// What the web app shows, shaped for the screen: the sessions and their
// chats, and the changes to them (docs/web.md, section 3). Plain JSON, so
// the server sends it to the page as it is. The page and the server both
// import this file; nothing here runs only on Node.
import type { ThinkingName } from "@pirc/protocol";

// One pi process's session. The ID stays the same when the process moves
// to another session (/new, resume, fork): the chat is reset instead.
export interface SessionView {
  id: string;
  // pi's ID for the session the process has now; the same session open in
  // two processes has the same one.
  sessionId: string;
  // The label the host's key is registered under on the relay.
  hostLabel: string;
  // The host's own name for itself.
  hostname: string;
  // pi's session name; empty when it has none.
  name: string;
  // The first line of the user's first message, which names a session
  // with no name; absent before one.
  first?: string;
  cwd: string;
  model?: ModelView;
  // "off", "minimal", "low", "medium", "high", "xhigh" or "max"; absent
  // when pi gave none.
  thinking?: ThinkingName;
  working: boolean;
  compacting: boolean;
  // Milliseconds since the epoch.
  startedAt?: number;
  piVersion: string;
  extensionVersion: string;
  // The requests the session takes (session.proto, SessionAnnouncement);
  // absent when its extension does not say.
  requests?: string[];
  // The terminal pi runs in: its tmux or herdr names, or what an extension
  // gave (docs/design.md, section 4). Absent when unknown.
  place?: PlaceView;
  // How the process opens a new pi beside itself ("tmux", "herdr", or an
  // extension's name); absent when it cannot.
  launcher?: string;
  // The launch request that started the process, if one did.
  launchId?: string;
  // The chat's latest message, for the session list; absent before one.
  last?: LastView;
  // The dialogs pi shows in its terminal for extensions, waiting for the
  // person, oldest first; absent when there are none.
  questions?: QuestionView[];
  // The latest thing worth a notification the host has seen in the
  // session; absent before the first, from a host older than notices, or
  // of a kind this client does not know.
  notice?: NoticeView;
}

// session.proto, Notice. The host decides what is worth a notification;
// each client writes it (core/notices.ts).
export interface NoticeView {
  // Goes up with each notice of the session: the time it was raised, in
  // milliseconds since the epoch by the host's clock, or one past the last.
  number: number;
  kind: "finished" | "failed" | "question";
  // The reply's text, the error, or the question, cut by the host to 120
  // code points; empty when there is none.
  text: string;
}

// A dialog pi shows for an extension (session.proto, Question). select,
// confirm and input can be answered from the app (the answer command);
// an editor or a custom dialog only in pi's terminal.
export interface QuestionView {
  id: string;
  kind: "select" | "confirm" | "input" | "editor" | "custom";
  title: string;
  // confirm's.
  message?: string;
  // select's.
  options?: string[];
  // input's.
  placeholder?: string;
  answerable: boolean;
  // Milliseconds since the epoch, by the host's clock.
  askedAt: number;
}

export interface LastView {
  who: "user" | "assistant";
  // Its first line, cut short.
  text: string;
  // Milliseconds since the epoch, by the host's clock.
  at: number;
}

export interface PlaceView {
  // "tmux", "herdr", or what the extension that gave it says.
  kind: string;
  // The tmux session, the herdr workspace.
  group?: string;
  groupNumber?: number;
  // The tmux window, the herdr tab.
  window?: string;
  windowNumber?: number;
  pane?: string;
  // Shown as it is, in place of the names, when given.
  display?: string;
}

export interface ModelView {
  provider: string;
  id: string;
  // pi's display name; empty when it has none.
  name: string;
}

export type ChatItem = UserItem | AssistantItem | ToolItem | CompactionItem | BranchSummaryItem;

interface ItemBase {
  // Unique within the chat; an item that changes keeps its ID. Opaque: what
  // it is made of may change.
  id: string;
  // pi's entry for the item, once pi has saved it: what fork names.
  entryId?: string;
  // The user message's item that started the turn; empty before the first.
  turnId: string;
  // Milliseconds since the epoch.
  at: number;
}

export interface UserItem extends ItemBase {
  kind: "user";
  text: string;
  // The request that sent it, when a client did; pi's own copy carries it.
  requestId?: string;
  // Images the message carried.
  images: ImageView[];
}

// An image in a user message: its key for /api/images/<key>, absent when
// its data did not come (left out to keep a frame within the relay's
// limit).
export interface ImageView {
  mimeType: string;
  key?: string;
}

export interface AssistantItem extends ItemBase {
  kind: "assistant";
  blocks: { kind: "text" | "thinking"; text: string }[];
  // Still being written: deltas are being appended.
  streaming: boolean;
  // "stop", "length", "tool_use", "aborted", "error" or "deferred", once
  // finished.
  stop?: string;
  error?: string;
  model?: ModelView;
  usage?: UsageView;
}

// A tool call and, once it has one, its result.
export interface ToolItem extends ItemBase {
  kind: "tool";
  name: string;
  // The arguments as JSON text.
  args: string;
  // The output so far, while it runs.
  progress?: string;
  result?: {
    text: string;
    isError: boolean;
    // How long it ran, as pi measured it.
    durationMs?: number;
    // A command's exit status (pi's bash tool).
    exitCode?: number;
    // A file edit's changes, as a unified diff (pi's edit tool).
    diff?: string;
  };
}

export interface CompactionItem extends ItemBase {
  kind: "compaction";
  summary: string;
  tokensBefore: number;
}

// What was done on a branch the session went back from.
export interface BranchSummaryItem extends ItemBase {
  kind: "branchSummary";
  summary: string;
}

export interface UsageView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // US dollars.
  cost: number;
}

export interface ChatView {
  items: ChatItem[];
  // Older items were left out of the history.
  truncated: boolean;
  // The history is being fetched: items may be stale until a chatReset.
  loading: boolean;
}

// The relay connection as the page shows it.
export interface RelayView {
  state: "connecting" | "ready" | "offline" | "refused" | "stopped";
  reason?: string;
}

// A host that asks the relay to register its key, waiting for approval
// (docs/design.md, 5.3).
// A device registered with the relay: a host, or a client such as this
// app's server (docs/design.md, section 5.3).
export interface DeviceView {
  // Its public key, as the relay shows it (base64url).
  key: string;
  role: "host" | "client";
  // The label it is registered under, which the session list shows for a
  // host.
  label: string;
  // Milliseconds since the epoch.
  addedAt: number;
  online: boolean;
  // This app's server, whose key every browser shares.
  self: boolean;
  // A client the relay wakes through the push gateway (RegisterPush).
  push: boolean;
}

export interface PendingHostView {
  // Its public key, as /pirc status on the host and pirc-relay show it
  // (base64url): what the person compares before approving.
  key: string;
  // As the host gave them, which proves nothing, and the address it
  // connected from.
  label: string;
  software: string;
  remote: string;
  // Milliseconds since the epoch.
  firstSeen: number;
}

// A change, in the order it happened. Applying every event in order to a
// snapshot gives the same state as a later snapshot.
export type ViewEvent =
  | { type: "relay"; relay: RelayView }
  // The hosts awaiting approval, all of them, oldest first.
  | { type: "pendingHosts"; hosts: PendingHostView[] }
  | { type: "devices"; devices: DeviceView[] }
  // A session appeared or changed; replaces what was known of it.
  | { type: "session"; session: SessionView }
  | { type: "sessionGone"; id: string }
  // The chat is replaced: from history, or emptied for a new session.
  | { type: "chatReset"; id: string; chat: ChatView }
  // An item appeared or changed; replaces any with the same ID.
  | { type: "chatItem"; id: string; item: ChatItem }
  // Text appended to a block of an assistant item still being written,
  // which is created if it is not there yet.
  | { type: "chatDelta"; id: string; itemId: string; turnId: string; at: number; block: number; kind: "text" | "thinking"; text: string }
  // A running tool's output so far, replacing its earlier progress.
  | { type: "toolProgress"; id: string; itemId: string; text: string };

export interface Snapshot {
  relay: RelayView;
  sessions: SessionView[];
  pendingHosts: PendingHostView[];
  devices: DeviceView[];
}

// The most items a chat keeps; older ones are dropped, as a history fetch
// drops them, so a session that runs for days does not grow without end.
export const CHAT_LIMIT = 1000;

function capped(chat: ChatView, items: ChatItem[]): ChatView {
  if (items.length <= CHAT_LIMIT) return { ...chat, items };
  return { ...chat, items: items.slice(items.length - CHAT_LIMIT), truncated: true };
}

// Applies an event to a chat. The server and the page both apply every
// event with it, so their chats stay the same.
export function applyToChat(chat: ChatView, e: ViewEvent): ChatView {
  switch (e.type) {
    case "chatReset":
      return e.chat;
    case "chatItem": {
      const i = chat.items.findIndex((x) => x.id === e.item.id);
      return capped(chat, i < 0 ? [...chat.items, e.item] : chat.items.map((x, j) => (j === i ? e.item : x)));
    }
    case "chatDelta": {
      const i = chat.items.findIndex((x) => x.id === e.itemId);
      const old = i >= 0 ? chat.items[i] : undefined;
      const base: AssistantItem = old?.kind === "assistant"
        ? old
        : { kind: "assistant", id: e.itemId, turnId: e.turnId, at: e.at, blocks: [], streaming: true };
      const blocks = base.blocks.slice();
      while (blocks.length <= e.block) blocks.push({ kind: e.kind, text: "" });
      blocks[e.block] = { kind: e.kind, text: blocks[e.block].text + e.text };
      const item: AssistantItem = { ...base, blocks, streaming: true };
      return capped(chat, i < 0 ? [...chat.items, item] : chat.items.map((x, j) => (j === i ? item : x)));
    }
    case "toolProgress": {
      const items = chat.items.map((x) => (x.id === e.itemId && x.kind === "tool" ? { ...x, progress: e.text } : x));
      return { ...chat, items };
    }
    default:
      return chat;
  }
}

const LAST_CHARS = 160;

// The latest message in a chat, the user's or a finished reply, as the
// session list shows it: its first line with text in it, without markdown's
// commonest marks, cut short.
export function lastOf(items: ChatItem[]): LastView | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    let text: string | undefined;
    // A message of images alone says so.
    if (x.kind === "user") text = x.text.trim() || !x.images.length ? x.text : x.images.length > 1 ? `${x.images.length} images` : "An image";
    else if (x.kind === "assistant" && !x.streaming) {
      text = x.blocks.filter((b) => b.kind === "text" && b.text.trim()).at(-1)?.text
        ?? (x.stop === "error" ? `⚠ ${x.error || "the model failed"}` : x.stop === "aborted" ? "Stopped." : undefined);
    }
    if (text === undefined) continue;
    const line = (text.split("\n").find((l) => l.trim()) ?? "")
      .replace(/^\s*(#+|>|[-*]|\d+\.)\s+/, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    return { who: x.kind === "user" ? "user" : "assistant", text: line.length > LAST_CHARS ? `${line.slice(0, LAST_CHARS - 1)}…` : line, at: x.at };
  }
  return undefined;
}
