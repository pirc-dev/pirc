// pi's messages and session entries as session.proto conversation items.
// Pure functions, tested without a running pi.
import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate, timestampFromMs, timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import type { MessageEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  BranchSchema,
  ContentBlockSchema,
  ConversationItemSchema,
  ImageSchema,
  ModelInfoSchema,
  ModelSchema,
  StopReason,
  UsageSchema,
  type Branch,
  type ConversationItem,
  type ContentBlock,
  type Image,
  type Model,
  type ModelInfo,
  type Usage,
} from "@pirc/protocol";

export type AgentMessage = MessageEndEvent["message"];

// Text fields are cut to this many characters, so one tool's output cannot
// fill a frame; pi already truncates most tool output well below it.
export const MAX_TEXT = 256 * 1024;

export function clip(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : s.slice(0, max) + `\n[… ${s.length - max} more characters not sent]`;
}

// The fields of pi's Model that PiRC uses.
export interface PiModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  input?: readonly string[];
}

export function modelRef(m: PiModel): Model {
  return create(ModelSchema, { provider: m.provider, id: m.id, name: m.name ?? "" });
}

export function modelInfo(m: PiModel): ModelInfo {
  return create(ModelInfoSchema, {
    model: modelRef(m),
    reasoning: m.reasoning === true,
    contextWindow: count(m.contextWindow),
    images: m.input?.includes("image") === true,
  });
}

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total?: number };
}

// The session's usage summed as pi's getSessionStats() does: assistant
// messages, tool results, compaction and branch summaries, and usage
// entries, over the whole file.
export function sessionTotals(entries: readonly SessionEntry[]): Usage {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const add = (u: PiUsage | undefined) => {
    if (!u) return;
    t.input += u.input ?? 0;
    t.output += u.output ?? 0;
    t.cacheRead += u.cacheRead ?? 0;
    t.cacheWrite += u.cacheWrite ?? 0;
    t.cost += u.cost?.total ?? 0;
  };
  for (const e of entries as readonly { type: string; usage?: PiUsage; message?: { role: string; usage?: PiUsage } }[]) {
    if (e.type === "usage" || e.type === "compaction" || e.type === "branch_summary") add(e.usage);
    else if (e.type === "message" && (e.message?.role === "assistant" || e.message?.role === "toolResult")) add(e.message.usage);
  }
  return create(UsageSchema, {
    inputTokens: count(t.input),
    outputTokens: count(t.output),
    cacheReadTokens: count(t.cacheRead),
    cacheWriteTokens: count(t.cacheWrite),
    cost: t.cost,
  });
}

const STOP: Record<string, StopReason> = {
  stop: StopReason.STOP,
  length: StopReason.LENGTH,
  toolUse: StopReason.TOOL_USE,
  aborted: StopReason.ABORTED,
  error: StopReason.ERROR,
  deferred: StopReason.DEFERRED,
};

// A token count as uint64: pi's are integers, but nothing enforces it, and
// BigInt throws on a fraction.
export function count(n: number | undefined): bigint {
  return Number.isFinite(n) && n! > 0 ? BigInt(Math.round(n!)) : 0n;
}

export function stopReason(r: string | undefined): StopReason {
  return (r && STOP[r]) || StopReason.UNSPECIFIED;
}

type Content = string | ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>;

