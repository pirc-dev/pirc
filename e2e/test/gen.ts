// Writes cases/e2e/framed.json, list.json, sealed.json and names.json from
// fixed seeds. With --check it writes nothing, and fails if a file would
// change.
//
//   node --experimental-transform-types --no-warnings e2e/test/gen.ts [--check]
//
// Each case states the result and reason it must have, and the generator
// fails if the package's code gives anything else; what it writes beyond
// that (counters, hashes, the parsed list) is what the code gives. framed's
// expected bytes are also written out by hand below, and RFC 8032's test 1
// holds the raw Ed25519 calls to a published answer.
//
// The list maker, the names maker, the raw signing and the sealing with
// given nonces here are test-only: no device makes lists or names in
// TypeScript, and the package seals only with random nonces.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AnnouncementSchema, DeviceSchema, ListBodySchema, NamesSchema, NoticeSchema } from "@pirc/protocol/v1alpha2";
import sodium from "libsodium-wrappers-sumo";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { utf8Cut } from "../bytes.ts";
import {
  ANNOUNCEMENT_CONTEXT,
  CAPS,
  framed,
  framedNumber,
  FUTURE_MS,
  LIST_CONTEXT,
  load,
  NAME_MAX_BYTES,
  NAMES_CONTEXT,
  NOTICE_CONTEXT,
  type AnnouncementText,
  type DeviceKeys,
  type Kind,
  type ListInput,
  type ListView,
  type NoticeText,
  type SealInput,
  type Sealed,
  type Slot,
} from "../index.ts";
import { openSealed, sealWithNonces } from "../sealed.ts";
import {
  CASES_DIR,
  deviceJson,
  expectOf,
  hex,
  listViewJson,
  namesExpectOf,
  openExpectOf,
  sealedJson,
  slotJson,
  unhex,
  type CaseFile,
  type Expect,
  type FramedCase,
  type ListCase,
  type NamesCase,
  type SealedCase,
  type SealExpect,
} from "./cases.ts";

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
  refuse("a context with a character above 0x7F", "caf\u00e9");

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
    check("previous_hash of 33 bytes", later(v(idA, concat(sha256(v1), Uint8Array.of(0)))), refused("mode"));
    check("previous_hash empty in version 2", later(v(idA, EMPTY)), refused("mode"));
    check("account_id empty in version 2", later(v(EMPTY, sha256(v1))), refused("mode"));
    check("account_id of 31 bytes, its first 31", later(v(idA.slice(0, 31), sha256(v1))), refused("mode"));
    check("account_id of 33 bytes, its first 32 the account's", later(v(concat(idA, Uint8Array.of(0)), sha256(v1))), refused("mode"));
  }

  // Old.
  check("counter equal to the highest held", later(list2, 2n), old);
  check("counter below the highest held", later(list2, 3n), old);
  check("counter equal, another body (another hash)", later(laterA([P, C1, C2]).bytes, 2n), old);
  check("version 1 with 1 held", { bytes: list1, mode: "first", highest: 1n }, old);
  check("old, with a key twice too: still old", later(laterA([P, C1, C1]).bytes, 2n), old);
  check("old, with role 3 too: still old", later(laterA([P, { ...C1, role: 3 }]).bytes, 2n), old);
  check("old, with a key of 31 bytes too: still old", later(laterA([P, { ...C1, boxKey: C1.boxKey.slice(0, 31) }]).bytes, 2n), old);
  check("old, with a client with one phone key too: still old", later(laterA([P, { ...Q, notificationKey: EMPTY }]).bytes, 2n), old);

  // Unsupported.
  {
    const fields = bodyFields({ accountId: idA, counter: 2n, previousHash: sha256(v1), devices: [P, C1] });
    fields.splice(2, 0, { no: 9, varint: 7n });
    check("an unknown field in the body", later(signList(encode(fields), idA, pSecret)), unsupported("unknown-field"));
    check("old, with an unknown field in the body too: still old", later(signList(encode(fields), idA, pSecret), 2n), old);
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

// ------------------------------------------------ sealed.json, names.json

const boxSecret = (name: string): Uint8Array => sodium.crypto_box_seed_keypair(seed(`${name} box`)).privateKey;
const notificationSecret = (name: string): Uint8Array => sodium.crypto_box_seed_keypair(seed(`${name} notification`)).privateKey;
const nonce = (name: string): Uint8Array => sha256(utf8(`pirc e2e test nonce: ${name}`)).slice(0, 24);
const NOW = 1_800_000_000_000n;
const ORDERING = NOW - 60_000n;
const SESSION = utf8("0193f1c2-7a4b-7c3d-9e8f-0a1b2c3d4e5f");
const ZERO_KEY = new Uint8Array(32);

const C3 = computer("computer 3");
const W2 = browser("browser 2");
// The newest list of account A that sealing and opening read.
const LV: ListView = { counter: 4n, devices: [P, C1, C2, W1, Q] };

const slotA = (kind: Kind, over: Partial<Slot> = {}): Slot => ({ accountId: idA, computerKey: C1.signingKey, sessionId: SESSION, kind, ...over });
const ANNOUNCEMENT: AnnouncementText = { sessionName: "fix the flaky test", folder: "/home/user/src/project", model: "a model", computerName: "build box", notice: "Which branch should I use?" };
const NOTICE: NoticeText = { sessionName: "fix the flaky test", computerName: "build box", notice: "Which branch should I use?" };

function bodyBytes(kind: Kind, text: Record<string, string | Uint8Array>): Uint8Array {
  const f: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(text)) f[k] = typeof v === "string" ? utf8(v) : v;
  return kind === "announcement" ? toBinary(AnnouncementSchema, create(AnnouncementSchema, f)) : toBinary(NoticeSchema, create(NoticeSchema, f));
}

