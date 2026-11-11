// Messages sent from this client that pi has not yet shown in the chat: one
// appears the moment it is sent, and goes when pi's own copy of it does.
// Its images are the client's own kind (I), kept to send it again.
import type { ChatItem } from "./view.ts";

export interface Pending<I = unknown> {
  key: number;
  // Made when it is first sent and sent again with a retry, so that pi
  // runs it once (core/api.ts); pi's copy of it carries it.
  requestId: string;
  text: string;
  images?: I[];
  delivery?: "steer" | "followUp";
  // sending: not yet answered. sent: pi took it, to run now. queued: pi
  // took it, to send to the model later. failed: refused, or not
  // answered. lost: pi had it, then went idle without sending it
  // (stopped, pi puts its queue back in its input box).
  state: "sending" | "sent" | "queued" | "failed" | "lost";
  error?: string;
  // Failed with no answer: pi may have it after all, so its copy still
  // settles it.
  unsure?: boolean;
  // The user messages in the chat when it was sent; pi's copy is a new one.
  before: Set<string>;
}

export function userIds(items: ChatItem[]): Set<string> {
  return new Set(items.filter((x) => x.kind === "user").map((x) => x.id));
}

// Drops the pending messages that pi's user messages now show, each
// claiming one: the one with its request ID, else, for a copy without one
// (a prompt template pi expanded), the same text, then one it starts with
// (pi appends notes to some prompts). Returns the same array when nothing
// goes.
export function settle<P extends Pending>(pending: P[], items: ChatItem[]): P[] {
  const claimed = new Set<string>();
  const gone = new Set<number>();
  for (const how of ["id", "text", "prefix"] as const) {
    for (const p of pending) {
      if (gone.has(p.key) || (p.state === "failed" && !p.unsure)) continue;
      const echo = items.find((x) =>
        x.kind === "user" && !p.before.has(x.id) && !claimed.has(x.id) &&
        (how === "id" ? x.requestId === p.requestId
          : x.requestId === undefined && (how === "text" ? x.text === p.text : p.text !== "" && x.text.startsWith(p.text)))
      );
      if (!echo) continue;
      claimed.add(echo.id);
      gone.add(p.key);
    }
  }
  return gone.size === 0 ? pending : pending.filter((p) => !gone.has(p.key));
}

// pi's answer to a sent message: refused, or no answer at all (unsure). A
// command (a "/" one) gets no copy in the chat; nor might a prompt
// template, which pi expands. Anything else waits for its copy.
export function answered<P extends Pending>(p: P, ok: boolean, error?: string, unsure = false): P | undefined {
  if (!ok) return { ...p, state: "failed", error, ...(unsure ? { unsure } : {}) };
  if (p.text.startsWith("/")) return undefined;
  return { ...p, state: p.delivery ? "queued" : "sent" };
}

// Whether the end of the chat should say that pi is working: it is, and
// nothing there is moving already, a reply being written or a tool of the
// current turn running.
export function quiet(items: ChatItem[]): boolean {
  const last = items.at(-1);
  if (last?.kind === "assistant" && last.streaming) return false;
  for (let i = items.length - 1; i >= 0 && items[i].turnId === last?.turnId; i--) {
    const x = items[i];
    if (x.kind === "tool" && !x.result) return false;
  }
  return true;
}