export function textOf(content: Content | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

function imagesOf(content: Content | undefined): Image[] {
  if (content === undefined || typeof content === "string") return [];
  return content
    .filter((c) => c.type === "image" && c.data)
    .map((c) => create(ImageSchema, { mimeType: c.mimeType ?? "", data: new Uint8Array(Buffer.from(c.data!, "base64")) }));
}

export interface ItemContext {
  entryId: string;
  turnId: string;
  at: Timestamp;
}

// The items one message becomes: none for roles PiRC does not show yet
// (custom, bash and summary messages), several for an assistant message
// with tool calls (the message, then each call).
export function messageItems(
  m: AgentMessage,
  c: ItemContext,
  extra: { requestId?: string; messageId?: string } = {},
): ConversationItem[] {
  const base = { entryId: c.entryId, turnId: c.turnId, at: c.at };
  switch (m.role) {
    case "user":
      return [create(ConversationItemSchema, {
        ...base,
        body: { case: "userMessage", value: { text: clip(textOf(m.content)), images: imagesOf(m.content), requestId: extra.requestId ?? "" } },
      })];
    case "assistant": {
      const content: ContentBlock[] = [];
      const calls: ConversationItem[] = [];
      for (const b of m.content) {
        if (b.type === "text") {
          content.push(create(ContentBlockSchema, { body: { case: "text", value: clip(b.text) } }));
        } else if (b.type === "thinking") {
          if (b.thinking) content.push(create(ContentBlockSchema, { body: { case: "thinking", value: clip(b.thinking) } }));
        } else if (b.type === "toolCall") {
          calls.push(create(ConversationItemSchema, {
            ...base,
            body: { case: "toolCall", value: { toolCallId: b.id, toolName: b.name, argumentsJson: clip(JSON.stringify(b.arguments ?? {})) } },
          }));
        }
      }
      const u = m.usage;
      const item = create(ConversationItemSchema, {
        ...base,
        body: {
          case: "assistantMessage",
          value: {
            messageId: extra.messageId ?? c.entryId,
            content,
            usage: u && {
              inputTokens: count(u.input),
              outputTokens: count(u.output),
              cacheReadTokens: count(u.cacheRead),
              cacheWriteTokens: count(u.cacheWrite),
              cost: u.cost?.total ?? 0,
            },
            stopReason: stopReason(m.stopReason),
            model: { provider: m.provider, id: m.model },
            errorMessage: m.stopReason === "error" ? clip(m.errorMessage ?? "", 4096) : "",
          },
        },
      });
      return [item, ...calls];
    }
    case "toolResult": {
      const text = textOf(m.content);
      return [create(ConversationItemSchema, {
        ...base,
        body: { case: "toolResult", value: { toolCallId: m.toolCallId, isError: m.isError, text: clip(text), ...resultFacts(m, text) } },
      })];
    }
    default:
      return [];
  }
}

// What pi knows of a tool's run beyond its output: how long it took, a
// command's exit status, and an edit's diff. pi's bash tool says a
// failure's code as the last line of its output, and nothing on success.
export function resultFacts(m: { toolName?: string; isError: boolean; details?: unknown; durationMs?: unknown }, text: string): { durationMs?: number; exitCode?: number; diff?: string } {
  const out: { durationMs?: number; exitCode?: number; diff?: string } = {};
  if (typeof m.durationMs === "number" && Number.isFinite(m.durationMs) && m.durationMs >= 0) out.durationMs = Math.min(Math.round(m.durationMs), 0xffffffff);
  if (m.toolName === "bash") {
    const code = /Command exited with code (\d+)\s*$/.exec(text);
    if (code) out.exitCode = Number(code[1]);
    else if (!m.isError) out.exitCode = 0;
  }
  const patch = (m.details as { patch?: unknown } | undefined)?.patch;
  if (m.toolName === "edit" && typeof patch === "string" && patch) out.diff = clip(patch);
  return out;
}

export function atMs(ms: number | undefined): Timestamp {
  return timestampFromMs(ms ?? Date.now());
}

export function atIso(iso: string): Timestamp {
  return timestampFromDate(new Date(iso));
}

// The conversation on the session's current branch, as History carries it.
// turn_id is the ID of the user message's entry that started each turn.
export function historyItems(branch: readonly SessionEntry[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  let turnId = "";
  for (const e of branch) {
    if (e.type === "message") {
      if (e.message.role === "user") turnId = e.id;
      items.push(...messageItems(e.message, { entryId: e.id, turnId, at: atIso(e.timestamp) }));
    } else if (e.type === "compaction") {
      items.push(compactionItem(e, turnId));
    } else if (e.type === "branch_summary") {
      items.push(create(ConversationItemSchema, {
        entryId: e.id,
        turnId,
        at: atIso(e.timestamp),
        body: { case: "branchSummary", value: { summary: clip(e.summary) } },
      }));
    }
  }
  return items;
}

// The fields of pi's session manager that branches reads.
export interface TreeSource {
  getTree(): readonly TreeNode[];
  getBranch(fromId?: string): SessionEntry[];
  getLeafId(): string | null;
}
interface TreeNode {
  entry: SessionEntry;
  children: readonly TreeNode[];
}

// The session's branches (session.proto's ListTree): the current one, then
// every other path to an entry with nothing after it, by what it has after
// it leaves the current branch; those with no message there are left out
// (a model change made after going back, say). The current one first, then
// the newest change first.
export function branches(sm: TreeSource): Branch[] {
  const current = sm.getLeafId() ?? "";
  const here = current ? sm.getBranch(current) : [];
  const onCurrent = new Set(here.map((e) => e.id));
  const leaves: SessionEntry[] = [];
  const stack = [...sm.getTree()];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.children.length === 0) leaves.push(n.entry);
    else stack.push(...n.children);
  }
  const others: Branch[] = [];
  for (const leaf of leaves) {
    if (onCurrent.has(leaf.id)) continue;
    const path = sm.getBranch(leaf.id);
    let split = path.length;
    while (split > 0 && !onCurrent.has(path[split - 1].id)) split--;
    const b = branch(leaf.id, false, path.slice(split), path);
    if (b.messageCount > 0) others.push(b);
  }
  others.sort((a, b) => Number(timestampMs(b.modifiedAt!) - timestampMs(a.modifiedAt!)));
  return [branch(current, true, here, here), ...others];
}

