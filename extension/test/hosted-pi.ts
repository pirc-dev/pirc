// A real pi in tmux with the extension from the tree and the fake model,
// joined to a hosted account by `/pirc join <origin>` typed at its
// terminal, for the app's end to end test (app/test/hosted_pi_test.dart).
// It prints the code's text as /pirc join shows it, then "joined" once pi
// says so. From stdin it takes "status", to type /pirc status, and
// "screen", to print pi's screen, each line after "| ", then "end".
// stdin closing ends pi and its tmux server.
//
//   node --experimental-transform-types --no-warnings extension/test/hosted-pi.ts <origin>
//
// Needs tmux and pi on PATH.
import { createInterface } from "node:readline";

import { Harness, sleep, startPi } from "../../test/harness.ts";

const [origin] = process.argv.slice(2);
const out = (s: string) => process.stdout.write(`${s}\n`);
const h = new Harness();
const pi = await startPi(h, undefined, "", "pi");

async function until<T>(what: string, find: () => T | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = find();
    if (v !== undefined) return v;
    if (Date.now() > deadline) {
      out(`failed: waiting for ${what}; the screen:\n${pi.screen()}`);
      await h.close();
      process.exit(1);
    }
    await sleep(100);
  }
}

// pi's editor, then the join.
await until("pi", () => (pi.screen().trim().length > 0 ? true : undefined));
await sleep(1000);
pi.keys(`/pirc join ${origin}`, "Enter");
const text = await until("the code's text", () => /PIRC1[0-9A-Z]{60}/.exec(pi.screen())?.[0]);
out(text);
await until("joined", () => (/joined the account/.test(pi.screen()) ? true : undefined), 120_000);
out("joined");

createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (line === "status") pi.keys("/pirc status", "Enter");
    if (line === "screen") {
      for (const l of pi.screen().split("\n")) out(`| ${l}`);
      out("end");
    }
  })
  .on("close", () => {
    void h.close().then(() => process.exit(0));
  });
