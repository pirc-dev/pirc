// /pirc join's computer side (join.ts) against the Go relay, with the test
// phone (join-phone.ts): the account written and logged in to after a
// join; and what the computer refuses: a wrong secret, a list without it,
// a phone's offer that fails, a code past its time.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { readJoinText } from "@pirc/e2e";
import { FrameSchema } from "@pirc/protocol/v1alpha2";

import { readSecrets, writeAccount } from "../src/account.ts";
import { Hosted } from "../src/hosted.ts";
import { qrLines } from "../src/join.ts";
import { accountId, alice, phone, version } from "./account-fixture.ts";
import { computerJoin, nextCounter, nextRequest, otherFirst, p, phoneJoins, running, until, type PhoneSide } from "./join-phone.ts";

test("a computer joins: the phone reads its code, both offer, the list adds it, and it logs in to the account", async () => {
  const cj = computerJoin();
  const done = cj.start();
  assert.equal(cj.text.length, 65);
  assert.ok(qrLines(cj.text).length > 10);
  const computer = await phoneJoins(cj.text);
  const joined = await done;
  assert.equal(joined.phoneName, "Pixel 9");
  assert.deepEqual(joined.info.accountId, accountId);
  assert.deepEqual(joined.info.phoneKey, phone.signingKey);
  assert.equal(joined.lists.length, 2);

  // Written and logged in to.
  const dir = join(mkdtempSync(join(tmpdir(), "pirc-join-")), "account");
  writeAccount(dir, joined.secrets, joined.info, joined.lists);
  assert.deepEqual(readSecrets(dir), joined.secrets);
  const hosted = await Hosted.open(dir, { instanceId: "i1", computerName: "c", lives: () => [], announce: () => {}, request: () => {}, onStatus: () => {}, log: () => {}, fail: () => {} });
  running.push(hosted);
  assert.deepEqual(hosted.signingKey, computer!.signingKey);
  hosted.start();
  await until("the joined computer logged in", () => (hosted.current.kind === "ready" ? true : undefined));
  hosted.stop();
});

test("refused: a wrong secret, a list without this computer, a phone's offer that fails, a list not the phone's", async () => {
  const cases: [string, PhoneSide, RegExp][] = [
    ["wrong secret", { secret: new Uint8Array(32).fill(1), publish: false }, /did not match/],
    ["no computer", { list: () => version(nextCounter(), [phone, alice]), publish: false }, /refused \(self\)/],
    ["offer", { offerSigner: "alice", publish: false }, /offer was refused \(signature\)/],
    ["list signer", { list: (c) => version(nextCounter(), [phone, c], new Uint8Array(32).fill(5)), publish: false }, /refused \(signature\)/],
    ["version 1 of another phone", otherFirst(), /not that phone's/],
  ];
  for (const [what, side, want] of cases) {
    const cj = computerJoin();
    const done = cj.start();
    const settled = done.then(
      () => assert.fail(`${what}: joined`),
      (e: Error) => assert.match(e.message, want, what),
    );
    await phoneJoins(cj.text, side);
    await settled;
  }
});

test("the code expires on the computer's own clock: by its timer, and by the wall clock after a sleep", async () => {
  const cj = computerJoin(200);
  await assert.rejects(cj.start(), /expired/);

  // The timer has not fired (as after a sleep), but the wall clock has
  // passed ten minutes when the phone pairs: refused.
  let clock = Date.now();
  const late = computerJoin(undefined, () => clock);
  const done = late.start();
  const settled = done.then(
    () => assert.fail("joined after its time"),
    (e: Error) => assert.match(e.message, /expired/),
  );
  await new Promise((r) => setTimeout(r, 200));
  clock += 10 * 60_000;
  await phoneJoins(late.text, { publish: false }).catch(() => undefined);
  await settled;
});

test("a wrong secret spends the code: the right one then finds nothing", async () => {
  const cj = computerJoin();
  const done = cj.start().catch((e: Error) => e);
  await phoneJoins(cj.text, { secret: new Uint8Array(32).fill(1), publish: false });
  assert.match(((await done) as Error).message, /did not match/);
  const code = readJoinText(cj.text)!;
  const id = `l${nextRequest()}`;
  p.conn.send(create(FrameSchema, { body: { case: "joinLookup", value: { requestId: id, lookup: code.lookup } } }));
  const err = await p.next("the lookup refused", (f) => (f.body.case === "error" && f.body.value.requestId === id ? f.body.value : f.body.case === "joinPaired" && f.body.value.requestId === id ? null : undefined));
  assert.ok(err, "not paired again");
});
