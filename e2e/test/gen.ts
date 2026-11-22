// Writes cases/e2e/framed.json and cases/e2e/list.json from fixed seeds.
// With --check it writes nothing, and fails if either file would change.
//
//   node --experimental-transform-types --no-warnings e2e/test/gen.ts [--check]
//
// Each case states the result and reason it must have, and the generator
// fails if the package's code gives anything else; what it writes beyond
// that (counters, hashes, the parsed list) is what the code gives. framed's
// expected bytes are also written out by hand below, and RFC 8032's test 1
// holds the raw Ed25519 calls to a published answer.
//
// The list maker and the raw signing here are test-only: no device makes
// lists in TypeScript.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { DeviceSchema, ListBodySchema } from "@pirc/protocol/v1alpha2";
import sodium from "libsodium-wrappers-sumo";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { framed, framedNumber, LIST_CONTEXT, load, type DeviceKeys, type ListInput } from "../index.ts";
import { CASES_DIR, deviceJson, expectOf, hex, unhex, type CaseFile, type Expect, type FramedCase, type ListCase } from "./cases.ts";

await sodium.ready;
const e2e = await load();

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const EMPTY = new Uint8Array(0);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(`gen: ${what}`);
}

const fill = (n: number, start: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (start + i * 7) & 0xff);
const sha256 = (b: Uint8Array): Uint8Array => sodium.crypto_hash_sha256(b);
const seed = (name: string): Uint8Array => sha256(utf8(`pirc e2e test seed: ${name}`));

// ---------------------------------------------------------------- framed.json

function framedCases(): FramedCase[] {
  const out: FramedCase[] = [];
  const build = (about: string, context: string, parts: Uint8Array[], byHand: string): void => {
    const bytes = framed(context, ...parts);
    must(hex(bytes) === byHand, `framed by hand: ${about}`);
    out.push({ check: "framed", about, needs: [], context, parts: parts.map(hex), bytes: hex(bytes) });
  };
  const refuse = (about: string, context: string): void => {
    let threw = false;
    try {
      framed(context, utf8("x"));
    } catch {
      threw = true;
    }
    must(threw, `framed refuses: ${about}`);
    out.push({ check: "framed", about, needs: [], context, parts: [hex(utf8("x"))], throws: true });
  };

  // The expected bytes are typed here: the context's ASCII, 00, then each
  // part's LEB128 length before it.
  build("no parts", "pirc-e2e-v2 list", [], "706972632d6532652d7632206c69737400");
  build("one empty part", "ab", [EMPTY], "61620000");
  build("a part of 1 byte", "ab", [Uint8Array.of(0x07)], "6162000107");
  const p127 = fill(127, 1);
  build("a part of 127 bytes: one length byte", "ab", [p127], "6162007f" + hex(p127));
  const p128 = fill(128, 2);
  build("a part of 128 bytes: two length bytes", "ab", [p128], "6162008001" + hex(p128));
  const p16383 = fill(16_383, 3);
  build("a part of 16,383 bytes: two length bytes", "ab", [p16383], "616200ff7f" + hex(p16383));
  const p16384 = fill(16_384, 4);
  build("a part of 16,384 bytes: three length bytes", "ab", [p16384], "616200808001" + hex(p16384));
  build("an empty part, then 200 bytes (relay/internal/hosted's TestFramed)", "ab", [EMPTY, new Uint8Array(200).fill(7)], "61620000c801" + "07".repeat(200));
  build("several parts, as the list's signature", "pirc-e2e-v2 list", [EMPTY, Uint8Array.of(1, 2, 3)], "706972632d6532652d7632206c6973740000" + "03010203");
  build("a context with 0x20 and 0x7E", "a ~", [Uint8Array.of(0xff)], "61207e0001ff");

  refuse("an empty context", "");
  refuse("a context with 0x7F", "a\x7f");
  refuse("a context with a NUL", "a\x00b");
  refuse("a context with 0x1F", "a\x1f");
  refuse("a context with a character above 0x7F", "café");

  const number = (about: string, value: bigint, byHand: string): void => {
    const bytes = framedNumber(value);
    must(hex(bytes) === byHand, `number by hand: ${about}`);
    out.push({ check: "number", about, needs: [], value: value.toString(), bytes: hex(bytes) });
  };
  number("0", 0n, "0000000000000000");
  number("2^53+1, past what a double holds exactly", 2n ** 53n + 1n, "0020000000000001");
  number("2^63-1, the largest", 2n ** 63n - 1n, "7fffffffffffffff");
  let threw = false;
  try {
    framedNumber(2n ** 63n);
  } catch {
    threw = true;
  }
  must(threw, "number refuses 2^63");
  out.push({ check: "number", about: "2^63, refused", needs: [], value: (2n ** 63n).toString(), throws: true });
  return out;
}

