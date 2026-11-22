// Every case in cases/e2e/ that the package can run, against the package. Which parts it has is stated here; a case
// needing any other is left out, and the count run is checked against the
// file.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

import sodium from "libsodium-wrappers-sumo";

import { framed, framedNumber, leb128 } from "../framed.ts";
import { CAPS, load } from "../index.ts";
import { openSealed, sealWithNonces } from "../sealed.ts";
import {
  CASES_DIR,
  deviceKeys,
  expectOf,
  hex,
  listView,
  namesExpectOf,
  openExpectOf,
  sealedJson,
  slotOf,
  unhex,
  type CaseFile,
  type FramedCase,
  type ListCase,
  type NamesCase,
  type SealedCase,
} from "./cases.ts";

/**
 * The parts this package has. It makes no lists or names (make-list,
 * make-names: the phone's) and opens no notices (notice: the phone's and
 * the notification extension's).
 */
const HAS = new Set(["first-mode", "self", "seal", "announcement", "names"]);
/** The checks this runner knows, by file. */
const CHECKS: Record<string, Set<string>> = {
  "framed.json": new Set(["framed", "number"]),
  "list.json": new Set(["list", "verify"]),
  "sealed.json": new Set(["open", "seal"]),
  "names.json": new Set(["open-names"]),
};

/**
 * What each check's cases hold: every key in required, exactly one of
 * oneOf, and nothing else; expect's keys from expectKeys.
 */
const SHAPES: Record<string, { required: string[]; optional?: string[]; oneOf?: string[]; expectKeys?: string[] }> = {
  framed: { required: ["check", "about", "needs", "context", "parts"], oneOf: ["bytes", "throws"] },
  number: { required: ["check", "about", "needs", "value"], oneOf: ["bytes", "throws"] },
  list: { required: ["check", "about", "needs", "bytes", "phoneKey", "mode", "highest", "expect"], optional: ["accountId", "self", "go"], expectKeys: ["result", "reason", "counter", "hash", "list", "throws"] },
  "make-list": { required: ["check", "about", "needs", "seed", "accountId", "counter", "previousBody", "devices", "bytes"] },
  verify: { required: ["check", "about", "needs", "key", "message", "signature", "valid"] },
  open: { required: ["check", "about", "needs", "sealed", "slot", "recipientSecretKey", "list", "now", "expect"], optional: ["highest"], expectKeys: ["result", "reason", "ordering", "body"] },
  seal: { required: ["check", "about", "needs", "list", "boxSecretKey", "slot", "ordering", "body", "nonces", "recipientSecretKeys", "expect"], expectKeys: ["copies", "skipped", "opened", "throws"] },
  "open-names": { required: ["check", "about", "needs", "sealed", "accountId", "list", "phoneKey", "recipientSecretKey", "now", "expect"], optional: ["highest"], expectKeys: ["result", "reason", "ordering", "listCounter", "names", "dropped"] },
  "make-names": { required: ["check", "about", "needs", "accountId", "list", "phoneSeed", "phoneBoxSecretKey", "ordering", "names", "nonces", "expect"], expectKeys: ["copies", "skipped"] },
};
const DEVICE_KEYS = ["role", "signingKey", "channelKey", "boxKey", "readOnlyKey", "notificationKey"];
const SLOT_KEYS = ["accountId", "computerKey", "sessionId", "kind"];
/** A need, and what in a case makes it need it. */
const EVIDENCE: Record<string, (c: Record<string, unknown>) => boolean> = {
  self: (c) => "self" in c,
  "make-list": (c) => c.check === "make-list",
  seal: (c) => c.check === "seal",
  announcement: (c) => c.check === "open" && (c.slot as { kind?: string }).kind === "announcement",
  notice: (c) => c.check === "open" && (c.slot as { kind?: string }).kind === "notice",
  names: (c) => c.check === "open-names",
  "make-names": (c) => c.check === "make-names",
};

const sameKeys = (o: unknown, keys: string[], what: string) => assert.deepEqual(Object.keys(o as object).sort(), [...keys].sort(), what);

