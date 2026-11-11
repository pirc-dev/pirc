// node --experimental-transform-types --test extension/test/
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { StopReason, thinkingLevel, ThinkingLevel } from "@pirc/protocol";

import { atMs, branches, clip, firstLine, firstPrompt, historyItems, lastTurnId, messageItems, promptText, resultFacts } from "../src/convert.ts";

const at = atMs(0);
const usage = { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };

test("a user message with an image", () => {
  const [item] = messageItems(
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: Buffer.from([1, 2]).toString("base64") }], timestamp: 0 },
    { entryId: "e1", turnId: "e1", at },
    { requestId: "r1" },
  );
  assert.equal(item.body.case, "userMessage");
  const v = item.body.value as { text: string; requestId: string; images: { mimeType: string; data: Uint8Array }[] };
  assert.equal(v.text, "look");
  assert.equal(v.requestId, "r1");
  assert.deepEqual([v.images[0].mimeType, [...v.images[0].data]], ["image/png", [1, 2]]);
});

test("an assistant message becomes the message, then its tool calls", () => {
  const items = messageItems(
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "thinking", thinking: "", redacted: true },
        { type: "text", text: "running it" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ],
      api: "x",
      provider: "p",
      model: "m",
      usage,
      stopReason: "toolUse",
      timestamp: 0,
    },
    { entryId: "e2", turnId: "e1", at },
    { messageId: "m-1" },
  );
  assert.deepEqual(items.map((i) => i.body.case), ["assistantMessage", "toolCall"]);
  const msg = items[0].body.value as { messageId: string; content: { body: { case: string; value: string } }[]; stopReason: StopReason; usage: { cost: number; outputTokens: bigint } };
  assert.equal(msg.messageId, "m-1");
  assert.deepEqual(msg.content.map((b) => [b.body.case, b.body.value]), [["thinking", "hmm"], ["text", "running it"]]);
  assert.equal(msg.stopReason, StopReason.TOOL_USE);
  assert.equal(msg.usage.cost, 0.25);
  assert.equal(msg.usage.outputTokens, 4n);
  const call = items[1].body.value as { toolCallId: string; argumentsJson: string };
  assert.deepEqual([call.toolCallId, JSON.parse(call.argumentsJson)], ["c1", { command: "ls" }]);
  assert.ok(items.every((i) => i.entryId === "e2" && i.turnId === "e1"));
});

test("roles PiRC does not show become nothing", () => {
  assert.deepEqual(messageItems({ role: "bashExecution", command: "ls", output: "", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 }, { entryId: "e", turnId: "", at }), []);
});

test("history names each turn after its user message", () => {
  const msg = (id: string, message: object): SessionEntry => ({ type: "message", id, parentId: null, timestamp: "2026-10-22T00:00:00.000Z", message } as SessionEntry);
  const branch: SessionEntry[] = [
    msg("u1", { role: "user", content: "one", timestamp: 0 }),
    msg("a1", { role: "assistant", content: [{ type: "text", text: "1" }], api: "x", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 0 }),
    { type: "model_change", id: "mc", parentId: null, timestamp: "2026-10-22T00:00:00.000Z", provider: "p", modelId: "m" } as SessionEntry,
    msg("u2", { role: "user", content: "two", timestamp: 0 }),
    { type: "compaction", id: "c1", parentId: null, timestamp: "2026-10-22T00:00:00.000Z", summary: "short", firstKeptEntryId: "u2", tokensBefore: 99 } as SessionEntry,
    msg("r2", { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false, timestamp: 0 }),
  ];
  const items = historyItems(branch);
  assert.deepEqual(items.map((i) => [i.entryId, i.turnId, i.body.case]), [
    ["u1", "u1", "userMessage"],
    ["a1", "u1", "assistantMessage"],
    ["u2", "u2", "userMessage"],
    ["c1", "u2", "compaction"],
    ["r2", "u2", "toolResult"],
  ]);
  assert.equal(lastTurnId(branch), "u2");
  assert.equal(lastTurnId([]), "");
  assert.equal(firstPrompt(branch), "one");
  assert.equal(firstPrompt([]), "");
});