// ------------------------------------------------------------ devices and keys

type Dev = DeviceKeys;
const COMPUTER = 1;
const CLIENT = 2;

function device(name: string, role: number, phone: boolean): Dev {
  return {
    role,
    signingKey: sodium.crypto_sign_seed_keypair(seed(`${name} signing`)).publicKey,
    channelKey: sodium.crypto_box_seed_keypair(seed(`${name} channel`)).publicKey,
    boxKey: sodium.crypto_box_seed_keypair(seed(`${name} box`)).publicKey,
    readOnlyKey: phone ? sodium.crypto_sign_seed_keypair(seed(`${name} read-only`)).publicKey : EMPTY,
    notificationKey: phone ? sodium.crypto_box_seed_keypair(seed(`${name} notification`)).publicKey : EMPTY,
  };
}
const computer = (name: string): Dev => device(name, COMPUTER, false);
const browser = (name: string): Dev => device(name, CLIENT, false);
const phone = (name: string): Dev => device(name, CLIENT, true);
const signingSecret = (name: string): Uint8Array => sodium.crypto_sign_seed_keypair(seed(`${name} signing`)).privateKey;

// ------------------------------------------- protobuf by hand, and the maker

type Field = { no: number; varint: bigint } | { no: number; bytes: Uint8Array };

function varint(v: bigint): number[] {
  const out: number[] = [];
  do {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v > 0n ? b | 0x80 : b);
  } while (v > 0n);
  return out;
}

