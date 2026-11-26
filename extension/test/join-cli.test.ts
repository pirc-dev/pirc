// node join.js (join-cli.ts): a machine with no one at it joins the account,
// against the Go relay, with the test phone (join-phone.ts): the text on
// the first line, the account and the marker written where the extension
// reads them, and a machine on an account left alone without --replace.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";

import { accountDir, readSecrets } from "../src/account.ts";
import { HOSTED_MARKER } from "../src/config.ts";
import { phoneJoins, relay } from "./join-phone.ts";

const cli = join(import.meta.dirname, "../src/join-cli.ts");

function run(config: string, ...args: string[]) {
  const p = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", cli, ...args], { env: { ...process.env, PIRC_CONFIG: config }, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  let err = "";
  createInterface({ input: p.stdout }).on("line", (l) => lines.push(l));
  p.stderr.on("data", (d) => (err += d));
  const exit = new Promise<number>((resolve) => p.on("exit", (c) => resolve(c ?? -1)));
  return { lines, exit, err: () => err, kill: () => p.kill() };
}

async function firstLine(lines: string[]): Promise<string> {
  for (let i = 0; i < 200 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(lines.length > 0, "no join text");
  return lines[0];
}

test("joined from the command line: the text first, then the account where the extension reads it", async () => {
  const config = join(mkdtempSync(join(tmpdir(), "pirc-join-cli-")), "host.json");
  const r = run(config, relay.origin);
  const text = await firstLine(r.lines);
  assert.match(text, /^PIRC1[0-9A-Z]{60}$/);
  assert.ok(r.lines.length > 10 || (await new Promise((t) => setTimeout(t, 200)), r.lines.length > 10), "the QR code after the text");
  const computer = await phoneJoins(text);
  assert.equal(await r.exit, 0, r.err());
  assert.equal(r.lines.at(-1), "joined Pixel 9");
  assert.deepEqual(readSecrets(accountDir(config)).signing.length, 32);
  assert.ok(computer);
  assert.equal(JSON.parse(readFileSync(config, "utf8")).relay, HOSTED_MARKER);

  // On an account already: left alone, unless replaced.
  const again = run(config, relay.origin);
  assert.equal(await again.exit, 1);
  assert.match(again.err(), /on an account already/);
  const replaced = run(config, relay.origin, "--replace");
  try {
    assert.match(await firstLine(replaced.lines), /^PIRC1/);
  } finally {
    replaced.kill();
  }
});

test("refused: no origin, or not a relay's", async () => {
  const config = join(mkdtempSync(join(tmpdir(), "pirc-join-cli-")), "host.json");
  for (const args of [[], ["https://relay.example"]]) {
    const r = run(config, ...args);
    assert.equal(await r.exit, 1, args.join(" "));
    assert.match(r.err(), /pirc join:/);
  }
});
