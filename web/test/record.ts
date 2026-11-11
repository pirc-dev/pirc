// Writes a recorded exchange from its inputs: runs the client logic on the
// input steps of the file named and puts after each the frames sent, the
// events and the replies that followed, so that exchanges.test.ts checks
// them from then on. Read what it wrote before keeping it: it records what
// the code does, right or wrong.
//
//   node --experimental-transform-types web/test/record.ts cases/exchanges/x.json
//
// Inputs are the "state", "seed", "in", "wait" and "ask" steps (cases/README.md); a
// {"check": "snapshot"} or {"check": "chat", "id": ...} step records the
// state then, as do the "snapshot" and "chat" steps such a check wrote
// before. Every other step is dropped and written again.
//
// Given a file of cases/functions/ instead, it writes each case's "is" from
// its "fn" and "args".
import { readFileSync, writeFileSync } from "node:fs";

import { fromJson, toJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";

import { SessionMessageSchema, type Frame } from "@pirc/protocol";

import { Client, type Clock } from "../core/client.ts";
import type { ChatView, ViewEvent } from "../core/view.ts";
import { frameIn, frameOut } from "./exchange.ts";
import { call } from "./functions.ts";

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
const plain = (v: unknown) => JSON.parse(JSON.stringify(v)) as JsonValue;

const path = process.argv[2];
const ex = JSON.parse(readFileSync(path, "utf8")) as { about: string; steps: Record<string, JsonValue>[]; cases?: { fn: string; args: JsonValue[] }[] };
if (ex.cases) {
  const cases = ex.cases.map((c) => ({ ...c, is: call(c.fn, c.args) }));
  writeFileSync(path, JSON.stringify({ about: ex.about, cases }, null, 1) + "\n");
  console.log(`recorded ${cases.length} cases in ${path}`);
  process.exit(0);
}
const clock = new FakeClock();
let n = 0;
const sent: Frame[] = [];
const events: ViewEvent[] = [];
const answered: { as: string; is: JsonValue }[] = [];
const c = new Client({ send: (f) => (sent.push(f), true), onEvent: (e) => events.push(e), newId: () => `id-${++n}`, clock });
const out: Record<string, JsonValue>[] = [];

for (const step of ex.steps) {
  if ("state" in step) c.onState({ state: step.state as "ready" });
  else if ("seed" in step) c.seed((step.seed as JsonObject).sessionId as string, (step.seed as JsonObject).chat as unknown as ChatView);
  else if ("in" in step) c.onFrame(frameIn(step.in as JsonObject));
  else if ("wait" in step) clock.advance(step.wait as number);
  else if ("ask" in step) {
    const a = step.ask as JsonObject;
    const as = step.as as string;
    void c.ask(a.id as string, fromJson(SessionMessageSchema, a.body as JsonObject).body).then((r) => {
      answered.push({ as, is: toJson(SessionMessageSchema, r) });
    });
  } else if ("check" in step || "snapshot" in step || "chat" in step) {
    const id = "chat" in step ? (step.chat as JsonObject).id as string : step.id as string;
    out.push(step.check === "snapshot" || "snapshot" in step ? { snapshot: plain(c.snapshot()) } : { chat: { id, is: plain(c.chat(id)) } });
    continue;
  } else continue;
  out.push(step);
  await settle();
  if (sent.length) out.push({ sent: sent.splice(0).map(frameOut) });
  if (events.length) out.push({ events: plain(events.splice(0)) });
  for (const r of answered.splice(0)) out.push({ reply: r });
}

writeFileSync(path, JSON.stringify({ about: ex.about, steps: out }, null, 1) + "\n");
console.log(`recorded ${out.length} steps in ${path}`);