/** The plaintext as a computer writes it, with an ordering of any 64-bit value. */
function plaintextOf(kind: Kind, slot: Omit<Slot, "kind">, ordering: bigint, b: Uint8Array): Uint8Array {
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, ordering);
  return concat(framed(kind === "announcement" ? ANNOUNCEMENT_CONTEXT : NOTICE_CONTEXT, slot.accountId, slot.computerKey, slot.sessionId), Uint8Array.of(8), n, b);
}

const box = (plaintext: Uint8Array, to: Uint8Array, fromSecret: Uint8Array, n = nonce("a copy")): Uint8Array => concat(n, sodium.crypto_box_easy(plaintext, n, to, fromSecret));

type OpenWant = { result: "accepted"; ordering: bigint; body: Record<string, string> } | { result: "refused"; reason: string };
const sealedOut: SealedCase[] = [];

/** The recipient each kind's cases open as: the browser's box key, or the phone's notification key. */
const RECIPIENT = {
  announcement: { key: W1.boxKey, secret: boxSecret("browser 1") },
  notice: { key: P.notificationKey, secret: notificationSecret("phone") },
} as const;
const TEXT: Record<Kind, Record<string, string>> = { announcement: { ...ANNOUNCEMENT }, notice: { ...NOTICE } };

function open(
  about: string,
  kind: Kind,
  input: { sealed: Uint8Array; slot?: Omit<Slot, "kind">; recipientSecretKey?: Uint8Array; list?: ListView; highest?: bigint | null; now?: bigint },
  want: OpenWant,
): void {
  const full = { slot: slotA(kind), recipientSecretKey: RECIPIENT[kind].secret, list: LV, highest: null, now: NOW, ...input };
  const got = openSealed(sodium, kind, full);
  const reason = got.result === "refused" ? got.reason : undefined;
  must(got.result === want.result && reason === ("reason" in want ? want.reason : undefined), `${about}: wanted ${want.result} ${"reason" in want ? want.reason : ""}, got ${got.result} ${reason ?? ""}`);
  if (got.result === "accepted" && want.result === "accepted") {
    must(got.ordering === want.ordering && isDeepStrictEqual({ ...got.body }, want.body), `${about}: the ordering and body opened`);
  }
  sealedOut.push({
    check: "open",
    about,
    needs: [kind],
    sealed: hex(full.sealed),
    slot: slotJson({ ...full.slot, kind }),
    recipientSecretKey: hex(full.recipientSecretKey),
    list: listViewJson(full.list),
    ...(full.highest !== null ? { highest: full.highest.toString() } : {}),
    now: full.now.toString(),
    expect: openExpectOf(got),
  });
}

/** A device's secret key for the kind's copies: its box key's, or its notification key's. */
function secretOf(kind: Kind, signingKey: Uint8Array): Uint8Array {
  const name = DEVICE_NAMES.get(hex(signingKey))!;
  return kind === "announcement" ? boxSecret(name) : notificationSecret(name);
}

function sealCase(
  about: string,
  input: SealInput,
  nonces: Uint8Array[],
  want: "throws" | { to: Uint8Array[]; skipped: Uint8Array[]; opened?: Record<string, string> },
): void {
  let expect: SealExpect;
  let secrets: Uint8Array[] = [];
  if (want === "throws") {
    let threw = false;
    try {
      sealWithNonces(sodium, input, (i) => nonces[i]);
    } catch {
      threw = true;
    }
    must(threw, `${about}: throws`);
    expect = { throws: true };
  } else {
    const got = sealWithNonces(sodium, input, (i) => nonces[i]);
    must(
      got.copies.length === want.to.length && got.copies.every((c, i) => equal(c.signingKey, want.to[i])) && got.skipped.length === want.skipped.length && got.skipped.every((k, i) => equal(k, want.skipped[i])),
      `${about}: the copies' recipients and the keys skipped`,
    );
    // Each copy carries one of the nonces given, none the same as the copy before.
    got.copies.forEach((c, i) => must(nonces.some((n) => equal(c.sealed.subarray(0, 24), n)) && (i === 0 || !equal(c.sealed.subarray(0, 24), got.copies[i - 1].sealed.subarray(0, 24))), `${about}: copy ${i}'s nonce`));
    // Each copy opens, for its recipient, to the body as given here.
    secrets = got.copies.map((c) => secretOf(input.slot.kind, c.signingKey));
    got.copies.forEach((c, i) => {
      const r = openSealed(sodium, input.slot.kind, { sealed: c.sealed, slot: input.slot, recipientSecretKey: secrets[i], list: input.list, highest: null, now: input.ordering });
      must(r.result === "accepted" && r.ordering === input.ordering && isDeepStrictEqual({ ...r.body }, want.opened), `${about}: copy ${i} opens to the body given`);
    });
    must((want.opened !== undefined) === got.copies.length > 0, `${about}: an opened text exactly when there are copies`);
    expect = { ...sealedJson(got), ...(want.opened ? { opened: want.opened } : {}) };
  }
  sealedOut.push({
    check: "seal",
    about,
    needs: ["seal"],
    list: listViewJson(input.list),
    boxSecretKey: hex(input.boxSecretKey),
    slot: slotJson(input.slot),
    ordering: input.ordering.toString(),
    body: { ...(input.body as unknown as Record<string, string>) },
    nonces: nonces.map(hex),
    recipientSecretKeys: secrets.map(hex),
    expect,
  });
}

