// A computer in a hosted account, for the app's tests
// (app/test/hosted_sessions_test.dart): it joins as `/pirc join` does, then
// runs the extension's Hosted with one stand-in session, as a pi process
// would. It prints the code's text on one line, then "joined", then each
// status ("status ready", "status removed", ...), "list <counter>" for each
// newer list, and "request <case> <session>" for each request, which it
// answers with an error naming it ("echo <case>"), but for a history,
// answered empty. From stdin it takes "name <text>", to rename the session
// and announce it again, "notice <text>", to end a turn with that notice,
// announced with push, and "progress <text>", to send every channel a
// tool's progress, as a session event.
//
//   node --experimental-transform-types --no-warnings extension/test/hosted-computer.ts <origin>
import { create } from "@bufbuild/protobuf";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { load as loadE2e } from "@pirc/e2e";
import { load as loadNoise } from "@pirc/e2e/noise";
import { NoticeKind, SessionAnnouncementSchema, SessionMessageSchema } from "@pirc/protocol";
import { wsSocket } from "@pirc/relay-client/hosted-ws";

import { writeAccount } from "../src/account.ts";
import { Hosted } from "../src/hosted.ts";
import { ComputerJoin } from "../src/join.ts";
import type { Live } from "../src/live.ts";

export const SESSION = "0190aaaa-0000-7000-8000-000000000001";

const [origin] = process.argv.slice(2);
const out = (s: string) => process.stdout.write(`${s}\n`);
const e2e = await loadE2e();
const noise = await loadNoise();
const j = new ComputerJoin({ origin, e2e, noise, open: wsSocket, random: (n) => new Uint8Array(randomBytes(n)), log: () => {} });
out(j.text);
let joined;
try {
  joined = await j.start();
} catch (e) {
  out(`failed: ${(e as Error).message}`);
  process.exit(0);
}
const dir = join(mkdtempSync(join(tmpdir(), "pirc-computer-")), "account");
writeAccount(dir, joined.secrets, joined.info, joined.lists);
out("joined");

const announcement = create(SessionAnnouncementSchema, { name: "fix the build", cwd: "/work", hostname: "build-box", model: { provider: "p", id: "m1", name: "Model One" }, working: true });
const live = { sessionId: SESSION, announcement: () => announcement } as unknown as Live;
let hosted: Hosted | undefined;
let lastCounter = 0n;
let seq = 0;
hosted = await Hosted.open(dir, {
  instanceId: "i1",
  computerName: "build box",
  lives: () => [live],
  announce: (l) => void hosted!.announce(l),
  request: (sessionId, _clientKey, m, deliver) => {
    out(`request ${m.body.case} ${sessionId}`);
    const requestId = (m.body.value as { requestId?: string } | undefined)?.requestId ?? "";
    // An empty history, so that the client takes the events after it.
    if (m.body.case === "historyRequest") return deliver(create(SessionMessageSchema, { body: { case: "history", value: { requestId, seq: BigInt(seq) } } }));
    deliver(create(SessionMessageSchema, { body: { case: "error", value: { requestId, message: `echo ${m.body.case}` } } }));
  },
  onStatus: (s) => {
    out(`status ${s.kind}`);
    if (s.kind === "ready") hosted!.announce(live);
  },
  log: () => {
    const c = hosted?.listCounter ?? 0n;
    if (c > lastCounter) {
      lastCounter = c;
      out(`list ${c}`);
    }
  },
  fail: (where, e) => out(`fail ${where}: ${e}`),
});
lastCounter = hosted.listCounter;
hosted.start();

createInterface({ input: process.stdin }).on("line", (line) => {
  const [cmd, ...rest] = line.split(" ");
  const text = rest.join(" ");
  if (cmd === "name") {
    announcement.name = text;
    hosted!.announce(live);
  } else if (cmd === "notice") {
    // A turn's end, as the extension makes one, announced with push.
    announcement.notice = { $typeName: "pirc.v1alpha1.Notice", number: BigInt(Date.now()), kind: NoticeKind.FINISHED, text };
    hosted!.announce(live, true);
  } else if (cmd === "progress") {
    hosted!.broadcast(SESSION, create(SessionMessageSchema, { body: { case: "event", value: { seq: BigInt(++seq), body: { case: "toolProgress", value: { toolCallId: "t1", text } } } } }));
  }
}).on("close", () => {
  hosted!.stop();
  process.exit(0);
});