function shapeOf(where: string, c: Record<string, unknown>): void {
  const shape = SHAPES[String(c.check)];
  assert.ok(shape, `${where}: unknown check ${String(c.check)}`);
  const keys = Object.keys(c);
  for (const k of shape.required) assert.ok(k in c, `${where}: no ${k}`);
  if (shape.oneOf) assert.equal(shape.oneOf.filter((k) => k in c).length, 1, `${where}: not exactly one of ${shape.oneOf.join(", ")}`);
  const allowed = new Set([...shape.required, ...(shape.optional ?? []), ...(shape.oneOf ?? [])]);
  for (const k of keys) assert.ok(allowed.has(k), `${where}: unknown key ${k}`);
  for (const k of ["expect", "go"]) {
    if (!(k in c)) continue;
    const e = c[k] as Record<string, unknown>;
    for (const ek of Object.keys(e)) assert.ok(shape.expectKeys?.includes(ek), `${where}: unknown key ${k}.${ek}`);
    if (shape.expectKeys?.includes("result")) assert.notEqual("result" in e, "throws" in e, `${where}: ${k} has not exactly one of result and throws`);
    else assert.notEqual("copies" in e, "throws" in e, `${where}: ${k} has not exactly one of copies and throws`);
  }
  const needs = c.needs as string[];
  for (const n of needs) assert.ok(n === "first-mode" || n in EVIDENCE, `${where}: unknown need ${n}`);
  for (const [n, has] of Object.entries(EVIDENCE)) assert.equal(needs.includes(n), has(c), `${where}: needs ${n} iff the case shows it`);
  if ("self" in c) sameKeys(c.self, DEVICE_KEYS, `${where}: self's keys`);
  if ("slot" in c) sameKeys(c.slot, SLOT_KEYS, `${where}: the slot's keys`);
  const devices = [...((c.devices as object[] | undefined) ?? []), ...(((c.list as { devices?: object[] } | undefined)?.devices) ?? [])];
  if ("list" in c && c.check !== "list") sameKeys(c.list, ["counter", "devices"], `${where}: the list's keys`);
  for (const d of devices) sameKeys(d, DEVICE_KEYS, `${where}: a device's keys`);
}