const DEVICE_NAMES = new Map<string, string>(
  [
    ["phone", P],
    ["computer 1", C1],
    ["computer 2", C2],
    ["browser 1", W1],
    ["phone 2", Q],
    ["computer 3", C3],
    ["browser 2", W2],
  ].map(([n, d]) => [hex((d as Dev).signingKey), n as string]),
);

/** Malformed UTF-8, each in a form decoders are known to differ on. */
const MALFORMED: [string, Uint8Array][] = [
  ["a truncated two-byte sequence", Uint8Array.of(0x61, 0xc3)],
  ["an overlong '/' (c0 af)", Uint8Array.of(0xc0, 0xaf)],
  ["an overlong NUL (c0 80)", Uint8Array.of(0xc0, 0x80)],
  ["an encoded surrogate (ed a0 80)", Uint8Array.of(0xed, 0xa0, 0x80)],
  ["a code point above U+10FFFF (f4 90 80 80)", Uint8Array.of(0xf4, 0x90, 0x80, 0x80)],
  ["a lone continuation byte (80)", Uint8Array.of(0x80)],
];

/** A box anyone can make for an all-zero public key: the X25519 shared point is all zeros whatever the other secret. */
function zeroPointBox(plaintext: Uint8Array, n: Uint8Array): Uint8Array {
  const k = sodium.crypto_core_hsalsa20(new Uint8Array(16), new Uint8Array(32), null);
  const sealed = concat(n, sodium.crypto_secretbox_easy(plaintext, n, k));
  must(equal(sodium.crypto_box_open_easy_afternm(sealed.subarray(24), n, k), plaintext), "the zero-point box opens under the zero point's key");
  return sealed;
}

