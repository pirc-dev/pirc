// Small helpers over the generated types, shared by every TypeScript peer.
import { create } from "@bufbuild/protobuf";

import type { ErrorCode, SessionRef } from "./gen/pirc/v1alpha1/common_pb.ts";
import { SessionMessageSchema, ThinkingLevel, type SessionMessage } from "./gen/pirc/v1alpha1/session_pb.ts";

export function errorReply(requestId: string, code: ErrorCode, message: string): SessionMessage {
  return create(SessionMessageSchema, { body: { case: "error", value: { requestId, code, message } } });
}

export function accepted(requestId: string): SessionMessage {
  return create(SessionMessageSchema, { body: { case: "accepted", value: { requestId } } });
}

// The request ID of a request or a reply; "" for a message without one.
export function requestIdOf(body: { value?: unknown } | undefined): string {
  return (body?.value as { requestId?: string } | undefined)?.requestId ?? "";
}

// A message's request ID: its body's, else the one beside it, which a
// client sets on every request (session.proto, SessionMessage).
export function messageRequestId(m: SessionMessage): string {
  return requestIdOf(m.body) || m.requestId;
}

// A request's name as SessionAnnouncement.requests lists it: its field in
// SessionMessage ("list_past_sessions" for listPastSessions).
export function requestName(bodyCase: string): string {
  return bodyCase.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function sameRef(a: SessionRef, b: SessionRef): boolean {
  return a.sessionId === b.sessionId && a.instanceId === b.instanceId && sameBytes(a.hostKey, b.hostKey);
}

// pi's names for its thinking levels, as PiRC's clients show them.
export const THINKING_NAMES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingName = (typeof THINKING_NAMES)[number];

const LEVEL: Record<ThinkingName, ThinkingLevel> = {
  off: ThinkingLevel.OFF,
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
  xhigh: ThinkingLevel.XHIGH,
  max: ThinkingLevel.MAX,
};

// The level a name gives; undefined for any other name.
export function thinkingLevel(name: string | undefined): ThinkingLevel | undefined {
  return name !== undefined && Object.hasOwn(LEVEL, name) ? LEVEL[name as ThinkingName] : undefined;
}

// A level's name; undefined for UNSPECIFIED, or a level newer than this code.
export function thinkingName(level: ThinkingLevel): ThinkingName | undefined {
  return THINKING_NAMES.find((n) => LEVEL[n] === level);
}
