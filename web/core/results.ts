// A session's answers to requests, shaped for the screen like view.ts:
// plain JSON with numbers, no Protocol Buffers types.
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ErrorCode, type SessionMessage } from "@pirc/protocol";

import type { ModelView } from "./view.ts";

export interface ModelChoice {
  model: ModelView;
  reasoning: boolean;
  // Tokens; 0 when unknown.
  contextWindow: number;
  images: boolean;
}

export type Result =
  | { kind: "accepted" }
  | { kind: "models"; models: ModelChoice[]; current?: ModelChoice }
  | {
    kind: "stats";
    cost: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    // Absent when unknown.
    contextTokens?: number;
    // 0 when there is no model.
    contextWindow: number;
  }
  | { kind: "pastSessions"; sessions: PastSession[]; truncated: boolean }
  | { kind: "tree"; branches: Branch[]; truncated: boolean };

// One of a session's branches, as NavigateTree names it by its leaf.
export interface Branch {
  // "" for a current branch with nothing on it yet.
  leafId: string;
  current: boolean;
  // Its first prompt after it leaves the current branch (the current
  // one's last), and its last message, each cut to their start.
  prompt: string;
  last: string;
  // Milliseconds since the epoch.
  modified: number;
  messages: number;
}

// A session pi has saved, as Resume names it by path.
export interface PastSession {
  path: string;
  sessionId: string;
  // "" when unknown.
  cwd: string;
  name: string;
  firstPrompt: string;
  // Milliseconds since the epoch.
  created: number;
  modified: number;
  messages: number;
}

export type Outcome =
  | { ok: true; result: Result }
  // code is ErrorCode's name without its prefix, e.g. "BUSY", "TIMEOUT".
  | { ok: false; code: string; message: string };

export function outcome(m: SessionMessage): Outcome {
  const b = m.body;
  switch (b.case) {
    case "accepted":
      return { ok: true, result: { kind: "accepted" } };
    case "error":
      return { ok: false, code: ErrorCode[b.value.code] ?? "UNKNOWN", message: b.value.message };
    case "models": {
      const choice = (i: (typeof b.value.models)[number]): ModelChoice | undefined => i.model
        ? { model: { provider: i.model.provider, id: i.model.id, name: i.model.name }, reasoning: i.reasoning, contextWindow: Number(i.contextWindow), images: i.images }
        : undefined;
      const current = b.value.current ? choice(b.value.current) : undefined;
      return {
        ok: true,
        result: { kind: "models", models: b.value.models.flatMap((i) => choice(i) ?? []), ...(current ? { current } : {}) },
      };
    }
    case "stats": {
      const t = b.value.total;
      return {
        ok: true,
        result: {
          kind: "stats",
          cost: t?.cost ?? 0,
          input: Number(t?.inputTokens ?? 0n),
          output: Number(t?.outputTokens ?? 0n),
          cacheRead: Number(t?.cacheReadTokens ?? 0n),
          cacheWrite: Number(t?.cacheWriteTokens ?? 0n),
          ...(b.value.contextTokens !== undefined ? { contextTokens: Number(b.value.contextTokens) } : {}),
          contextWindow: Number(b.value.contextWindow),
        },
      };
    }
    case "pastSessions":
      return {
        ok: true,
        result: {
          kind: "pastSessions",
          sessions: b.value.sessions.map((p) => ({
            path: p.path,
            sessionId: p.sessionId,
            cwd: p.cwd,
            name: p.name,
            firstPrompt: p.firstPrompt,
            created: p.createdAt ? timestampMs(p.createdAt) : 0,
            modified: p.modifiedAt ? timestampMs(p.modifiedAt) : 0,
            messages: p.messageCount,
          })),
          truncated: b.value.truncated,
        },
      };
    case "tree":
      return {
        ok: true,
        result: {
          kind: "tree",
          branches: b.value.branches.map((x) => ({
            leafId: x.leafId,
            current: x.current,
            prompt: x.prompt,
            last: x.last,
            modified: x.modifiedAt ? timestampMs(x.modifiedAt) : 0,
            messages: x.messageCount,
          })),
          truncated: b.value.truncated,
        },
      };
    default:
      return { ok: false, code: "INVALID", message: `unexpected answer: ${b.case ?? "empty"}` };
  }
}