function encode(fields: Field[]): Uint8Array {
  const out: number[] = [];
  for (const f of fields) {
    if ("varint" in f) out.push(...varint(BigInt(f.no << 3)), ...varint(f.varint));
    else {
      out.push(...varint(BigInt((f.no << 3) | 2)), ...varint(BigInt(f.bytes.length)));
      for (const b of f.bytes) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

function deviceFields(d: Dev, extra: Field[] = []): Field[] {
  const f: Field[] = [];
  if (d.role !== 0) f.push({ no: 1, varint: BigInt(d.role) });
  const keys = [d.signingKey, d.channelKey, d.boxKey, d.readOnlyKey, d.notificationKey];
  keys.forEach((k, i) => {
    if (k.length > 0) f.push({ no: i + 2, bytes: k });
  });
  return [...f, ...extra];
}

interface Body {
  accountId: Uint8Array;
  counter: bigint;
  previousHash: Uint8Array;
  devices: Dev[];
}

function bodyFields(b: Body, deviceExtra: Map<number, Field[]> = new Map()): Field[] {
  const f: Field[] = [];
  if (b.accountId.length > 0) f.push({ no: 1, bytes: b.accountId });
  if (b.counter !== 0n) f.push({ no: 2, varint: b.counter });
  if (b.previousHash.length > 0) f.push({ no: 3, bytes: b.previousHash });
  b.devices.forEach((d, i) => f.push({ no: 4, bytes: encode(deviceFields(d, deviceExtra.get(i))) }));
  return f;
}

/** A body as protobuf-es writes it, which must equal the encoding by hand. */
function body(b: Body): Uint8Array {
  const made = toBinary(ListBodySchema, create(ListBodySchema, { ...b, devices: b.devices.map((d) => create(DeviceSchema, d)) }));
  must(equal(made, encode(bodyFields(b))), "protobuf-es and the encoding by hand differ");
  return made;
}

function signList(b: Uint8Array, accountId: Uint8Array, secret: Uint8Array, context = LIST_CONTEXT): Uint8Array {
  return concat(sodium.crypto_sign_detached(framed(context, accountId, b), secret), b);
}

/** The test-only list maker: what the account's phone does (in Dart), without its checks. */
function makeList(m: { seed: Uint8Array; accountId: Uint8Array; counter: bigint; previousBody: Uint8Array | null; devices: Dev[] }): Uint8Array {
  const b = body({ accountId: m.accountId, counter: m.counter, previousHash: m.previousBody ? sha256(m.previousBody) : EMPTY, devices: m.devices });
  return signList(b, m.accountId, sodium.crypto_sign_seed_keypair(m.seed).privateKey);
}

// ------------------------------------------------- Ed25519 made by hand

// Signatures no honest signer makes, built from libsodium's group
// operations and scalars here: small-order R, non-canonical S, and keys of
// small, mixed or non-canonical encoding.
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const le32 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(32);
  let v = ((n % 2n ** 256n) + 2n ** 256n) % 2n ** 256n;
  for (let i = 0; i < 32; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
};
const fromLe = (b: Uint8Array): bigint => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
const IDENTITY = unhex("0100000000000000000000000000000000000000000000000000000000000000");
// A point of order 8, canonically encoded.
const T8 = unhex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05");
// y = p + 1: a non-canonical encoding of the identity.
const NONCANONICAL_IDENTITY = unhex("ee" + "ff".repeat(30) + "7f");

{
  const t4 = sodium.crypto_core_ed25519_add(T8, T8);
  const t2 = sodium.crypto_core_ed25519_add(t4, t4);
  must(!equal(t2, IDENTITY) && equal(sodium.crypto_core_ed25519_add(t2, t2), IDENTITY), "T8 has order 8");
}

/** Ed25519's secret scalar for a seed, and its public key. */
function scalar(name: string): { a: bigint; A: Uint8Array } {
  const h = sodium.crypto_hash_sha512(seed(`${name} signing`)).slice(0, 32);
  h[0] &= 248;
  h[31] &= 127;
  h[31] |= 64;
  const a = fromLe(h);
  const A = sodium.crypto_scalarmult_ed25519_base_noclamp(le32(a % L));
  must(equal(A, sodium.crypto_sign_seed_keypair(seed(`${name} signing`)).publicKey), "the scalar's key is libsodium's");
  return { a, A };
}

const r = fromLe(sodium.crypto_hash_sha512(utf8("pirc e2e test: the nonce"))) % L;
const R = sodium.crypto_scalarmult_ed25519_base_noclamp(le32(r));
const challenge = (Rb: Uint8Array, A: Uint8Array, m: Uint8Array): bigint => fromLe(sodium.crypto_hash_sha512(concat(Rb, A, m))) % L;
/** R = [r]B, S = r + h*a: an honest signature, also under a key with a small-order part added. */
const signBy = (a: bigint, A: Uint8Array, m: Uint8Array): Uint8Array => concat(R, le32((r + challenge(R, A, m) * a) % L));

// ------------------------------------------------------------- the accounts

const P = phone("phone");
const pSecret = signingSecret("phone");
const C1 = computer("computer 1");
const C2 = computer("computer 2");
const W1 = browser("browser 1");
const Q = phone("phone 2");

const v1 = body({ accountId: EMPTY, counter: 1n, previousHash: EMPTY, devices: [P] });
const idA = sha256(v1);
const v2 = body({ accountId: idA, counter: 2n, previousHash: sha256(v1), devices: [P, C1, W1] });
const v3 = body({ accountId: idA, counter: 3n, previousHash: sha256(v2), devices: [P, C1, C2, Q] });
const list1 = signList(v1, EMPTY, pSecret);
const list2 = signList(v2, idA, pSecret);
const list3 = signList(v3, idA, pSecret);

/** A later version of account A with these devices, signed by its phone. */
function laterA(devices: Dev[], counter = 2n, prev: Uint8Array = v1): { bytes: Uint8Array; body: Uint8Array } {
  const b = body({ accountId: idA, counter, previousHash: sha256(prev), devices });
  return { bytes: signList(b, idA, pSecret), body: b };
}

// Account B: the same phone signing key, its other keys new, so its ID
// differs from A's.
const PB = { ...phone("phone, account B"), signingKey: P.signingKey };
const v1B = body({ accountId: EMPTY, counter: 1n, previousHash: EMPTY, devices: [PB] });
const idB = sha256(v1B);
const v2B = body({ accountId: idB, counter: 2n, previousHash: sha256(v1B), devices: [PB, C1] });

/**
 * An account whose phone's signing key is `key`, and its version 2, the
 * computer's name searched for until `wanted` holds for the signed string.
 */
function oddAccount(name: string, key: Uint8Array, sign: (m: Uint8Array) => Uint8Array, wanted: (m: Uint8Array) => boolean = () => true) {
  const ph = { ...phone(name), signingKey: key };
  const first = body({ accountId: EMPTY, counter: 1n, previousHash: EMPTY, devices: [ph] });
  const id = sha256(first);
  for (let i = 0; i < 1000; i++) {
    const b = body({ accountId: id, counter: 2n, previousHash: sha256(first), devices: [ph, computer(`${name}, computer ${i}`)] });
    const m = framed(LIST_CONTEXT, id, b);
    if (wanted(m)) return { bytes: concat(sign(m), b), body: b, id, key };
  }
  throw new Error(`gen: no body found for ${name}`);
}

// ------------------------------------------------------------- list.json

type Want = { result: "accepted" | "old" } | { result: "unsupported" | "refused"; reason: string } | "throws";

const listOut: ListCase[] = [];

/** The relay's result on a body Go's Ed25519 lets through: accepted, with the body's own counter. */
function goExpect(b: Uint8Array): { result: "accepted"; counter: string; hash: string } {
  const counter = fromBinary(ListBodySchema, b).counter;
  must(counter === 2n, "go: the bodies Go accepts are version 2");
  return { result: "accepted", counter: counter.toString(), hash: hex(sha256(b)) };
}

function check(
  about: string,
  input: { bytes: Uint8Array; phoneKey?: Uint8Array; mode: "first" | "later"; accountId?: Uint8Array; highest?: bigint; self?: Dev },
  want: Want,
  go?: { result: "accepted"; body: Uint8Array },
): void {
  const full: ListInput = { phoneKey: P.signingKey, highest: 0n, ...input };
  const needs = [...(full.mode === "first" ? ["first-mode"] : []), ...(full.self ? ["self"] : [])];
  let expect: Expect;
  if (want === "throws") {
    let threw = false;
    try {
      e2e.checkList(full);
    } catch {
      threw = true;
    }
    must(threw, `${about}: throws`);
    expect = { throws: true };
  } else {
    const got = e2e.checkList(full);
    const reason = "reason" in got ? got.reason : undefined;
    must(got.result === want.result && reason === ("reason" in want ? want.reason : undefined), `${about}: wanted ${JSON.stringify(want)}, got ${got.result} ${reason ?? ""}`);
    expect = expectOf(got);
  }
  listOut.push({
    check: "list",
    about,
    needs,
    bytes: hex(full.bytes),
    phoneKey: hex(full.phoneKey),
    mode: full.mode,
    ...(full.accountId ? { accountId: hex(full.accountId) } : {}),
    highest: full.highest.toString(),
    ...(full.self ? { self: deviceJson(full.self) } : {}),
    expect,
    ...(go ? { go: goExpect(go.body) } : {}),
  });
}

function listCases(): ListCase[] {
  const later = (bytes: Uint8Array, highest = 1n) => ({ bytes, mode: "later" as const, accountId: idA, highest });
  const accepted = { result: "accepted" } as const;
  const old = { result: "old" } as const;
  const refused = (reason: string) => ({ result: "refused" as const, reason });
  const unsupported = (reason: string) => ({ result: "unsupported" as const, reason });

  // Accepted.
  check("version 1, at a join", { bytes: list1, mode: "first" }, accepted);
  check("version 1 re-read with its ID", { bytes: list1, mode: "first", accountId: idA }, accepted);
  check("version 2", later(list2), accepted);
  check("version 3", later(list3, 2n), accepted);
  check("version 3 with version 1 the highest held", later(list3, 1n), accepted);
  check("version 2, joining as a listed computer", { ...later(list2), self: C1 }, accepted);
  check("version 3, joining as a listed phone with its phone keys", { ...later(list3, 2n), self: Q }, accepted);
  const many = [P, ...Array.from({ length: 9 }, (_, i) => phone(`phone ${i + 3}`)), ...Array.from({ length: 50 }, (_, i) => computer(`computer ${i + 3}`))];
  const largest = laterA(many, 4n, v3).bytes;
  must(largest.length < 16_384, "the largest list fits");
  check(`the largest allowed list, 10 phones and 50 computers, ${largest.length} bytes`, later(largest, 3n), accepted);
  check("counter 2^63-1", later(laterA([P, C1], 2n ** 63n - 1n).bytes, 3n), accepted);
  {
    const fields = bodyFields({ accountId: idA, counter: 1n, previousHash: sha256(v1), devices: [P, C1] });
    fields.splice(2, 0, { no: 2, varint: 2n });
    check("the counter twice, 1 then 2: the last is the one read", later(signList(encode(fields), idA, pSecret)), accepted);
  }
  const mixed = scalar("mixed phone");
  const mixedKey = sodium.crypto_core_ed25519_add(mixed.A, T8);
  const mixedOk = oddAccount("mixed phone", mixedKey, (m) => signBy(mixed.a, mixedKey, m), (m) => challenge(R, mixedKey, m) % 8n === 0n);
  check("a mixed-order phone key, the body found so that libsodium accepts it (h mod L divisible by 8)", { bytes: mixedOk.bytes, phoneKey: mixedKey, mode: "later", accountId: mixedOk.id, highest: 1n }, accepted);

  // The size limit lets a list of exactly 16,384 bytes through.
  {
    const base = bodyFields({ accountId: idA, counter: 4n, previousHash: sha256(v3), devices: [P, C1] });
    const padded = (n: number) => encode([...base, { no: 15, bytes: new Uint8Array(n) }]);
    let n = 16_384 - 64 - encode(base).length - 8;
    while (64 + padded(n).length < 16_384) n++;
    must(64 + padded(n).length === 16_384, "a list of exactly 16,384 bytes");
    check("exactly 16,384 bytes, padded by an unknown field: through the size check", later(signList(padded(n), idA, pSecret), 3n), unsupported("unknown-field"));
    check("16,385 bytes", later(signList(padded(n + 1), idA, pSecret), 3n), refused("size"));
  }

  // Size.
  check("empty", later(EMPTY), refused("size"));
  check("63 bytes", later(list2.slice(0, 63)), refused("size"));
  check("64 bytes: a signed empty body, through the size check", later(signList(EMPTY, idA, pSecret)), refused("mode"));

  // Signature.
  {
    const bad = list2.slice();
    bad[10] ^= 0x01;
    check("a signature with one bit changed", later(bad), refused("signature"));
  }
  check("signed by another key", later(signList(v2, idA, signingSecret("another phone"))), refused("signature"));
  check("signed under another context (names)", later(signList(v2, idA, pSecret, "pirc-e2e-v2 names")), refused("signature"));
  {
    const pa = scalar("phone");
    const m = framed(LIST_CONTEXT, idA, v2);
    const sig = concat(IDENTITY, le32((challenge(IDENTITY, P.signingKey, m) * pa.a) % L));
    check("a small-order R (the identity), S = h*a: libsodium refuses it", later(concat(sig, v2)), refused("signature"), { result: "accepted", body: v2 });
    const s = fromLe(list2.slice(32, 64));
    must(s < L, "S is canonical");
    check("S + L, not canonical", later(concat(list2.slice(0, 32), le32(s + L), v2)), refused("signature"));
  }
  {
    const nc = oddAccount("non-canonical phone", NONCANONICAL_IDENTITY, () => concat(R, le32(r)));
    check("a non-canonical encoding as the pinned key (the identity, y = p + 1), R = [r]B, S = r", { bytes: nc.bytes, phoneKey: nc.key, mode: "later", accountId: nc.id, highest: 1n }, refused("signature"), { result: "accepted", body: nc.body });
    const so = oddAccount("small-order phone", T8, () => concat(R, le32(r)), (m) => challenge(R, T8, m) % 8n === 0n);
    check("a small-order pinned key (order 8), [h]A = 0, R = [r]B, S = r", { bytes: so.bytes, phoneKey: so.key, mode: "later", accountId: so.id, highest: 1n }, refused("signature"), { result: "accepted", body: so.body });
  }
  check("bytes appended that were not signed", later(concat(list2, encode([{ no: 9, varint: 1n }]))), refused("signature"));
  check("another account's good version 2, checked as this account's", later(signList(v2B, idB, pSecret)), refused("signature"));
  check("a good version 1 checked in later mode", later(list1, 0n), refused("signature"));
  {
    const mixedBad = oddAccount("mixed phone", mixedKey, (m) => signBy(mixed.a, mixedKey, m), (m) => challenge(R, mixedKey, m) % 8n !== 0n);
    check("a mixed-order phone key, the body's hash making libsodium refuse it (h mod L not divisible by 8)", { bytes: mixedBad.bytes, phoneKey: mixedKey, mode: "later", accountId: mixedBad.id, highest: 1n }, refused("signature"));
  }

  // Parse.
  {
    const cut = signList(v2.slice(0, v2.length - 10), idA, pSecret);
    check("a signed body cut short", later(cut), refused("parse"));
    const flipped = cut.slice();
    flipped[10] ^= 0x01;
    check("a body cut short under a signature with one bit changed: the signature, before the parse", later(flipped), refused("signature"));
  }

  // Range.
  check("counter 2^63", later(laterA([P, C1], 2n ** 63n).bytes, 3n), refused("range"));
  check("counter 2^63 in first mode: range, before mode", { bytes: signList(body({ accountId: EMPTY, counter: 2n ** 63n, previousHash: EMPTY, devices: [P] }), EMPTY, pSecret), mode: "first" }, refused("range"));

  // Mode.
  {
    const b = body({ accountId: idB, counter: 2n, previousHash: sha256(v1), devices: [P, C1, W1] });
    check("account_id another account's, signed under this account's ID", later(signList(b, idA, pSecret)), refused("mode"));
  }
  check("version 1 signed under this account's ID, checked in later mode", later(signList(v1, idA, pSecret), 0n), refused("mode"));
  check("counter 2 signed under the empty ID, checked in first mode", { bytes: signList(v2, EMPTY, pSecret), mode: "first" }, refused("mode"));
  {
    const withId = body({ accountId: idA, counter: 1n, previousHash: EMPTY, devices: [P] });
    check("counter 1 with an account ID, in first mode", { bytes: signList(withId, EMPTY, pSecret), mode: "first" }, refused("mode"));
    const withPrev = body({ accountId: EMPTY, counter: 1n, previousHash: sha256(v1), devices: [P] });
    check("version 1 with a previous hash", { bytes: signList(withPrev, EMPTY, pSecret), mode: "first" }, refused("mode"));
  }
  check("counter 2 in first mode, account_id and previous_hash empty: the counter alone", { bytes: signList(body({ accountId: EMPTY, counter: 2n, previousHash: EMPTY, devices: [P] }), EMPTY, pSecret), mode: "first" }, refused("mode"));
  check("counter 1 in later mode, with the account's ID and a previous hash: the counter alone", later(laterA([P, C1, W1], 1n).bytes, 0n), refused("mode"));
  check("counter 1 in later mode with 1 held: mode, before old", later(laterA([P, C1, W1], 1n).bytes, 1n), refused("mode"));
  check("version 1 whose hash is not the expected ID", { bytes: list1, mode: "first", accountId: idB }, refused("mode"));
  {
    const v = (accountId: Uint8Array, previousHash: Uint8Array) => signList(body({ accountId, counter: 2n, previousHash, devices: [P, C1, W1] }), idA, pSecret);
    check("previous_hash of 31 bytes", later(v(idA, sha256(v1).slice(0, 31))), refused("mode"));
    check("previous_hash empty in version 2", later(v(idA, EMPTY)), refused("mode"));
    check("account_id empty in version 2", later(v(EMPTY, sha256(v1))), refused("mode"));
    check("account_id of 31 bytes, its first 31", later(v(idA.slice(0, 31), sha256(v1))), refused("mode"));
  }

  // Old.
  check("counter equal to the highest held", later(list2, 2n), old);
  check("counter below the highest held", later(list2, 3n), old);
  check("counter equal, another body (another hash)", later(laterA([P, C1, C2]).bytes, 2n), old);
  check("version 1 with 1 held", { bytes: list1, mode: "first", highest: 1n }, old);
  check("old, with a key twice too: still old", later(laterA([P, C1, C1]).bytes, 2n), old);

  // Unsupported.
  {
    const fields = bodyFields({ accountId: idA, counter: 2n, previousHash: sha256(v1), devices: [P, C1] });
    fields.splice(2, 0, { no: 9, varint: 7n });
    check("an unknown field in the body", later(signList(encode(fields), idA, pSecret)), unsupported("unknown-field"));
    const inDevice = bodyFields({ accountId: idA, counter: 2n, previousHash: sha256(v1), devices: [P, C1] }, new Map([[1, [{ no: 7, bytes: utf8("x") }]]]));
    check("an unknown field in a device", later(signList(encode(inDevice), idA, pSecret)), unsupported("unknown-field"));
    const appended = concat(laterA([P, C1]).body, encode([{ no: 9, varint: 1n }]));
    check("a signed body with an unknown field appended", later(signList(appended, idA, pSecret)), unsupported("unknown-field"));
  }
  check("role 0", later(laterA([P, { ...C1, role: 0 }]).bytes), unsupported("role"));
  check("role 3", later(laterA([P, { ...C1, role: 3 }]).bytes), unsupported("role"));
  for (const kind of ["signingKey", "channelKey", "boxKey"] as const) {
    for (const size of [31, 33, 0]) {
      const key = size > 32 ? concat(C1[kind], Uint8Array.of(0)) : C1[kind].slice(0, size);
      check(`a computer's ${kind} of ${size} bytes`, later(laterA([P, { ...C1, [kind]: key }]).bytes), unsupported("key"));
    }
  }
  check("a computer with a read-only key", later(laterA([P, { ...C1, readOnlyKey: Q.readOnlyKey }]).bytes), unsupported("phone-keys"));
  check("a computer with both phone keys", later(laterA([P, { ...C1, readOnlyKey: Q.readOnlyKey, notificationKey: Q.notificationKey }]).bytes), unsupported("phone-keys"));
  check("a phone with a notification key of 31 bytes beside its read-only key", later(laterA([P, { ...Q, notificationKey: Q.notificationKey.slice(0, 31) }]).bytes), unsupported("phone-keys"));
  check("a phone with a read-only key of 31 bytes beside its notification key", later(laterA([P, { ...Q, readOnlyKey: Q.readOnlyKey.slice(0, 31) }]).bytes), unsupported("phone-keys"));
  check("a client with a notification key only", later(laterA([P, { ...W1, notificationKey: Q.notificationKey }]).bytes), unsupported("phone-keys"));
  check("a computer with a notification key only", later(laterA([P, { ...C1, notificationKey: Q.notificationKey }]).bytes), unsupported("phone-keys"));
  check("a client with one phone key", later(laterA([P, { ...Q, notificationKey: EMPTY }]).bytes), unsupported("phone-keys"));
  check("a key twice in one device (channel and box)", later(laterA([P, { ...C1, boxKey: C1.channelKey }]).bytes), unsupported("duplicate-key"));
  check("a key twice across devices (two computers, one signing key)", later(laterA([P, C1, { ...C2, signingKey: C1.signingKey }]).bytes), unsupported("duplicate-key"));
  check("a key twice across kinds (a read-only key equal to another device's signing key)", later(laterA([P, C1, { ...Q, readOnlyKey: C1.signingKey }]).bytes), unsupported("duplicate-key"));
  check("a key twice across devices (two phones, one notification key)", later(laterA([P, C1, { ...Q, notificationKey: P.notificationKey }]).bytes), unsupported("duplicate-key"));
  check("11 clients and a key twice: duplicate-key, before count", later(laterA([P, ...Array.from({ length: 9 }, (_, i) => browser(`browser ${i + 2}`)), { ...browser("browser 11"), boxKey: C1.boxKey }, C1]).bytes), unsupported("duplicate-key"));
  check("11 clients", later(laterA([P, ...Array.from({ length: 10 }, (_, i) => browser(`browser ${i + 2}`))]).bytes), unsupported("count"));
  check("51 computers", later(laterA([P, ...Array.from({ length: 51 }, (_, i) => computer(`computer ${i + 3}`))]).bytes), unsupported("count"));
  check("no devices", later(laterA([]).bytes), unsupported("count"));
  check("version 1 with two devices", { bytes: signList(body({ accountId: EMPTY, counter: 1n, previousHash: EMPTY, devices: [P, C1] }), EMPTY, pSecret), mode: "first" }, unsupported("count"));
  check("the phone missing", later(laterA([C1, W1]).bytes), unsupported("phone"));
  check("the pinned key listed only as another device's read-only key", later(laterA([{ ...Q, readOnlyKey: P.signingKey }, C1]).bytes), unsupported("phone"));
  check("the phone listed as a computer", later(laterA([{ ...P, role: COMPUTER, readOnlyKey: EMPTY, notificationKey: EMPTY }, C1]).bytes), unsupported("phone"));
  check("the phone listed without its phone keys", later(laterA([{ ...P, readOnlyKey: EMPTY, notificationKey: EMPTY }, C1]).bytes), unsupported("phone"));

  // Self.
  check("joining, not on the list", { ...later(list2), self: C2 }, refused("self"));
  check("joining, on the list with another role", { ...later(list2), self: { ...C1, role: CLIENT } }, refused("self"));
  check("joining, on the list with one key different (the box key)", { ...later(list2), self: { ...C1, boxKey: C2.boxKey } }, refused("self"));
  for (const [key, other] of [
    ["signing", { signingKey: C2.signingKey }],
    ["channel", { channelKey: C2.channelKey }],
    ["box", { boxKey: C2.boxKey }],
    ["read-only", { readOnlyKey: phone("phone 9").readOnlyKey }],
    ["notification", { notificationKey: phone("phone 9").notificationKey }],
  ] as const) {
    check(`joining as a listed phone, its ${key} key alone different`, { ...later(list3, 2n), self: { ...Q, ...other } }, refused("self"));
  }
  check("joining as a phone, listed without its phone keys", { ...later(laterA([P, C1, { ...Q, readOnlyKey: EMPTY, notificationKey: EMPTY }]).bytes), self: Q }, refused("self"));
  check("self in first mode: the caller's mistake", { bytes: list1, mode: "first", self: P }, "throws");

  // The maker, to exact bytes. It shares body() and signList() with the
  // cases above, so its equality with list1 to list3 only ties each make
  // case to the same bytes as an accepted case; what holds those bytes is
  // body()'s comparison with the encoding by hand and the accepted cases.
  const phoneSeed = seed("phone signing");
  const make = (about: string, m: Parameters<typeof makeList>[0], want: Uint8Array): void => {
    const bytes = makeList(m);
    must(equal(bytes, want), `make: ${about}`);
    listOut.push({
      check: "make-list",
      about,
      needs: ["make-list"],
      seed: hex(m.seed),
      accountId: hex(m.accountId),
      counter: m.counter.toString(),
      previousBody: m.previousBody ? hex(m.previousBody) : "",
      devices: m.devices.map(deviceJson),
      bytes: hex(bytes),
    });
  };
  make("version 1", { seed: phoneSeed, accountId: EMPTY, counter: 1n, previousBody: null, devices: [P] }, list1);
  make("version 2", { seed: phoneSeed, accountId: idA, counter: 2n, previousBody: v1, devices: [P, C1, W1] }, list2);
  make("version 3", { seed: phoneSeed, accountId: idA, counter: 3n, previousBody: v2, devices: [P, C1, C2, Q] }, list3);

  // RFC 8032, section 7.1, test 1: the raw calls held to a published answer.
  {
    const key = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
    const signature = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
    const pair = sodium.crypto_sign_seed_keypair(unhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
    must(hex(pair.publicKey) === key && hex(sodium.crypto_sign_detached(EMPTY, pair.privateKey)) === signature, "RFC 8032 test 1");
    listOut.push({ check: "verify", about: "RFC 8032 test 1: the empty message", needs: [], key, message: "", signature, valid: true });
    const flipped = unhex(signature);
    flipped[63] ^= 0x01;
    must(!sodium.crypto_sign_verify_detached(flipped, EMPTY, unhex(key)), "RFC 8032 test 1, a bit changed");
    listOut.push({ check: "verify", about: "RFC 8032 test 1 with the last bit of S changed", needs: [], key, message: "", signature: hex(flipped), valid: false });
  }
  return listOut;
}

// ------------------------------------------------------------- writing

const files: Record<string, CaseFile<FramedCase> | CaseFile<ListCase>> = {
  "framed.json": {
    about: "framed(context, parts...) and the 8-byte number in a part (docs/e2e.md, section 2). A case with throws is refused: the context, or the number, is the caller's mistake.",
    cases: framedCases(),
  },
  "list.json": {
    about: "A version of the device list, checked (docs/e2e.md, sections 3 and 6); the phone's list maker, to exact bytes; RFC 8032's test 1 for the raw Ed25519 verify. go is the relay's result where Go's crypto/ed25519 differs from libsodium.",
    cases: listCases(),
  },
};

const dir = fileURLToPath(CASES_DIR);
const checkOnly = process.argv.includes("--check");
let stale = 0;
for (const [name, content] of Object.entries(files)) {
  const text = JSON.stringify(content, null, 1) + "\n";
  const path = dir + name;
  let now = "";
  try {
    now = readFileSync(path, "utf8");
  } catch {
    now = "";
  }
  if (now === text) continue;
  if (checkOnly) {
    console.error(`cases/e2e/${name} differs from what e2e/test/gen.ts writes`);
    stale++;
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote cases/e2e/${name}: ${content.cases.length} cases`);
  }
}
if (stale) process.exit(1);
