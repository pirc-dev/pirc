// node join.js (join-cli.ts): a machine with no one at it joins the account,
// against the Go relay, with the test phone (join-phone.ts): the text on
// the first line, the account and the marker written where the extension
// reads them, and a machine on an account left alone without --replace.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { accountDir, readSecrets } from "../src/account.ts";
import { HOSTED_MARKER } from "../src/config.ts";
import { phone, version } from "./account-fixture.ts";
import { nextCounter, phoneJoins, relay } from "./join-phone.ts";

const cli = join(import.meta.dirname, "../src/join-cli.ts");

// Each join's version built on the one before, as the relay takes them.
let last: Uint8Array | undefined;
const chained = { list: (c: Parameters<typeof version>[1][number]) => (last = version(nextCounter(), [phone, c], undefined, last)) };

function run(config: string, ...args: string[]) {
  return runWith([process.execPath, "--experimental-transform-types", "--no-warnings", cli], config, args);
}

function runWith(command: string[], config: string, args: string[], env: Record<string, string> = {}) {
  const p = spawn(command[0], [...command.slice(1), ...args], { env: { ...process.env, PIRC_RELAY: "", ...env, PIRC_CONFIG: config }, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let err = "";
  createInterface({ input: p.stdout }).on("line", (l) => lines.push(l));
  p.stderr.on("data", (d) => (err += d));
  const exit = new Promise<number>((resolve) => p.on("exit", (c) => resolve(c ?? -1)));
  return { lines, exit, err: () => err, kill: () => p.kill() };
}

async function firstLine(lines: string[]): Promise<string> {
  await lineThat(lines, () => true);
  return lines[0];
}

async function lineThat(lines: string[], ok: (l: string) => boolean): Promise<string> {
  for (let i = 0; i < 200 && !lines.some(ok); i++) await new Promise((r) => setTimeout(r, 50));
  const l = lines.find(ok);
  assert.ok(l !== undefined, `no such line in: ${lines.filter((x) => !x.includes("█") && !x.includes("▀")).join(" / ")}`);
  return l;
}

test("joined from the command line: the text first, then the account where the extension reads it", async () => {
  const config = join(mkdtempSync(join(tmpdir(), "pirc-join-cli-")), "host.json");
  const r = run(config, relay.origin);
  const text = await firstLine(r.lines);
  assert.match(text, /^PIRC1[0-9A-Z]{60}$/);
  // The relay held the wait: said, after the QR code.
  await lineThat(r.lines, (l) => l === "waiting");
  assert.ok(r.lines.indexOf("waiting") > 10, "the QR code between the text and waiting");
  const computer = await phoneJoins(text, chained);
  assert.equal(await r.exit, 0, r.err());
  assert.deepEqual(r.lines.slice(-2), ["pairing", "joined Pixel 9"]);
  assert.deepEqual(readSecrets(accountDir(config)).signing.length, 32);
  assert.ok(computer);
  assert.equal(JSON.parse(readFileSync(config, "utf8")).relay, HOSTED_MARKER);

  // On an account already: left alone, unless replaced.
  const before = readSecrets(accountDir(config)).signing;
  const again = run(config, relay.origin);
  assert.equal(await again.exit, 1);
  assert.match(again.err(), /on an account already/);
  assert.deepEqual(readSecrets(accountDir(config)).signing, before);
  // Replaced once a phone completes the join; until then, kept.
  const replaced = run(config, relay.origin, "--replace");
  const text2 = await firstLine(replaced.lines);
  await lineThat(replaced.lines, (l) => l === "waiting");
  assert.deepEqual(readSecrets(accountDir(config)).signing, before);
  await phoneJoins(text2, chained);
  assert.equal(await replaced.exit, 0, replaced.err());
  assert.notDeepEqual(readSecrets(accountDir(config)).signing, before);
});

test("refused: no origin, or not a relay's, or on a relay of its own", async () => {
  const config = join(mkdtempSync(join(tmpdir(), "pirc-join-cli-")), "host.json");
  for (const args of [[], ["https://relay.example"]]) {
    const r = run(config, ...args);
    assert.equal(await r.exit, 1, args.join(" "));
    assert.match(r.err(), /pirc join:/);
  }
  const own = runWith([process.execPath, "--experimental-transform-types", "--no-warnings", cli], config, [relay.origin], { PIRC_RELAY: "wss://own.example" });
  assert.equal(await own.exit, 1);
  assert.match(own.err(), /PIRC_RELAY is set/);
});

test("the bundle that ships, join.js, joins as the source does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pirc-join-js-"));
  const bundle = join(dir, "join.js");
  const b = spawnSync(process.execPath, ["--experimental-transform-types", "--no-warnings", join(import.meta.dirname, "../../sh/bundle.ts"), "extension-join", "0.0.0-test", bundle], { cwd: join(import.meta.dirname, "../.."), encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  const config = join(dir, "host.json");
  const r = runWith([process.execPath, bundle], config, [relay.origin]);
  const text = await firstLine(r.lines);
  await lineThat(r.lines, (l) => l === "waiting");
  await phoneJoins(text, chained);
  assert.equal(await r.exit, 0, r.err());
  assert.equal(r.lines.at(-1), "joined Pixel 9");
});
