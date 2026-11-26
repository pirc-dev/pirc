// `/pirc join` without pi's terminal, for a machine with no one at it
// (docs/design.md, step 14, stage 6: the stores' reviewers' demo
// computers), shipped as join.js beside the extension:
//
//   node join.js <relay-origin> [--replace]
//
// Prints the join text on its first line, then its QR code, waits up to ten
// minutes for the account's phone, writes the account where the extension
// reads it (the folder beside host.json, or $PIRC_CONFIG's), prints
// "joined <the phone's name>" and exits 0; any failure exits 1 with the
// reason. A pi started afterwards is on the account. Without --replace, a
// machine already on an account is left as it is.
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
  const origin = hostedOrigin(rest[0]);
  const dir = accountDir(configPath());
  if (hasAccount(dir) && !replace) throw new Error(`this machine is on an account already (${dir}); --replace joins another`);
  const [e2e, noise] = await Promise.all([loadE2e(), loadNoise()]);
  const j = new ComputerJoin({ origin, e2e, noise, open: wsSocket, random: (n) => new Uint8Array(randomBytes(n)), log: (m) => console.error(m) });
  process.stdout.write([j.text, ...qrLines(j.text), ""].join("\n"));
  const joined = await j.start();
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
