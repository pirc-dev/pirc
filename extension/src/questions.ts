// The dialogs extensions ask pi to show (ctx.ui), asked in pi's terminal
// and of PiRC's clients at once (docs/design.md, section 8). pi gives
// every extension the same ui object, and no way to answer another's
// dialog, so PiRC wraps that object's select, confirm and input: each
// still shows in the terminal, and a client's answer closes it there with
// the signal pi's dialogs take, as Escape would, the answer going to the
// extension instead. editor() takes no signal, so it, and custom(), are
// only shown to clients, as what the session waits for.
//
// This relies on pi's internals (one shared, writable ui object, checked
// against pi 1.0.0): where wrapping fails, questions are shown only through
// pi's ui_prompt events, and /pirc status says so.
import { create } from "@bufbuild/protobuf";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";

import { QuestionKind, QuestionSchema, type Answer, type Question } from "@pirc/protocol";

import { atMs } from "./convert.ts";

// What is sent of a question; a select with more options is shown only.
const TEXT_MAX = 2000;
const OPTION_MAX = 500;
const OPTIONS_MAX = 200;

// pi's own methods, kept on the ui object so that a newer load of the
// extension wraps them rather than the older load's wrappers.
const ORIGINALS = Symbol.for("pirc.questions.originals");
type Wrapped = "select" | "confirm" | "input" | "editor" | "custom";
type UI = ExtensionUIContext & { [ORIGINALS]?: Pick<ExtensionUIContext, Wrapped> };

interface Pending {
  question: Question;
  // A client's answer: the value to give the extension.
  answer?: (value: unknown) => void;
  // The options as the extension gave them (a select's).
  options?: string[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class Questions {
  private pending: Pending[] = [];
  // Why wrapping failed, if it did.
  problem = "";

  constructor(private readonly onChange: () => void) {}

  // The questions now, oldest first.
  list(): Question[] {
    return this.pending.map((p) => p.question);
  }

  // Wraps pi's ui object, if not already this extension's; again after a
  // newer load, or when pi makes a new one.
  install(ui: ExtensionUIContext, current: () => Questions): void {
    try {
      const u = ui as UI;
      const orig = u[ORIGINALS] ?? { select: u.select, confirm: u.confirm, input: u.input, editor: u.editor, custom: u.custom };
      if (u[ORIGINALS] && (u.select as { pirc?: Questions }).pirc === this) return;
      Object.defineProperty(u, ORIGINALS, { value: orig, configurable: true });
      const select = (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
        current().ask({ kind: QuestionKind.SELECT, title, options }, opts, (o) => orig.select.call(ui, title, options, o));
      (select as { pirc?: Questions }).pirc = this;
      u.select = select;
      u.confirm = (title, message, opts) => current().ask({ kind: QuestionKind.CONFIRM, title, message }, opts, (o) => orig.confirm.call(ui, title, message, o));
      u.input = (title, placeholder, opts) => current().ask({ kind: QuestionKind.INPUT, title, placeholder }, opts, (o) => orig.input.call(ui, title, placeholder, o));
      u.editor = (title, prefill) => current().show({ kind: QuestionKind.EDITOR, title }, () => orig.editor.call(ui, title, prefill));
      u.custom = ((factory: never, options: never) => current().show({ kind: QuestionKind.CUSTOM, title: "" }, () => orig.custom.call(ui, factory, options))) as ExtensionUIContext["custom"];
      if (u.select !== select) throw new Error("pi's ui object cannot be changed");
      this.problem = "";
    } catch (e) {
      this.problem = `questions cannot be answered from clients: ${(e as Error).message}`;
    }
  }

  private add(q: { kind: QuestionKind; title: string; message?: string; options?: string[]; placeholder?: string }, answerable: boolean): Pending {
    const options = q.options ?? [];
    const fits = options.length <= OPTIONS_MAX;
    const p: Pending = {
      question: create(QuestionSchema, {
        id: randomBytes(8).toString("hex"),
        kind: q.kind,
        title: clip(q.title ?? "", TEXT_MAX),
        message: clip(q.message ?? "", TEXT_MAX),
        options: fits ? options.map((o) => clip(String(o), OPTION_MAX)) : [],
        placeholder: clip(q.placeholder ?? "", TEXT_MAX),
        answerable: answerable && fits,
        askedAt: atMs(Date.now()),
      }),
      ...(q.options ? { options: q.options } : {}),
    };
    this.pending.push(p);
    this.changed();
    return p;
  }

  private remove(p: Pending): void {
    const i = this.pending.indexOf(p);
    if (i < 0) return;
    this.pending.splice(i, 1);
    this.changed();
  }

  private changed(): void {
    try {
      this.onChange();
    } catch {
      // Clients learn of it with the next announcement.
    }
  }

  // Asked in the terminal and of clients; the first answer wins, and a
  // client's closes the terminal's dialog.
  ask<T>(q: Parameters<Questions["add"]>[0], opts: ExtensionUIDialogOptions | undefined, run: (opts: ExtensionUIDialogOptions) => Promise<T>): Promise<T> {
    const closing = new AbortController();
    const given = opts?.signal;
    if (given?.aborted) closing.abort();
    given?.addEventListener("abort", () => closing.abort(), { once: true });
    const p = this.add(q, true);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (f: () => void) => {
        if (settled) return;
        settled = true;
        this.remove(p);
        f();
      };
      p.answer = (value) => {
        settle(() => resolve(value as T));
        closing.abort();
      };
      run({ ...opts, signal: closing.signal }).then((v) => settle(() => resolve(v)), (e) => settle(() => reject(e)));
    });
  }

  // Shown to clients until the terminal answers it.
  show<T>(q: Parameters<Questions["add"]>[0], run: () => Promise<T>): Promise<T> {
    const p = this.add(q, false);
    return run().finally(() => this.remove(p));
  }

  // A client's answer: why it cannot be taken, or undefined once given.
  answer(a: Answer): string | undefined {
    const p = this.pending.find((x) => x.question.id === a.questionId);
    if (!p) return "that question is no longer asked";
    if (!p.question.answerable || !p.answer) return "that question can be answered only in pi's terminal";
    const v = a.value;
    if (v.case === "dismissed") {
      p.answer(p.question.kind === QuestionKind.CONFIRM ? false : undefined);
      return undefined;
    }
    switch (p.question.kind) {
      case QuestionKind.SELECT: {
        if (v.case !== "option" || v.value >= (p.options?.length ?? 0)) return "a select is answered with one of its options";
        p.answer(p.options![v.value]);
        return undefined;
      }
      case QuestionKind.CONFIRM:
        if (v.case !== "confirmed") return "a confirm is answered yes or no";
        p.answer(v.value);
        return undefined;
      case QuestionKind.INPUT:
        if (v.case !== "text") return "an input is answered with text";
        p.answer(v.value);
        return undefined;
      default:
        return "that question can be answered only in pi's terminal";
    }
  }
}
