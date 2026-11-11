// Replays the recorded exchanges in cases/exchanges/ against the client
// logic (docs/web.md, section 4). cases/README.md describes their steps.
import assert from "node:assert/strict";

import { fromBinary, fromJson, toBinary, toJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";

import { FrameSchema, SessionAnnouncementSchema, SessionMessageSchema, type Frame } from "@pirc/protocol";

import { Client, type Clock } from "../core/client.ts";
import type { ChatView, ViewEvent } from "../core/view.ts";

type Step = Record<string, JsonValue>;

const obj = (v: JsonValue | undefined) => v as JsonObject;

function encodeEntry(e: JsonObject): JsonObject {
  if (!("announcement" in e)) return e;
  const { announcement, ...rest } = e;
  const payload = toBinary(SessionAnnouncementSchema, fromJson(SessionAnnouncementSchema, announcement));
  return { ...rest, payload: Buffer.from(payload).toString("base64") };
}

// A frame in the exchanges' form, as a Frame.
export function frameIn(j: JsonObject): Frame {
  const f: JsonObject = { ...j };
  if (f.routed && "message" in obj(f.routed)) {
    const { message, ...rest } = obj(f.routed);
    const payload = toBinary(SessionMessageSchema, fromJson(SessionMessageSchema, message));
    f.routed = { ...rest, payload: Buffer.from(payload).toString("base64") };
  }
  if (f.sessionList) {
    const l = obj(f.sessionList);
    f.sessionList = { ...l, sessions: ((l.sessions ?? []) as JsonObject[]).map(encodeEntry) };
  }
  if (f.sessionUpdated) f.sessionUpdated = { entry: encodeEntry(obj(obj(f.sessionUpdated).entry)) };
  return fromJson(FrameSchema, f);
}

// A Frame in the exchanges' form.
export function frameOut(f: Frame): JsonObject {
  const j = toJson(FrameSchema, f) as JsonObject;
  if (f.body.case === "routed") {
    const { payload: _, ...rest } = obj(j.routed);
    j.routed = { ...rest, message: toJson(SessionMessageSchema, fromBinary(SessionMessageSchema, f.body.value.payload)) };
  }
  return j;
}

// A clock whose time moves only when told to.
class FakeClock implements Clock {
  private now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private next = 1;

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(t: unknown): void {
    this.timers.delete(t as number);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
}

const settle = () => new Promise((r) => setImmediate(r));

// JSON round trip, which drops undefined fields as the wire does.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

export async function replay(steps: Step[]): Promise<void> {
  const clock = new FakeClock();
  let n = 0;
  const sent: Frame[] = [];
  const events: ViewEvent[] = [];
  const replies = new Map<string, Promise<unknown>>();
  const c = new Client({ send: (f) => (sent.push(f), true), onEvent: (e) => events.push(e), newId: () => `id-${++n}`, clock });
  for (const [i, step] of steps.entries()) {
    const at = `step ${i + 1} ${JSON.stringify(step).slice(0, 80)}`;
    if ("state" in step) c.onState({ state: step.state as "ready" });
    else if ("seed" in step) c.seed(obj(step.seed).sessionId as string, obj(step.seed).chat as unknown as ChatView);
    else if ("in" in step) c.onFrame(frameIn(obj(step.in)));
    else if ("wait" in step) clock.advance(step.wait as number);
    else if ("ask" in step) {
      const a = obj(step.ask);
      const m = fromJson(SessionMessageSchema, obj(a.body));
      replies.set(step.as as string, c.ask(a.id as string, m.body).then((r) => toJson(SessionMessageSchema, r)));
    } else if ("sent" in step) {
      assert.deepEqual(sent.splice(0).map(frameOut), step.sent, at);
    } else if ("events" in step) {
      await settle();
      assert.deepEqual(plain(events.splice(0)), step.events, at);
    } else if ("reply" in step) {
      const r = obj(step.reply);
      const p = replies.get(r.as as string);
      assert.ok(p, `${at}: no request named ${r.as}`);
      const got = await Promise.race([p, settle().then(() => "unanswered")]);
      assert.deepEqual(got, r.is, at);
    } else if ("snapshot" in step) {
      assert.deepEqual(plain(c.snapshot()), step.snapshot, at);
    } else if ("chat" in step) {
      const ch = obj(step.chat);
      assert.deepEqual(plain(c.chat(ch.id as string)), ch.is, at);
    } else {
      assert.fail(`${at}: unknown step`);
    }
    // Replies resolve on the microtask queue: let them land before the next
    // step, as they would before the next frame is read.
    await settle();
  }
  assert.deepEqual(sent.map(frameOut), [], "frames sent after the last check");
  assert.deepEqual(plain(events), [], "events after the last check");
}
