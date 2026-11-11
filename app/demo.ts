// A local relay for the mobile app to join from an Android emulator or the
// iOS simulator, to look at and take screenshots of: the relay, two hosts
// (each a pi with the extension and the fake model) with sessions in a few
// states, a third asking to join, and a join link, until interrupted. Not a test; nothing checks
// anything. app/README.md says how to use it.
//
//   node --experimental-transform-types --no-warnings app/demo.ts
//
// The relay listens on this machine's loopback, which an Android emulator
// reaches as 10.0.2.2 and the iOS simulator as 127.0.0.1; both links are
// printed.
import { join } from "node:path";

import { Harness, repo, startPi, startRelay } from "../test/harness.ts";

const h = new Harness();
const stop = async () => {
  await h.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const relay = await startRelay(h);
const questions = join(repo, "extension/test/ask-questions.ts");
// The laptop's with a launcher that opens new agents with the demo's own pi
// arguments, as web/test/demo.ts has it, so that a new agent connects.
const laptop = await startPi(h, relay, relay.cmd("add-host", "--label", "laptop"), "release", [join(repo, "extension/test/give-launcher.ts"), questions]);
const server = await startPi(h, relay, relay.cmd("add-host", "--label", "server"), "docs", [questions]);
// Started with no token: it asks to join, for the app to approve or reject.
await startPi(h, relay, "", "asking");
await sleep(3000); // pi starting

// Each prompt typed into pi's terminal, as a person would, given time to run.
const say = async (pi: typeof laptop, text: string, ms = 2500) => {
  pi.keys("-l", text);
  pi.keys("Enter");
  await sleep(ms);
};
await say(laptop, "explain the relay's keys in markdown");
await say(laptop, "run the tool");
await say(laptop, "compare the options in a table");
await say(server, "run failing");
// Left open: a question waiting, and a turn still running.
await say(server, "ask confirm");
await say(laptop, "slow: write the release notes", 500);

const token = relay.cmd("add-client", "--label", "app-demo", "--ttl", "8h");
const port = new URL(relay.url).port;
const link = (host: string) => `pirc://join?relay=${encodeURIComponent(`ws://${host}:${port}`)}&token=${encodeURIComponent(token)}`;
console.log("PiRC app demo ready");
console.log(`  android emulator: ${link("10.0.2.2")}`);
console.log(`  iOS simulator:    ${link("127.0.0.1")}`);
console.log(`  pi:   tmux -L ${laptop.tmuxSession} capture-pane -p -t '=${laptop.tmuxSession}:'`);
console.log("  stop: interrupt this process; it removes everything it started");
await new Promise(() => {});
