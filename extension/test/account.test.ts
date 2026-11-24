import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { load } from "@pirc/e2e";
import { load as loadNoise } from "@pirc/e2e/noise";

import { hasAccount, keysOf, ListFolder, listsSelf, newSecrets, readInfo, readSecrets, removeAccount, selfDevice, writeAccount } from "../src/account.ts";
import { accountFolder, accountId, alice, bob, computer, computerSecrets, info, other, phone, v1, version } from "./account-fixture.ts";

const e2e = await load();
const noise = await loadNoise();
const pub = (s: Uint8Array) => noise.staticKey(s).publicKey;

test("the keys: the signing, channel and box keys the list holds for this computer", () => {
  const k = keysOf(computerSecrets, pub);
  assert.deepEqual(k.signingKey, computer.signingKey);
  assert.deepEqual(k.channelKey, computer.channelKey);
  assert.deepEqual(k.boxKey, computer.boxKey);
  const { dir } = accountFolder([]);
  assert.deepEqual(readSecrets(dir), computerSecrets);
  assert.deepEqual(readInfo(dir), info());
  assert.equal(readFileSync(join(dir, "keys"), "utf8").length > 0, true);
});

test("the folder: the highest version that checks out is taken; one that fails is skipped", () => {
  const v2 = version(2n, [phone, computer]);
  const v3 = version(3n, [phone, computer, alice]);
  const { dir } = accountFolder([{ counter: 1n, bytes: v1 }, { counter: 2n, bytes: v2 }, { counter: 3n, bytes: v3 }]);
  // Version 4, signed by someone else, and a file named for one counter holding another.
  writeFileSync(join(dir, "lists", "4"), version(4n, [phone, computer, alice, bob], new Uint8Array(32).fill(7)));
  writeFileSync(join(dir, "lists", "5"), version(6n, [phone, computer]));
  const said: string[] = [];
  const f = new ListFolder(dir, e2e, info(), (m) => said.push(m));
  assert.equal(f.scan(), true);
  assert.equal(f.newest?.counter, 3n);
  assert.equal(said.length, 2, said.join("\n"));
  // Nothing newer: no change, and the refused files are not reported again.
  assert.equal(f.scan(), false);
  assert.equal(said.length, 2);
});

test("offered: a newer version is stored and taken; the same again is old; other bytes under one counter are a conflict", () => {
  const { dir } = accountFolder([{ counter: 1n, bytes: v1 }, { counter: 2n, bytes: version(2n, [phone, computer]) }]);
  const f = new ListFolder(dir, e2e, info(), () => {});
  f.scan();
  const v3 = version(3n, [phone, computer, alice]);
  const r = f.offer(v3);
  assert.equal(r.result, "newer");
  assert.equal(f.newest?.counter, 3n);
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, "lists", "3"))), v3);
  assert.deepEqual(readdirSync(join(dir, "lists")).sort(), ["1", "2", "3"], "no temporary file left");
  assert.deepEqual(f.offer(v3), { result: "old", counter: 3n });
  // Another version 3: the phone signed two with one counter.
  assert.deepEqual(f.offer(version(3n, [phone, computer, bob])), { result: "conflict", counter: 3n });
  // A version 4 that another process stored with other bytes.
  const g = new ListFolder(dir, e2e, info(), () => {});
  g.scan();
  writeFileSync(join(dir, "lists", "4"), version(4n, [phone, computer]));
  assert.deepEqual(g.offer(version(4n, [phone, computer, bob])), { result: "conflict", counter: 4n });
  // Refused: not the phone's.
  assert.equal(f.offer(version(5n, [phone, computer], new Uint8Array(32).fill(9))).result, "refused");
});

test("two folders on one account: each takes what the other stored", () => {
  const { dir } = accountFolder([{ counter: 1n, bytes: v1 }, { counter: 2n, bytes: version(2n, [phone, computer]) }]);
  const a = new ListFolder(dir, e2e, info(), () => {});
  const b = new ListFolder(dir, e2e, info(), () => {});
  a.scan();
  b.scan();
  assert.equal(a.offer(version(3n, [phone, computer, alice])).result, "newer");
  assert.equal(b.scan(), true);
  assert.equal(b.newest?.counter, 3n);
  // b, behind, is offered the same version: stored already, same bytes, taken.
  const c = new ListFolder(dir, e2e, info(), () => {});
  assert.equal(c.offer(version(3n, [phone, computer, alice])).result, "newer");
});

test("listsSelf: this computer, by all three keys and its role", () => {
  const self = selfDevice(keysOf(computerSecrets, pub));
  const has = (devices: typeof computer[]) => {
    const { dir } = accountFolder([{ counter: 2n, bytes: version(2n, devices) }]);
    const f = new ListFolder(dir, e2e, info(), () => {});
    f.scan();
    return listsSelf(f.newest!.body, self);
  };
  assert.equal(has([phone, computer]), true);
  assert.equal(has([phone, other]), false);
  assert.equal(has([phone, { ...computer, boxKey: other.boxKey }]), false);
  assert.equal(has([phone, { ...computer, channelKey: other.channelKey }]), false);
});

test("leaving removes the folder", () => {
  const { dir } = accountFolder([]);
  assert.equal(hasAccount(dir), true);
  removeAccount(dir);
  assert.equal(hasAccount(dir), false);
  assert.equal(existsSync(dir), false);
  removeAccount(dir);
  void accountId;
});

test("another process leaves, or joins another account: the folder is no longer ours, and nothing is written into it", () => {
  const v2 = version(2n, [phone, computer]);
  const { dir } = accountFolder([{ counter: 1n, bytes: v1 }, { counter: 2n, bytes: v2 }]);
  const mine = new ListFolder(dir, e2e, info(), () => {});
  mine.scan();
  assert.equal(mine.ours(), true);
  // Another account replaces the folder at the same path.
  writeAccount(dir, newSecrets(), { ...info(), accountId: new Uint8Array(32).fill(1) }, []);
  assert.equal(mine.ours(), false);
  assert.deepEqual(mine.offer(version(3n, [phone, computer, alice])), { result: "gone" });
  assert.deepEqual(readdirSync(join(dir, "lists")), [], "not written into the new account");
  assert.equal(mine.scan(), false);
  // Once not ours, never again, even if the old files came back.
  const left = accountFolder([{ counter: 2n, bytes: v2 }]);
  const f = new ListFolder(left.dir, e2e, info(), () => {});
  removeAccount(left.dir);
  assert.equal(f.ours(), false);
  assert.equal(f.offer(v2).result, "gone");
});