function sealedCases(): SealedCase[] {
  const c1 = boxSecret("computer 1");
  const refused = (reason: string) => ({ result: "refused" as const, reason });
  const text = (kind: Kind, over: Record<string, string> = {}) => ({ ...TEXT[kind], ...over });
  const bodyOf = (kind: Kind, over: Record<string, string | Uint8Array> = {}) => bodyBytes(kind, { ...TEXT[kind], ...over });
  const to = (kind: Kind, pt: Uint8Array, from = c1) => box(pt, RECIPIENT[kind].key, from);
  const plain = (kind: Kind, over: { slot?: Omit<Slot, "kind">; ordering?: bigint; body?: Uint8Array; context?: Kind } = {}) =>
    plaintextOf(over.context ?? kind, over.slot ?? slotA(kind), over.ordering ?? ORDERING, over.body ?? bodyOf(kind));
  const good = (kind: Kind, ordering = ORDERING, slot: Omit<Slot, "kind"> = slotA(kind)) => to(kind, plain(kind, { ordering, slot }));
  const ok = (kind: Kind, over: Record<string, string> = {}, ordering = ORDERING) => ({ result: "accepted" as const, ordering, body: text(kind, over) });

  for (const kind of ["announcement", "notice"] as const) {
    const a = kind === "announcement" ? "an announcement" : "a notice";
    const other: Kind = kind === "announcement" ? "notice" : "announcement";
    const caps = CAPS[kind] as Record<string, number>;
    const first = Object.keys(caps)[0];

    // Accepted.
    open(`${a}`, kind, { sealed: good(kind) }, ok(kind));
    open(`${a}: ordering far in the past, none seen`, kind, { sealed: good(kind, 1n) }, ok(kind, {}, 1n));
    open(`${a}: ordering above the highest seen`, kind, { sealed: good(kind), highest: ORDERING - 1n }, ok(kind));
    open(`${a}: ordering exactly a day ahead`, kind, { sealed: good(kind, NOW + FUTURE_MS) }, ok(kind, {}, NOW + FUTURE_MS));
    open(`${a}: an unknown field`, kind, { sealed: to(kind, plain(kind, { body: concat(bodyOf(kind), Uint8Array.of(0x48, 0x01)) })) }, ok(kind));
    const atCaps = Object.fromEntries(Object.entries(caps).map(([k, cap]) => [k, k[0].repeat(cap)]));
    open(`${a}: every field exactly at its cap`, kind, { sealed: to(kind, plain(kind, { body: bodyOf(kind, atCaps) })) }, ok(kind, atCaps));
    const empty = Object.fromEntries(Object.keys(caps).map((k) => [k, ""]));
    open(`${a}: every field empty`, kind, { sealed: to(kind, plain(kind, { body: bodyOf(kind, empty) })) }, ok(kind, empty));
    open(`${a}: the ${first} 100 two-byte characters, 200 bytes: at its cap`, kind, { sealed: to(kind, plain(kind, { body: bodyOf(kind, { [first]: "\u00e9".repeat(100) }) })) }, ok(kind, { [first]: "\u00e9".repeat(100) }));
    open(`${a}: the ${first} beginning with U+FEFF: kept, as text`, kind, { sealed: to(kind, plain(kind, { body: bodyOf(kind, { [first]: "\ufeffname" }) })) }, ok(kind, { [first]: "\ufeffname" }));
    for (const [about, id] of [
      ["a session ID of 1 byte", utf8("a")],
      ["a session ID of 128 bytes", utf8("a".repeat(128))],
      ["a session ID with a multi-byte character", utf8("sess-\u00e9")],
    ] as const) {
      const slot = slotA(kind, { sessionId: id });
      open(`${a}: ${about}`, kind, { sealed: good(kind, ORDERING, slot), slot }, ok(kind));
    }
    {
      const base = plain(kind);
      const pad = (n: number) => to(kind, concat(base, Uint8Array.of(0x7a), Uint8Array.from(varint(BigInt(n))), new Uint8Array(n)));
      let n = 65_536 - 64 - base.length - 3;
      while (pad(n).length < 65_536) n++;
      must(pad(n).length === 65_536, "a copy of exactly 65,536 bytes");
      open(`${a}: exactly 65,536 bytes, padded by an unknown field`, kind, { sealed: pad(n) }, ok(kind));
      open(`${a}: 65,537 bytes`, kind, { sealed: pad(n + 1) }, refused("size"));
    }

    // Slot.
    for (const [about, id] of [
      ["an empty session ID", EMPTY],
      ["a session ID of 129 bytes", utf8("a".repeat(129))],
      ...MALFORMED.map(([m, b]) => [`a session ID holding ${m}`, concat(utf8("sess-"), b)] as const),
    ] as const) {
      const slot = slotA(kind, { sessionId: id });
      open(`${a}: ${about}`, kind, { sealed: good(kind, ORDERING, slot), slot }, refused("slot"));
    }
    open(`${a}: an empty session ID and 10 bytes: the slot, before the size`, kind, { sealed: new Uint8Array(10), slot: slotA(kind, { sessionId: EMPTY }) }, refused("slot"));

    // Size.
    open(`${a}: 39 bytes, shorter than the nonce and the MAC`, kind, { sealed: good(kind).slice(0, 39) }, refused("size"));
    open(`${a}: 40 bytes: through the size check`, kind, { sealed: good(kind).slice(0, 40) }, refused("box"));
    open(`${a}: 39 bytes from a computer not listed: the size, before the computer`, kind, { sealed: new Uint8Array(39), slot: slotA(kind, { computerKey: C3.signingKey }) }, refused("size"));

    // Computer not listed.
    {
      const s3 = slotA(kind, { computerKey: C3.signingKey });
      open(`${a}: from a computer not on the list`, kind, { sealed: to(kind, plain(kind, { slot: s3 }), boxSecret("computer 3")), slot: s3 }, refused("computer-not-listed"));
      const sq = slotA(kind, { computerKey: Q.signingKey });
      open(`${a}: from a device listed as a client`, kind, { sealed: to(kind, plain(kind, { slot: sq }), boxSecret("phone 2")), slot: sq }, refused("computer-not-listed"));
      open(`${a}: 100 bytes of zeros from a computer not listed: the computer, before the box`, kind, { sealed: new Uint8Array(100), slot: s3 }, refused("computer-not-listed"));
    }

    // Box.
    open(`${a}: opened by another device`, kind, { sealed: good(kind), recipientSecretKey: kind === "announcement" ? boxSecret("phone 2") : notificationSecret("phone 2") }, refused("box"));
    {
      const flipped = good(kind);
      flipped[40] ^= 0x01;
      open(`${a}: a ciphertext bit changed`, kind, { sealed: flipped }, refused("box"));
    }
    open(`${a}: a listed computer with an all-zero box key, the box made under the all-zero shared point`, kind, { sealed: zeroPointBox(plain(kind), nonce("zero point")), list: { counter: 4n, devices: [P, { ...C1, boxKey: ZERO_KEY }, C2, W1, Q] } }, refused("box"));
    open(`${a}: sealed by computer 2 with computer 1's header`, kind, { sealed: to(kind, plain(kind), boxSecret("computer 2")) }, refused("box"));
    if (kind === "announcement") {
      open(`${a} sealed to the phone's notification key`, kind, { sealed: box(plain(kind), P.notificationKey, c1), recipientSecretKey: boxSecret("phone") }, refused("box"));
    } else {
      open(`${a} sealed to the phone's box key`, kind, { sealed: box(plain(kind), P.boxKey, c1) }, refused("box"));
    }

    // Prefix.
    open(`${a}: sealed by computer 1 with computer 2's header`, kind, { sealed: to(kind, plain(kind, { slot: slotA(kind, { computerKey: C2.signingKey }) })) }, refused("prefix"));
    open(`${a}: another account's ID in the header`, kind, { sealed: to(kind, plain(kind, { slot: slotA(kind, { accountId: idB }) })) }, refused("prefix"));
    open(`${a}: another session in the header`, kind, { sealed: to(kind, plain(kind, { slot: slotA(kind, { sessionId: utf8("0193f1c2-7a4b-7c3d-9e8f-0a1b2c3d4e60") }) })) }, refused("prefix"));
    open(`${a}: the session ID in upper case in the header`, kind, { sealed: to(kind, plain(kind, { slot: slotA(kind, { sessionId: utf8(new TextDecoder().decode(SESSION).toUpperCase()) }) })) }, refused("prefix"));
    open(`${a}: the ${other}'s context`, kind, { sealed: to(kind, plain(kind, { context: other })) }, refused("prefix"));
    {
      const start = plain(kind, { body: EMPTY });
      open(`${a}: a plaintext of the prefix and 7 bytes`, kind, { sealed: to(kind, start.slice(0, start.length - 1)) }, refused("prefix"));
      open(`${a}: a plaintext of the prefix and 8 bytes, an empty body`, kind, { sealed: to(kind, start) }, ok(kind, empty));
    }
    open(`${a}: an empty plaintext`, kind, { sealed: to(kind, EMPTY) }, refused("prefix"));
    open(`${a}: another account's header and ordering 2^63: the prefix, before the range`, kind, { sealed: to(kind, plain(kind, { slot: slotA(kind, { accountId: idB }), ordering: 2n ** 63n })) }, refused("prefix"));

    // Ordering.
    open(`${a}: ordering 2^63`, kind, { sealed: good(kind, 2n ** 63n) }, refused("range"));
    open(`${a}: ordering equal to the highest seen`, kind, { sealed: good(kind), highest: ORDERING }, refused("ordering"));
    open(`${a}: ordering below the highest seen`, kind, { sealed: good(kind), highest: ORDERING + 1n }, refused("ordering"));
    open(`${a}: ordering a day and a millisecond ahead`, kind, { sealed: good(kind, NOW + FUTURE_MS + 1n) }, refused("future"));
    open(`${a}: ordering two days ahead, but below the highest seen: the ordering, before the future`, kind, { sealed: good(kind, NOW + 2n * FUTURE_MS), highest: NOW + 3n * FUTURE_MS }, refused("ordering"));
    open(`${a}: ordering a day and a millisecond ahead, a body that does not parse: the future, before the parse`, kind, { sealed: to(kind, plain(kind, { ordering: NOW + FUTURE_MS + 1n, body: Uint8Array.of(0xff) })) }, refused("future"));

    // Body.
    open(`${a}: a body that does not parse`, kind, { sealed: to(kind, plain(kind, { body: Uint8Array.of(0xff) })) }, refused("parse"));
    for (const [k, cap] of Object.entries(caps)) {
      open(`${a}: the ${k} one byte over its cap`, kind, { sealed: to(kind, plain(kind, { body: bodyOf(kind, { [k]: "x".repeat(cap + 1) }) })) }, refused("text"));
      open(`${a}: the ${k} not UTF-8`, kind, { sealed: to(kind, plain(kind, { body: bodyOf(kind, { [k]: Uint8Array.of(0x61, 0xc3) }) })) }, refused("text"));
    }
    open(`${a}: the ${first} 101 two-byte characters, 202 bytes: over its cap of 200`, kind, { sealed: to(kind, plain(kind, { body: bodyOf(kind, { [first]: "\u00e9".repeat(101) }) })) }, refused("text"));
    for (const [m, b] of MALFORMED.slice(1)) {
      open(`${a}: the ${first} holding ${m}`, kind, { sealed: to(kind, plain(kind, { body: bodyOf(kind, { [first]: concat(utf8("x"), b) }) })) }, refused("text"));
    }
  }

  // Sealing, to exact bytes with the nonces given.
  const nonces = (n: number) => Array.from({ length: n }, (_, i) => nonce(`seal ${i}`));
  const sealIn = (over: Partial<SealInput> = {}): SealInput => ({ list: LV, boxSecretKey: c1, slot: slotA("announcement"), ordering: ORDERING, body: ANNOUNCEMENT, ...over });
  const notice = (over: Partial<SealInput> = {}) => sealIn({ slot: slotA("notice"), body: NOTICE, ...over });
  const clients = [P.signingKey, W1.signingKey, Q.signingKey];
  const phones = [P.signingKey, Q.signingKey];
  const LV5: ListView = { counter: 5n, devices: [P, C1, C2, W1, Q, W2] };
  sealCase("an announcement, on a newer list with browser 2: a copy for each client, browser 2 among them", sealIn({ list: LV5 }), nonces(4), { to: [...clients, W2.signingKey], skipped: [], opened: text("announcement") });
  sealCase("an announcement, on the list before browser 2 was added: a copy for each client on it, none for browser 2", sealIn(), nonces(3), { to: clients, skipped: [], opened: text("announcement") });
  sealCase("a notice: a copy for each phone, to its notification key, none for the browser", notice(), nonces(2), { to: phones, skipped: [], opened: text("notice") });
  sealCase("from a computer not on the list: nothing, with a box secret key not its own", sealIn({ slot: slotA("announcement", { computerKey: C3.signingKey }) }), nonces(3), { to: [], skipped: [] });
  sealCase("from a device listed as a client: nothing", sealIn({ slot: slotA("announcement", { computerKey: Q.signingKey }), boxSecretKey: boxSecret("phone 2") }), nonces(3), { to: [], skipped: [] });
  sealCase("a listed client with an all-zero box key: skipped, the others sealed", sealIn({ list: { counter: 4n, devices: [P, C1, C2, { ...W1, boxKey: ZERO_KEY }, Q] } }), nonces(3), { to: phones, skipped: [ZERO_KEY], opened: text("announcement") });
  sealCase("a phone with an all-zero notification key: skipped, the other sealed", notice({ list: { counter: 4n, devices: [P, C1, C2, W1, { ...Q, notificationKey: ZERO_KEY }] } }), nonces(2), { to: [P.signingKey], skipped: [ZERO_KEY], opened: text("notice") });
  sealCase("a session name whose cap falls inside a two-byte character: cut before it, to 199 bytes", sealIn({ body: { ...ANNOUNCEMENT, sessionName: "a".repeat(199) + "\u00e9" } }), nonces(3), { to: clients, skipped: [], opened: text("announcement", { sessionName: "a".repeat(199) }) });
  sealCase("a session name of 150 two-byte characters: cut to 100, 200 bytes", sealIn({ body: { ...ANNOUNCEMENT, sessionName: "\u00e9".repeat(150) } }), nonces(3), { to: clients, skipped: [], opened: text("announcement", { sessionName: "\u00e9".repeat(100) }) });
  sealCase("a notice whose cap falls inside a four-byte character: cut before it, to 4,094 bytes", notice({ body: { ...NOTICE, notice: "a".repeat(4094) + "\u{1f600}" } }), nonces(2), { to: phones, skipped: [], opened: text("notice", { notice: "a".repeat(4094) }) });
  sealCase("a box secret key that is not the computer's: the caller's mistake", sealIn({ boxSecretKey: boxSecret("computer 2") }), nonces(3), "throws");
  sealCase("an empty session ID: the caller's mistake", sealIn({ slot: slotA("announcement", { sessionId: EMPTY }) }), nonces(3), "throws");
  sealCase("a session ID of 129 bytes: the caller's mistake", sealIn({ slot: slotA("announcement", { sessionId: utf8("a".repeat(129)) }) }), nonces(3), "throws");
  sealCase("a session ID that is not UTF-8: the caller's mistake", sealIn({ slot: slotA("announcement", { sessionId: Uint8Array.of(0x61, 0xff) }) }), nonces(3), "throws");
  sealCase("an empty session ID from a computer not on the list: the caller's mistake, first", sealIn({ slot: slotA("announcement", { sessionId: EMPTY, computerKey: C3.signingKey }) }), nonces(3), "throws");
  sealCase("a session name with a lone surrogate: replaced by U+FFFD", sealIn({ body: { ...ANNOUNCEMENT, sessionName: "a\ud800b" } }), nonces(3), { to: clients, skipped: [], opened: text("announcement", { sessionName: "a\ufffdb" }) });
  return sealedOut;
}

