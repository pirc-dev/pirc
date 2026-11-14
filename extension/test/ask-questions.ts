// A pi extension for the end-to-end tests and the demo: a prompt "ask
// select", "ask confirm", "ask input" or "ask editor" makes it ask that
// kind of question in pi's terminal (ctx.ui) before the turn runs, and
// write the answer to answers.log in pi's folder, so that a test can see
// what the extension got.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (e, ctx) => {
    // A run a custom message starts (pi 1.5) has no prompt.
    if (!("prompt" in e)) return;
    const m = /^ask (select|confirm|input|editor)\b/.exec(e.prompt);
    if (!m) return;
    const kind = m[1];
    const log = (line: string) => appendFileSync(join(ctx.cwd, "answers.log"), `${line}\n`);
    try {
      const answer =
        kind === "select" ? await ctx.ui.select("Which colour?", ["red", "green", "blue"])
        : kind === "confirm" ? await ctx.ui.confirm("Delete build/?", "14 files go.")
        : kind === "input" ? await ctx.ui.input("Branch name?", "e.g. fix/login")
        : await ctx.ui.editor("Commit message", "fix: ");
      log(`${kind}=${JSON.stringify(answer ?? null)}`);
    } catch (err) {
      log(`${kind} failed: ${(err as Error).message}`);
    }
  });
}