/** A file of cases/e2e, its shape checked: no unknown key, every needed key present, at least one case. */
function read<C>(name: string): CaseFile<C> {
  const file = JSON.parse(readFileSync(new URL(name, CASES_DIR), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(file).sort(), ["about", "cases"], `${name}: its keys`);
  assert.ok(Array.isArray(file.cases) && file.cases.length > 0, `${name}: no cases`);
  (file.cases as Record<string, unknown>[]).forEach((c, i) => shapeOf(`${name}, case ${i}`, c));
  return file as unknown as CaseFile<C>;
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

test("sealed.json", () => {
  const file = read<SealedCase>("sealed.json");
  let ran = 0;
  for (const c of file.cases) {
    if (!runnable("sealed.json", c)) continue;
    if (c.check === "open") {
      const r = e2e.openAnnouncement({
        sealed: unhex(c.sealed),
        slot: slotOf(c.slot),
        recipientSecretKey: unhex(c.recipientSecretKey),
        list: listView(c.list),
        highest: c.highest === undefined ? null : BigInt(c.highest),
        now: BigInt(c.now),
      });
      assert.deepEqual(openExpectOf(r), c.expect, c.about);
    } else {
      const input = { list: listView(c.list), boxSecretKey: unhex(c.boxSecretKey), slot: slotOf(c.slot), ordering: BigInt(c.ordering), body: c.body as never };
      const nonces = c.nonces.map(unhex);
      if ("throws" in c.expect) {
        assert.throws(() => sealWithNonces(sodium, input, (i) => nonces[i]), TypeError, c.about);
        assert.throws(() => e2e.seal(input), TypeError, c.about);
      } else {
        const { opened, ...copies } = c.expect;
        assert.equal(opened !== undefined, c.expect.copies.length > 0, `${c.about}: an opened text exactly when there are copies`);
        assert.deepEqual(sealedJson(sealWithNonces(sodium, input, (i) => nonces[i])), copies, c.about);
        // With random nonces: the same recipients, a fresh nonce for every
        // copy within a call and across calls, and each copy opening for its
        // recipient to the body.
        const one = e2e.seal(input);
        const two = e2e.seal(input);
        for (const random of [one, two]) {
          const j = sealedJson(random);
          assert.deepEqual(j.copies.map((x) => x.recipientKey), c.expect.copies.map((x) => x.recipientKey), c.about);
          assert.deepEqual(j.skipped, c.expect.skipped, c.about);
        }
        const used = [...one.copies, ...two.copies].map((x) => hex(x.sealed.subarray(0, 24)));
        assert.equal(new Set(used).size, used.length, `${c.about}: every nonce fresh`);
        for (const random of [one.copies, two.copies, sealWithNonces(sodium, input, (i) => nonces[i]).copies]) {
          random.forEach((x, i) => {
            const r = openSealed(sodium, input.slot.kind, { sealed: x.sealed, slot: input.slot, recipientSecretKey: unhex(c.recipientSecretKeys[i]), list: input.list, highest: null, now: input.ordering });
            assert.deepEqual(openExpectOf(r), { result: "accepted", ordering: c.ordering, body: opened }, `${c.about}: copy ${i} opens`);
          });
        }
      }
    }
    ran++;
  }
  assert.equal(file.cases.length - ran, file.cases.filter((c) => c.needs.includes("notice")).length, "only the notices' opening is left out");
});

test("names.json", () => {
  const file = read<NamesCase>("names.json");
  let ran = 0;
  for (const c of file.cases) {
    if (!runnable("names.json", c) || c.check !== "open-names") continue;
    const r = e2e.openNames({
      sealed: unhex(c.sealed),
      accountId: unhex(c.accountId),
      list: listView(c.list),
      phoneKey: unhex(c.phoneKey),
      recipientSecretKey: unhex(c.recipientSecretKey),
      highest: c.highest === undefined ? null : BigInt(c.highest),
      now: BigInt(c.now),
    });
    assert.deepEqual(namesExpectOf(r), c.expect, c.about);
    ran++;
  }
  assert.equal(file.cases.length - ran, file.cases.filter((c) => c.check === "make-names").length, "only the maker's cases are left out");
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

test("no input makes opening throw", () => {
  const c = read<SealedCase>("sealed.json").cases.find((c) => c.check === "open" && c.about === "an announcement");
  assert.ok(c && c.check === "open");
  const list = listView(c.list);
  const slot = slotOf(c.slot);
  for (const sealed of [new Uint8Array(0), new Uint8Array(40), new Uint8Array(1000).fill(0xff), unhex(c.sealed)]) {
    for (const key of [new Uint8Array(0), new Uint8Array(31), new Uint8Array(32), unhex(c.recipientSecretKey)]) {
      for (const sessionId of [new Uint8Array(0), slot.sessionId, Uint8Array.of(0xff)]) {
        const s = { ...slot, sessionId };
        for (const l of [list, { counter: 0n, devices: [] }]) {
          const r = e2e.openAnnouncement({ sealed, slot: s, recipientSecretKey: key, list: l, highest: null, now: 0n });
          assert.ok(r.result === "accepted" || r.result === "refused");
          const n = e2e.openNames({ sealed, accountId: s.accountId, list: l, phoneKey: s.computerKey, recipientSecretKey: key, highest: null, now: 0n });
          assert.ok(n.result === "accepted" || n.result === "later" || n.result === "refused");
        }
      }
    }
  }
});

test("sealing's and opening's caller mistakes throw", () => {
  const c = read<SealedCase>("sealed.json").cases.find((c) => c.check === "seal" && !("throws" in c.expect));
  assert.ok(c && c.check === "seal");
  const good = { list: listView(c.list), boxSecretKey: unhex(c.boxSecretKey), slot: slotOf(c.slot), ordering: BigInt(c.ordering), body: c.body as never };
  for (const bad of [
    { ordering: 2n ** 63n },
    { ordering: -1n },
    { ordering: 1 as unknown as bigint },
    { boxSecretKey: new Uint8Array(31) },
    { body: { sessionName: "x" } as never },
    { slot: { ...good.slot, kind: "other" as never } },
    { list: { devices: [] } as never },
  ]) {
    assert.throws(() => e2e.seal({ ...good, ...bad }), TypeError, JSON.stringify(Object.keys(bad)));
  }
  // Checked before the list is read: a computer not on it still throws.
  const unlisted = { ...good.slot, computerKey: new Uint8Array(32) };
  assert.equal(e2e.seal({ ...good, slot: unlisted }).copies.length, 0);
  assert.throws(() => e2e.seal({ ...good, slot: unlisted, boxSecretKey: new Uint8Array(31) }), TypeError);
  // A nonce of the wrong length is the tests' own mistake, never a skipped recipient.
  assert.throws(() => sealWithNonces(sodium, good, () => new Uint8Array(23)), TypeError);
  const open = { sealed: new Uint8Array(100), slot: good.slot, recipientSecretKey: new Uint8Array(32), list: good.list, highest: null, now: 0n };
  for (const bad of [{ highest: -1n }, { highest: 1 as unknown as bigint }, { now: 0 as unknown as bigint }, { sealed: "00" as unknown as Uint8Array }]) {
    assert.throws(() => e2e.openAnnouncement({ ...open, ...bad }), TypeError);
    assert.throws(() => e2e.openNames({ ...open, accountId: good.slot.accountId, phoneKey: good.slot.computerKey, ...bad }), TypeError);
  }
});

test("the caps cannot be changed", () => {
  assert.ok(Object.isFrozen(CAPS) && Object.isFrozen(CAPS.announcement) && Object.isFrozen(CAPS.notice));
});

test("the checks are given only after libsodium has started, the same each time", async () => {
  assert.equal(await load(), e2e);
});