// Names.

const namesOut: NamesCase[] = [];
const phoneBox = boxSecret("phone");

function namesBody(n: { listCounter?: bigint; ordering?: bigint; names?: { signingKey: Uint8Array; name: Uint8Array }[] }): Uint8Array {
  return toBinary(NamesSchema, create(NamesSchema, { listCounter: n.listCounter ?? LV.counter, ordering: n.ordering ?? ORDERING, names: n.names ?? goodNames() }));
}
const nameOf = (d: Dev, name: string) => ({ signingKey: d.signingKey, name: utf8(name) });
const goodNames = () => [nameOf(P, "Pixel"), nameOf(C1, "build box"), nameOf(C2, "laptop"), nameOf(W1, "work browser"), nameOf(Q, "tablet")];
const signNames = (b: Uint8Array, accountId = idA, secret = pSecret, context = NAMES_CONTEXT) => concat(sodium.crypto_sign_detached(framed(context, accountId, b), secret), b);
const sealNames = (plaintext: Uint8Array, fromSecret = phoneBox, to = W1.boxKey) => box(plaintext, to, fromSecret, nonce("names"));

/** The test-only names maker: what the account's phone does (in Dart). */
function makeNames(m: { accountId: Uint8Array; list: ListView; phoneSeed: Uint8Array; phoneBoxSecretKey: Uint8Array; ordering: bigint; names: { signingKey: Uint8Array; name: string }[] }, nonces: Uint8Array[]) {
  const b = toBinary(NamesSchema, create(NamesSchema, { listCounter: m.list.counter, ordering: m.ordering, names: m.names.map((n) => ({ signingKey: n.signingKey, name: utf8Cut(n.name, NAME_MAX_BYTES) })) }));
  const plaintext = concat(sodium.crypto_sign_detached(framed(NAMES_CONTEXT, m.accountId, b), sodium.crypto_sign_seed_keypair(m.phoneSeed).privateKey), b);
  const out: Sealed = { copies: [], skipped: [] };
  m.list.devices
    .filter((d) => d.role === CLIENT)
    .forEach((d, i) => {
      try {
        out.copies.push({ signingKey: d.signingKey, recipientKey: d.boxKey, sealed: box(plaintext, d.boxKey, m.phoneBoxSecretKey, nonces[i]) });
      } catch {
        out.skipped.push(d.boxKey);
      }
    });
  return out;
}