test("a session's first message, as its name: the first line, cut short", () => {
  assert.equal(firstLine("\n  Fix the build  \nthen deploy"), "Fix the build");
  assert.equal(firstLine(""), "");
  const long = firstLine("x".repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
  // A skill run: the user's words, else the skill's name.
  const skill = '<skill name="code-review" location="/u/.pi/skills/code-review/SKILL.md">\nReview it.\n</skill>';
  assert.equal(promptText(`${skill}\n\nthe auth module`), "the auth module");
  assert.equal(promptText(skill), "/skill:code-review");
  assert.equal(promptText("plain"), "plain");
  // A first message with no text (an image alone) does not name it.
  const msg = (id: string, content: unknown) => ({ type: "message", id, parentId: null, timestamp: "2026-10-22T00:00:00.000Z", message: { role: "user", content, timestamp: 0 } } as SessionEntry);
  assert.equal(firstPrompt([msg("u1", [{ type: "image", data: "", mimeType: "image/png" }]), msg("u2", "why is this red?")]), "why is this red?");
});

test("thinking levels and clipping", () => {
  assert.equal(thinkingLevel("max"), ThinkingLevel.MAX);
  assert.equal(thinkingLevel("nonsense"), undefined);
  assert.equal(clip("abc", 5), "abc");
  assert.match(clip("abcdefgh", 3), /^abc\n\[… 5 more characters not sent\]$/);
});

test("a failed assistant message carries pi's error", () => {
  const [item] = messageItems(
    { role: "assistant", content: [], api: "x", provider: "p", model: "m", usage, stopReason: "error", errorMessage: "rate limited", timestamp: 0 },
    { entryId: "e", turnId: "e", at },
  );
  assert.equal(item.body.case === "assistantMessage" && item.body.value.errorMessage, "rate limited");
  assert.equal(item.body.case === "assistantMessage" && item.body.value.stopReason, StopReason.ERROR);
});

// pi's own session manager, kept in memory: its package exports only its
// entry point, which pulls in more than Node can load here.
const { SessionManager } = (await import(new URL("core/session-manager.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href)) as typeof import("@earendil-works/pi-coding-agent");

test("branches: the current one first, then the others newest first, by what they have of their own", () => {
  const sm = SessionManager.inMemory("/w");
  const say = (role: "user" | "assistant", text: string) =>
    sm.appendMessage((role === "user" ? { role, content: text, timestamp: 0 } : { role, content: [{ type: "text", text }], api: "x", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 0 }) as never);
  const ask = say("user", "first question");
  const answer = say("assistant", "first answer");
  say("user", "try A");
  const a = say("assistant", "A done");
  // Back to after the first answer: try B instead.
  sm.branch(answer);
  say("user", "try B\nwith more");
  const b = say("assistant", "B done");
  // Back to before everything, and only a model change since: no branch.
  sm.resetLeaf();
  sm.appendModelChange("p", "n");
  sm.branch(b);

  const [current, ...others] = branches(sm);
  assert.equal(current.current, true);
  assert.equal(current.leafId, b);
  assert.equal(current.prompt, "try B");
  assert.equal(current.last, "B done");
  assert.equal(current.messageCount, 4);
  assert.equal(others.length, 1);
  assert.equal(others[0].leafId, a);
  assert.equal(others[0].current, false);
  assert.equal(others[0].prompt, "try A");
  assert.equal(others[0].last, "A done");
  assert.equal(others[0].messageCount, 2);

  // Gone back to the first question: everything is a branch of its own.
  sm.resetLeaf();
  const [empty, ...rest] = branches(sm);
  assert.equal(empty.leafId, "");
  assert.equal(empty.messageCount, 0);
  assert.deepEqual(rest.map((r) => r.leafId).sort(), [a, b].sort());
  assert.ok(rest.every((r) => r.prompt === "first question" && r.messageCount === 4));
  assert.ok(ask);
});

test("history: a branch summary is an item of its own", () => {
  const sm = SessionManager.inMemory("/w");
  const ask = sm.appendMessage({ role: "user", content: "q", timestamp: 0 } as never);
  sm.branchWithSummary(ask, "tried X; it failed");
  const items = historyItems(sm.getBranch());
  assert.deepEqual(items.map((i) => i.body.case), ["userMessage", "branchSummary"]);
  const s = items[1];
  assert.ok(s.body.case === "branchSummary" && s.body.value.summary === "tried X; it failed" && s.turnId === ask);
});

test("a tool result says how long it ran, a command's exit status, and an edit's diff", () => {
  assert.deepEqual(resultFacts({ toolName: "bash", isError: false, durationMs: 412.6 }, "ok\n"), { durationMs: 413, exitCode: 0 });
  assert.deepEqual(resultFacts({ toolName: "bash", isError: true, durationMs: 20 }, "nope\n\nCommand exited with code 2"), { durationMs: 20, exitCode: 2 });
  // Timed out or stopped: no exit status.
  assert.deepEqual(resultFacts({ toolName: "bash", isError: true }, "x\n\nCommand timed out after 5 seconds"), {});
  const patch = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n";
  assert.deepEqual(resultFacts({ toolName: "edit", isError: false, details: { diff: "display", patch } }, "Successfully replaced text"), { diff: patch });
  assert.deepEqual(resultFacts({ toolName: "read", isError: false, durationMs: "soon" }, "x"), {});
});

test("a tool result carries its facts into the item", () => {
  const [item] = messageItems({ role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }], isError: true, durationMs: 1500, timestamp: 0 } as never, { entryId: "e1", turnId: "turn", at: atMs(0) });
  assert.equal(item.body.case, "toolResult");
  const v = item.body.value as { durationMs?: number; exitCode?: number; diff: string };
  assert.deepEqual([v.durationMs, v.exitCode, v.diff], [1500, 1, ""]);
});
