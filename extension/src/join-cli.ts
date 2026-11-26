// `/pirc join` without pi's terminal, for a machine with no one at it
// (docs/design.md, step 14, stage 6: the stores' reviewers' demo
// computers), shipped as join.js beside the extension:
//
//   node join.js <relay-origin> [--replace]
//
// Prints the join text on its first line, then its QR code; "waiting" once
// the relay has held the wait two seconds without refusing it, "pairing"
// when a phone begins the handshake; and after the account's phone, within
// ten minutes, writes the account where the extension reads it (the
// folder beside host.json, or $PIRC_CONFIG's), prints "joined <the phone's
// name>" and exits 0. Any failure exits 1 with the reason. A pi started
// afterwards is on the account. Without --replace, a machine already on an
// account is left as it is; with PIRC_RELAY set, a self-hosted relay's,
// nothing is joined, as /pirc join does.
import { randomBytes } from "node:crypto";

import { load as loadE2e } from "@pirc/e2e";
import { load as loadNoise } from "@pirc/e2e/noise";
import { hostedOrigin } from "@pirc/relay-client/hosted";
import { wsSocket } from "@pirc/relay-client/hosted-ws";

import { accountDir, hasAccount, writeAccount } from "./account.ts";
import { configPath, HOSTED_MARKER, saveRelay } from "./config.ts";
import { ComputerJoin, qrLines } from "./join.ts";

async function main(args: string[]): Promise<void> {
  const replace = args.includes("--replace");
  const rest = args.filter((a) => a !== "--replace");
  if (rest.length !== 1) throw new Error("usage: node join.js <relay-origin> [--replace]");
  if (process.env.PIRC_RELAY) throw new Error("PIRC_RELAY is set: this machine is on a relay of its own");
  const origin = hostedOrigin(rest[0]);
  const dir = accountDir(configPath());
  if (hasAccount(dir) && !replace) throw new Error(`this machine is on an account already (${dir}); --replace joins another`);
  const [e2e, noise] = await Promise.all([loadE2e(), loadNoise()]);
  let held: ReturnType<typeof setTimeout> | undefined;
  const j = new ComputerJoin({
    origin,
    e2e,
    noise,
    open: wsSocket,
    random: (n) => new Uint8Array(randomBytes(n)),
    log: (m) => console.error(m),
    onWaiting: () => {
      clearTimeout(held);
      held = setTimeout(() => process.stdout.write("waiting\n"), 2000);
    },
    onPaired: () => {
      clearTimeout(held);
      process.stdout.write("pairing\n");
    },
  });
  process.stdout.write([j.text, ...qrLines(j.text), ""].join("\n"));
  const joined = await j.start().finally(() => clearTimeout(held));
  // As /pirc join does: the marker first.
  saveRelay(HOSTED_MARKER);
  writeAccount(dir, joined.secrets, joined.info, joined.lists);
  process.stdout.write(`joined ${joined.phoneName || "the account's phone"}\n`);
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (e) => {
    console.error(`pirc join: ${(e as Error).message}`);
    process.exit(1);
  },
);