type NamedList = [Dev, string][];
type NamesWant = { result: "accepted"; ordering: bigint; listCounter: bigint; names: NamedList; dropped: NamedList } | { result: "later" } | { result: "refused"; reason: string };
const namedJson = (ns: NamedList) => ns.map(([d, name]) => ({ signingKey: hex(d.signingKey), name }));

function names(about: string, input: { sealed: Uint8Array; accountId?: Uint8Array; list?: ListView; phoneKey?: Uint8Array; recipientSecretKey?: Uint8Array; highest?: bigint | null; now?: bigint }, want: NamesWant): void {
  const full = { accountId: idA, list: LV, phoneKey: P.signingKey, recipientSecretKey: boxSecret("browser 1"), highest: null, now: NOW, ...input };
  const got = e2e.openNames(full);
  const reason = got.result === "refused" ? got.reason : undefined;
  must(got.result === want.result && reason === ("reason" in want ? want.reason : undefined), `${about}: wanted ${want.result} ${"reason" in want ? want.reason : ""}, got ${got.result} ${reason ?? ""}`);
  if (got.result === "accepted" && want.result === "accepted") {
    const e = namesExpectOf(got) as { names: unknown; dropped: unknown };
    must(got.ordering === want.ordering && got.listCounter === want.listCounter && isDeepStrictEqual(e.names, namedJson(want.names)) && isDeepStrictEqual(e.dropped, namedJson(want.dropped)), `${about}: the names opened`);
  }
  namesOut.push({
    check: "open-names",
    about,
    needs: ["names"],
    sealed: hex(full.sealed),
    accountId: hex(full.accountId),
    list: listViewJson(full.list),
    phoneKey: hex(full.phoneKey),
    recipientSecretKey: hex(full.recipientSecretKey),
    ...(full.highest !== null ? { highest: full.highest.toString() } : {}),
    now: full.now.toString(),
    expect: namesExpectOf(got),
  });
}