// One branch: own is what it has after it leaves the current branch (all
// of it, for the current one), path all of it.
function branch(leafId: string, current: boolean, own: readonly SessionEntry[], path: readonly SessionEntry[]): Branch {
  const messages = own.flatMap((e) => (e.type === "message" && (e.message.role === "user" || e.message.role === "assistant") ? [e.message] : []));
  const said = (m: AgentMessage) => {
    const text = textOf((m as { content?: Content }).content);
    return firstLine(m.role === "user" ? promptText(text) : text);
  };
  const prompts = messages.filter((m) => m.role === "user");
  const prompt = current ? prompts[prompts.length - 1] : prompts[0];
  const last = [...messages].reverse().find((m) => said(m));
  const end = path[path.length - 1];
  return create(BranchSchema, {
    leafId,
    current,
    prompt: prompt ? said(prompt) : "",
    last: last ? said(last) : "",
    modifiedAt: end ? atIso(end.timestamp) : timestampFromMs(0),
    messageCount: messages.length,
  });
}

export function compactionItem(e: { id: string; timestamp: string; summary: string; tokensBefore: number }, turnId: string): ConversationItem {
  return create(ConversationItemSchema, {
    entryId: e.id,
    turnId,
    at: atIso(e.timestamp),
    body: { case: "compaction", value: { summary: clip(e.summary), tokensBefore: count(e.tokensBefore) } },
  });
}

// The ID of the last user message on a branch: the turn a session resumed
// in is still that turn.
export function lastTurnId(branch: readonly SessionEntry[]): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (e.type === "message" && e.message.role === "user") return e.id;
  }
  return "";
}

// The first line of the user's first message with text, cut short: what
// pi shows in its session list for a session with no name.
export function firstPrompt(branch: readonly SessionEntry[]): string {
  for (const e of branch) {
    if (e.type !== "message" || e.message.role !== "user") continue;
    const line = firstLine(promptText(textOf(e.message.content)));
    if (line) return line;
  }
  return "";
}

// What the user wrote. pi sends a skill run as the skill's text in a
// <skill> block, then the user's words, if any (pi's parseSkillBlock).
const SKILL = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;
export function promptText(text: string): string {
  const m = SKILL.exec(text);
  return m ? m[2]?.trim() || `/skill:${m[1]}` : text;
}

const FIRST_CHARS = 120;
export function firstLine(text: string): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > FIRST_CHARS ? `${line.slice(0, FIRST_CHARS - 1)}…` : line;
}

// The item cut down until it encodes in at most `budget` bytes: first its
// images are left out (empty data), then its texts are clipped further.
// Every event and the newest History item must fit in a frame; an item too
// big to send would otherwise be lost with no trace.
export function fitItem(item: ConversationItem, budget: number): ConversationItem {
  let size = toBinary(ConversationItemSchema, item).length;
  if (size <= budget) return item;
  const b = item.body;
  if (b.case === "userMessage" && b.value.images.some((i) => i.data.length > 0)) {
    for (const i of b.value.images) i.data = new Uint8Array();
    size = toBinary(ConversationItemSchema, item).length;
  }
  for (let round = 0; size > budget && round < 8; round++) {
    // Each text keeps its share of what the budget allows.
    const cut = (t: string) => clip(t, Math.max(64, Math.floor((t.length * budget) / size / 2)));
    switch (b.case) {
      case "userMessage":
        b.value.text = cut(b.value.text);
        break;
      case "assistantMessage":
        for (const c of b.value.content) if (typeof c.body.value === "string") c.body.value = cut(c.body.value);
        break;
      case "toolCall":
        b.value.argumentsJson = cut(b.value.argumentsJson);
        break;
      case "toolResult":
        b.value.text = cut(b.value.text);
        b.value.diff = cut(b.value.diff);
        break;
      case "compaction":
      case "branchSummary":
        b.value.summary = cut(b.value.summary);
        break;
    }
    size = toBinary(ConversationItemSchema, item).length;
  }
  return item;
}
