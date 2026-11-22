// Every case in cases/e2e/framed.json and list.json that the package can
// run, against the package. Which parts it has is stated here; a case
// needing any other is left out, and the count run is checked against the
// file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import sodium from "libsodium-wrappers-sumo";

import { framed, framedNumber, leb128 } from "../framed.ts";
import { load } from "../index.ts";
import { CASES_DIR, deviceKeys, expectOf, hex, unhex, type CaseFile, type FramedCase, type ListCase } from "./cases.ts";

/** The parts this package has. It makes no lists: make-list is the phone's. */
const HAS = new Set(["first-mode", "self"]);
/** The checks this runner knows, by file. */
const CHECKS: Record<string, Set<string>> = {
  "framed.json": new Set(["framed", "number"]),
  "list.json": new Set(["list", "verify"]),
};

function read<C>(name: string): CaseFile<C> {
  return JSON.parse(readFileSync(new URL(name, CASES_DIR), "utf8")) as CaseFile<C>;
}

function runnable(name: string, c: { check: string; needs: string[] }): boolean {
  return CHECKS[name].has(c.check) && c.needs.every((n) => HAS.has(n));
}

const e2e = await load();
await sodium.ready;

test("framed.json", () => {
  const file = read<FramedCase>("framed.json");
  let ran = 0;
  for (const c of file.cases) {
    if (!runnable("framed.json", c)) continue;
    const run = c.check === "framed" ? () => framed(c.context, ...c.parts.map(unhex)) : () => framedNumber(BigInt(c.value));
    if ("throws" in c) assert.throws(run, RangeError, c.about);
    else assert.equal(hex(run()), c.bytes, c.about);
    ran++;
  }
  assert.equal(ran, file.cases.length, "every case in framed.json needs only what this package has");
});

test("list.json", () => {
  const file = read<ListCase>("list.json");
  let ran = 0;
  for (const c of file.cases) {
    if (!runnable("list.json", c)) continue;
    if (c.check === "verify") {
      assert.equal(sodium.crypto_sign_verify_detached(unhex(c.signature), unhex(c.message), unhex(c.key)), c.valid, c.about);
    } else if (c.check === "list") {
      const input = {
        bytes: unhex(c.bytes),
        phoneKey: unhex(c.phoneKey),
        mode: c.mode,
        ...(c.accountId !== undefined ? { accountId: unhex(c.accountId) } : {}),
        highest: BigInt(c.highest),
        ...(c.self ? { self: deviceKeys(c.self) } : {}),
      };
      if ("throws" in c.expect) assert.throws(() => e2e.checkList(input), TypeError, c.about);
      else assert.deepEqual(expectOf(e2e.checkList(input)), c.expect, c.about);
    }
    ran++;
  }
  assert.equal(file.cases.length - ran, file.cases.filter((c) => c.check === "make-list").length, "only the maker's cases are left out");
});

test("framed's lengths past 32 bits, by hand", () => {
  const cases: [number, string][] = [
    [2 ** 31 - 1, "ffffffff07"],
    [2 ** 31, "8080808008"],
    [2 ** 32 - 1, "ffffffff0f"],
    [2 ** 32, "8080808010"],
    [Number.MAX_SAFE_INTEGER, "ffffffffffffff0f"],
  ];
  for (const [n, want] of cases) assert.equal(hex(Uint8Array.from(leb128(n))), want, String(n));
  for (const n of [-1, 1.5, 2 ** 53]) assert.throws(() => leb128(n), RangeError, String(n));
});

test("no input makes the list check throw", () => {
  const key = new Uint8Array(32);
  for (const bytes of [new Uint8Array(0), new Uint8Array(64), new Uint8Array(200).fill(0xff)]) {
    for (const phoneKey of [key, new Uint8Array(0), new Uint8Array(31)]) {
      assert.equal(e2e.checkList({ bytes, phoneKey, mode: "first", highest: 0n }).result, "refused");
      assert.equal(e2e.checkList({ bytes, phoneKey, mode: "later", accountId: new Uint8Array(32), highest: 0n }).result, "refused");
    }
  }
});

test("a caller's mistakes throw", () => {
  const bytes = new Uint8Array(100);
  const phoneKey = new Uint8Array(32);
  for (const accountId of [undefined, new Uint8Array(0), new Uint8Array(31), new Uint8Array(33)]) {
    assert.throws(() => e2e.checkList({ bytes, phoneKey, mode: "later", ...(accountId ? { accountId } : {}), highest: 0n }), TypeError);
  }
  const self = { role: 1, signingKey: new Uint8Array(32) };
  assert.throws(() => e2e.checkList({ bytes, phoneKey, mode: "later", accountId: new Uint8Array(32), highest: 0n, self: self as never }), TypeError);
  for (const accountId of [new Uint8Array(31), "00".repeat(32)]) {
    assert.throws(() => e2e.checkList({ bytes, phoneKey, mode: "first", accountId: accountId as Uint8Array, highest: 0n }), TypeError);
  }
  const otherRealm = runInNewContext("new Uint8Array(32)") as Uint8Array;
  assert.equal(e2e.checkList({ bytes, phoneKey, mode: "later", accountId: otherRealm, highest: 0n }).result, "refused");
  for (const highest of [undefined, 1, -1n]) {
    assert.throws(() => e2e.checkList({ bytes, phoneKey, mode: "first", highest: highest as bigint }), TypeError);
  }
});

test("an accepted list shares no bytes with the caller's buffer", () => {
  const c = read<ListCase>("list.json").cases.find((c) => c.check === "list" && c.about === "version 2");
  assert.ok(c && c.check === "list");
  const buffer = Buffer.from(unhex(c.bytes));
  const r = e2e.checkList({ bytes: buffer, phoneKey: unhex(c.phoneKey), mode: "later", accountId: unhex(c.accountId!), highest: 1n });
  assert.equal(r.result, "accepted");
  const before = hex(r.list.devices[1].signingKey);
  buffer.fill(0xaa);
  assert.equal(hex(r.list.devices[1].signingKey), before);
});

test("the checks are given only after libsodium has started, the same each time", async () => {
  assert.equal(await load(), e2e);
});