function namesCases(): NamesCase[] {
  const refused = (reason: string) => ({ result: "refused" as const, reason });
  const sealed = (n: Parameters<typeof namesBody>[0] = {}) => sealNames(signNames(namesBody(n)));
  const GOOD: NamedList = [
    [P, "Pixel"],
    [C1, "build box"],
    [C2, "laptop"],
    [W1, "work browser"],
    [Q, "tablet"],
  ];
  const ok = (over: { names?: NamedList; dropped?: NamedList; ordering?: bigint; listCounter?: bigint } = {}) =>
    ({ result: "accepted", ordering: over.ordering ?? ORDERING, listCounter: over.listCounter ?? 4n, names: over.names ?? GOOD, dropped: over.dropped ?? [] }) as const;
  const accepted = ok();

  // Accepted.
  names("good names", { sealed: sealed() }, accepted);
  names("list_counter equal to the list's", { sealed: sealed({ listCounter: 4n }) }, accepted);
  names("list_counter below the list's", { sealed: sealed({ listCounter: 3n }) }, ok({ listCounter: 3n }));
  names("an unknown field", { sealed: sealNames(signNames(concat(namesBody({}), Uint8Array.of(0x48, 0x01)))) }, accepted);
  names("ordering above the highest seen", { sealed: sealed(), highest: ORDERING - 1n }, accepted);
  names("ordering exactly a day ahead", { sealed: sealed({ ordering: NOW + FUTURE_MS }) }, ok({ ordering: NOW + FUTURE_MS }));
  names("a name for a device not on the list: dropped, returned apart", { sealed: sealed({ names: [nameOf(W1, "work browser"), nameOf(W2, "old browser"), nameOf(Q, "tablet")] }) }, ok({ names: [[W1, "work browser"], [Q, "tablet"]], dropped: [[W2, "old browser"]] }));
  names("a name of 200 bytes", { sealed: sealed({ names: [nameOf(P, "p".repeat(200))] }) }, ok({ names: [[P, "p".repeat(200)]] }));
  names("a name of 100 two-byte characters, 200 bytes", { sealed: sealed({ names: [nameOf(P, "\u00e9".repeat(100))] }) }, ok({ names: [[P, "\u00e9".repeat(100)]] }));
  names("a name beginning with U+FEFF: kept, as text", { sealed: sealed({ names: [nameOf(P, "\ufeffPixel")] }) }, ok({ names: [[P, "\ufeffPixel"]] }));
  {
    const base = signNames(namesBody({}));
    const pad = (n: number) => sealNames(signNames(concat(namesBody({}), Uint8Array.of(0x7a), Uint8Array.from(varint(BigInt(n))), new Uint8Array(n))));
    let n = 32_768 - base.length - 64 - 3;
    while (pad(n).length < 32_768) n++;
    must(pad(n).length === 32_768, "names of exactly 32,768 bytes");
    names("exactly 32,768 bytes, padded by an unknown field", { sealed: pad(n) }, accepted);
    names("32,769 bytes", { sealed: pad(n + 1) }, refused("size"));
  }

  // Later.
  names("list_counter above the list's", { sealed: sealed({ listCounter: 5n }) }, { result: "later" });
  names("list_counter ahead with a name over its cap: later, before the text", { sealed: sealed({ listCounter: 5n, names: [nameOf(P, "p".repeat(201))] }) }, { result: "later" });
  names("list_counter ahead with a key twice: later, before the duplicate", { sealed: sealed({ listCounter: 5n, names: [nameOf(P, "a"), nameOf(P, "b")] }) }, { result: "later" });

  // Box and signature.
  names("boxed from another key", { sealed: sealNames(signNames(namesBody({})), boxSecret("phone 2")) }, refused("box"));
  names("the phone not on the list", { sealed: sealed(), list: { counter: 4n, devices: [C1, C2, W1, Q] } }, refused("box"));
  names("39 bytes", { sealed: sealed().slice(0, 39) }, refused("box"));
  names("an opened plaintext of 63 bytes", { sealed: sealNames(new Uint8Array(63)) }, refused("signature"));
  names("an opened plaintext of 64 bytes: a signature over an empty body, bad", { sealed: sealNames(new Uint8Array(64)) }, refused("signature"));
  {
    const bad = signNames(namesBody({}));
    bad[5] ^= 0x01;
    names("a bad signature", { sealed: sealNames(bad) }, refused("signature"));
  }
  names("signed over another account's ID", { sealed: sealNames(signNames(namesBody({}), idB)) }, refused("signature"));
  names("signed by another key", { sealed: sealNames(signNames(namesBody({}), idA, signingSecret("phone 2"))) }, refused("signature"));
  names("a list's signature and body offered as names", { sealed: sealNames(list2) }, refused("signature"));
  {
    const cut = signNames(namesBody({}).slice(0, -3));
    names("a signed body cut short", { sealed: sealNames(cut) }, refused("parse"));
    cut[5] ^= 0x01;
    names("a body cut short under a bad signature: the signature, before the parse", { sealed: sealNames(cut) }, refused("signature"));
  }

  // Ordering.
  names("ordering 2^63", { sealed: sealed({ ordering: 2n ** 63n }) }, refused("range"));
  names("ordering equal to the highest seen", { sealed: sealed(), highest: ORDERING }, refused("ordering"));
  names("ordering below the highest seen", { sealed: sealed(), highest: ORDERING + 1n }, refused("ordering"));
  names("ordering a day and a millisecond ahead", { sealed: sealed({ ordering: NOW + FUTURE_MS + 1n }) }, refused("future"));
  names("ordering two days ahead, below the highest seen: the ordering, before the future", { sealed: sealed({ ordering: NOW + 2n * FUTURE_MS }), highest: NOW + 3n * FUTURE_MS }, refused("ordering"));
  names("ordering a day and a millisecond ahead, list_counter ahead: the future, before later", { sealed: sealed({ ordering: NOW + FUTURE_MS + 1n, listCounter: 5n }) }, refused("future"));

  // Names.
  names("a name of 201 bytes", { sealed: sealed({ names: [nameOf(P, "p".repeat(201))] }) }, refused("text"));
  names("a name of 101 two-byte characters, 202 bytes", { sealed: sealed({ names: [nameOf(P, "\u00e9".repeat(101))] }) }, refused("text"));
  for (const [m, b] of MALFORMED) {
    names(`a name holding ${m}`, { sealed: sealed({ names: [{ signingKey: P.signingKey, name: concat(utf8("x"), b) }] }) }, refused("text"));
  }
  names("a signing key twice", { sealed: sealed({ names: [nameOf(P, "a"), nameOf(C1, "b"), nameOf(P, "c")] }) }, refused("duplicate-key"));
  names("a key twice, then a name that is not UTF-8: the text, before the duplicate", { sealed: sealed({ names: [nameOf(P, "a"), nameOf(P, "b"), { signingKey: C1.signingKey, name: Uint8Array.of(0xc3) }] }) }, refused("text"));
  names("a key twice, of a device not on the list", { sealed: sealed({ names: [nameOf(W2, "a"), nameOf(W2, "b")] }) }, refused("duplicate-key"));

  // The maker, to exact bytes with the nonces given.
  const make = (about: string, m: Parameters<typeof makeNames>[0], nonces: Uint8Array[], copies: number, skipped: number, opened: NamedList) => {
    const out = makeNames(m, nonces);
    must(out.copies.length === copies && out.skipped.length === skipped, `make: ${about}`);
    // Each copy opens, for its recipient, to the names given here.
    for (const c of out.copies) {
      const r = e2e.openNames({ sealed: c.sealed, accountId: m.accountId, list: m.list, phoneKey: P.signingKey, recipientSecretKey: boxSecret(DEVICE_NAMES.get(hex(c.signingKey))!), highest: null, now: m.ordering });
      must(r.result === "accepted" && isDeepStrictEqual((namesExpectOf(r) as { names: unknown }).names, namedJson(opened)), `make: ${about}: a copy opens to the names given`);
    }
    namesOut.push({
      check: "make-names",
      about,
      needs: ["make-names"],
      accountId: hex(m.accountId),
      list: listViewJson(m.list),
      phoneSeed: hex(m.phoneSeed),
      phoneBoxSecretKey: hex(m.phoneBoxSecretKey),
      ordering: m.ordering.toString(),
      names: m.names.map((n) => ({ signingKey: hex(n.signingKey), name: n.name })),
      nonces: nonces.map(hex),
      expect: sealedJson(out),
    });
  };
  const nonces = (n: number) => Array.from({ length: n }, (_, i) => nonce(`names ${i}`));
  const textNames = [
    { signingKey: P.signingKey, name: "Pixel" },
    { signingKey: C1.signingKey, name: "build box" },
    { signingKey: C2.signingKey, name: "laptop" },
    { signingKey: W1.signingKey, name: "work browser" },
    { signingKey: Q.signingKey, name: "tablet" },
  ];
  const m = { accountId: idA, list: LV, phoneSeed: seed("phone signing"), phoneBoxSecretKey: phoneBox, ordering: ORDERING, names: textNames };
  make("every device's name, a copy for each client", m, nonces(3), 3, 0, GOOD);
  make("a name whose cap falls inside a three-byte character: cut before it, to 198 bytes", { ...m, names: [...textNames.slice(0, 4), { signingKey: Q.signingKey, name: "t".repeat(198) + "\u20ac" }] }, nonces(3), 3, 0, [...GOOD.slice(0, 4), [Q, "t".repeat(198)]]);
  make("a name with a lone surrogate: replaced by U+FFFD", { ...m, names: [...textNames.slice(0, 4), { signingKey: Q.signingKey, name: "tab\ud800let" }] }, nonces(3), 3, 0, [...GOOD.slice(0, 4), [Q, "tab\ufffdlet"]]);
  make("a client with an all-zero box key: skipped, the others sealed", { ...m, list: { counter: 4n, devices: [P, C1, C2, { ...W1, boxKey: ZERO_KEY }, Q] } }, nonces(3), 2, 1, GOOD);
  return namesOut;
}

// ------------------------------------------------------------- writing

const files: Record<string, CaseFile<FramedCase> | CaseFile<ListCase> | CaseFile<SealedCase> | CaseFile<NamesCase>> = {
  "framed.json": {
    about: "framed(context, parts...) and the 8-byte number in a part (docs/e2e.md, section 2). A case with throws is refused: the context, or the number, is the caller's mistake.",
    cases: framedCases(),
  },
  "list.json": {
    about: "A version of the device list, checked (docs/e2e.md, sections 3 and 6); the phone's list maker, to exact bytes; RFC 8032's test 1 for the raw Ed25519 verify. go is the relay's result where Go's crypto/ed25519 differs from libsodium.",
    cases: listCases(),
  },
  "sealed.json": {
    about: "A computer's sealed copies of a session's announcement and notice (docs/e2e.md, section 5): sealing, to exact bytes with the nonces given, and opening.",
    cases: sealedCases(),
  },
  "names.json": {
    about: "The devices' names, signed and sealed by the account's phone (docs/e2e.md, section 3): opening, and the phone's maker to exact bytes with the nonces given.",
    cases: namesCases(),
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
