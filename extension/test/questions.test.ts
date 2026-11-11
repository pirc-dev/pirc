// Questions (src/questions.ts): pi's dialogs, wrapped so that clients can
// answer them as well as the terminal, whichever comes first.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { AnswerSchema, QuestionKind, type Answer } from "@pirc/protocol";

import { Questions } from "../src/questions.ts";

// pi's terminal dialogs as far as PiRC sees them: open until the terminal
// answers (here) or their signal closes them.
function terminal() {
  const t = {
    open: 0,
    here: [] as ((v: unknown) => void)[],
    dialog(signal?: AbortSignal, closed: unknown = undefined) {
      t.open++;
      return new Promise((resolve) => {
        let done = false;
        const end = (v: unknown) => {
          if (done) return;
          done = true;
          t.open--;
          resolve(v);
        };
        signal?.addEventListener("abort", () => end(closed), { once: true });
        t.here.push(end);
      });
    },
  };
  const ui = {
    select: (_t: string, _o: string[], opts?: { signal?: AbortSignal }) => t.dialog(opts?.signal),
    confirm: (_t: string, _m: string, opts?: { signal?: AbortSignal }) => t.dialog(opts?.signal, false),
    input: (_t: string, _p?: string, opts?: { signal?: AbortSignal }) => t.dialog(opts?.signal),
    editor: () => t.dialog(),
    custom: () => t.dialog(),
  };
  return { t, ui: ui as unknown as import("@earendil-works/pi-coding-agent").ExtensionUIContext };
}

const answer = (questionId: string, value: Answer["value"]) => create(AnswerSchema, { requestId: "r", questionId, value });

test("a select, an input and a dismissal answered by a client close the terminal's dialog", async () => {
  const { t, ui } = terminal();
  let changes = 0;
  const q = new Questions(() => changes++);
  q.install(ui, () => q);
  const picked = ui.select("Which?", ["a", "b", "c"]);
  const typed = ui.input("Name?", "e.g. api");
  const [s, i] = q.list();
  assert.deepEqual([s.kind, s.title, s.options, s.answerable], [QuestionKind.SELECT, "Which?", ["a", "b", "c"], true]);
  assert.deepEqual([i.kind, i.placeholder], [QuestionKind.INPUT, "e.g. api"]);
  assert.equal(q.answer(answer(s.id, { case: "option", value: 3 })), "a select is answered with one of its options");
  assert.equal(q.answer(answer(s.id, { case: "option", value: 1 })), undefined);
  assert.equal(await picked, "b");
  assert.equal(q.answer(answer(i.id, { case: "dismissed", value: true })), undefined);
  assert.equal(await typed, undefined);
  assert.equal(t.open, 0);
  assert.deepEqual(q.list(), []);
  assert.equal(changes, 4);
});

test("the terminal answering first takes the question back; the extension's own signal still closes it", async () => {
  const { t, ui } = terminal();
  const q = new Questions(() => {});
  q.install(ui, () => q);
  const asked = ui.confirm("Sure?", "really");
  const id = q.list()[0].id;
  t.here[0](true);
  assert.equal(await asked, true);
  assert.equal(q.answer(answer(id, { case: "confirmed", value: false })), "that question is no longer asked");

  const stop = new AbortController();
  const timed = ui.input("Quick?", "", { signal: stop.signal });
  stop.abort();
  assert.equal(await timed, undefined);
  assert.deepEqual(q.list(), []);
});

test("an editor or a custom dialog is shown to clients, answered only in the terminal", async () => {
  const { t, ui } = terminal();
  const q = new Questions(() => {});
  q.install(ui, () => q);
  const edited = ui.editor("Commit message");
  const [e] = q.list();
  assert.deepEqual([e.kind, e.title, e.answerable], [QuestionKind.EDITOR, "Commit message", false]);
  assert.equal(q.answer(answer(e.id, { case: "text", value: "x" })), "that question can be answered only in pi's terminal");
  t.here[0]("fix");
  assert.equal(await edited, "fix");
  assert.deepEqual(q.list(), []);
});

test("a newer load wraps pi's own methods, not the older load's wrappers; a ui that cannot change is reported", async () => {
  const { t, ui } = terminal();
  const older = new Questions(() => {});
  older.install(ui, () => older);
  const newer = new Questions(() => {});
  newer.install(ui, () => newer);
  const asked = ui.select("Which?", ["a"]);
  assert.equal(older.list().length, 0);
  assert.equal(newer.list().length, 1);
  assert.equal(t.open, 1, "one dialog, not one per load");
  newer.answer(answer(newer.list()[0].id, { case: "option", value: 0 }));
  assert.equal(await asked, "a");

  const frozen = Object.freeze({ ...terminal().ui });
  const q = new Questions(() => {});
  q.install(frozen, () => q);
  assert.match(q.problem, /^questions cannot be answered from clients: /);
});
