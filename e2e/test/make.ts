// The test-only list maker, shared by e2e/test/gen.ts and the tests that
// run against the Go relay (relay-client/test/hosted.test.ts): devices'
// keys from fixed seeds, protobuf by hand, and the phone's signature. No
// device makes lists in TypeScript; the account's phone makes them in
// Dart (app/lib/e2e/list.dart).
import { create, toBinary } from "@bufbuild/protobuf";
import { DeviceSchema, ListBodySchema } from "@pirc/protocol/v1alpha2";
import sodium from "libsodium-wrappers-sumo";

import { framed, LIST_CONTEXT, type DeviceKeys } from "../index.ts";

await sodium.ready;

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const EMPTY = new Uint8Array(0);

export type Dev = DeviceKeys;

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export const sha256 = (b: Uint8Array): Uint8Array => sodium.crypto_hash_sha256(b);
export const seed = (name: string): Uint8Array => sha256(utf8(`pirc e2e test seed: ${name}`));

// A device's keys, from seeds made of its name.
export function device(name: string, role: number, phone: boolean): Dev {
  return {
    role,
    signingKey: sodium.crypto_sign_seed_keypair(seed(`${name} signing`)).publicKey,
    channelKey: sodium.crypto_box_seed_keypair(seed(`${name} channel`)).publicKey,
    boxKey: sodium.crypto_box_seed_keypair(seed(`${name} box`)).publicKey,
    readOnlyKey: phone ? sodium.crypto_sign_seed_keypair(seed(`${name} read-only`)).publicKey : EMPTY,
    notificationKey: phone ? sodium.crypto_box_seed_keypair(seed(`${name} notification`)).publicKey : EMPTY,
  };
}

// ------------------------------------------- protobuf by hand, and the maker

export type Field = { no: number; varint: bigint } | { no: number; bytes: Uint8Array };

export function varint(v: bigint): number[] {
  const out: number[] = [];
  do {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v > 0n ? b | 0x80 : b);
  } while (v > 0n);
  return out;
}

export function encode(fields: Field[]): Uint8Array {
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

export function deviceFields(d: Dev, extra: Field[] = []): Field[] {
  const f: Field[] = [];
  if (d.role !== 0) f.push({ no: 1, varint: BigInt(d.role) });
  const keys = [d.signingKey, d.channelKey, d.boxKey, d.readOnlyKey, d.notificationKey];
  keys.forEach((k, i) => {
    if (k.length > 0) f.push({ no: i + 2, bytes: k });
  });
  return [...f, ...extra];
}

export interface Body {
  accountId: Uint8Array;
  counter: bigint;
  previousHash: Uint8Array;
  devices: Dev[];
}

export function bodyFields(b: Body, deviceExtra: Map<number, Field[]> = new Map()): Field[] {
  const f: Field[] = [];
  if (b.accountId.length > 0) f.push({ no: 1, bytes: b.accountId });
  if (b.counter !== 0n) f.push({ no: 2, varint: b.counter });
  if (b.previousHash.length > 0) f.push({ no: 3, bytes: b.previousHash });
  b.devices.forEach((d, i) => f.push({ no: 4, bytes: encode(deviceFields(d, deviceExtra.get(i))) }));
  return f;
}

/** A body as protobuf-es writes it, which must equal the encoding by hand. */
export function body(b: Body): Uint8Array {
  const made = toBinary(
    ListBodySchema,
    create(ListBodySchema, {
      ...b,
      devices: b.devices.map((d) => create(DeviceSchema, d)),
    }),
  );
  if (!equal(made, encode(bodyFields(b)))) throw new Error("make: protobuf-es and the encoding by hand differ");
  return made;
}

export function signList(b: Uint8Array, accountId: Uint8Array, secret: Uint8Array, context = LIST_CONTEXT): Uint8Array {
  return concat(sodium.crypto_sign_detached(framed(context, accountId, b), secret), b);
}

/** The test-only list maker: what the account's phone does (in Dart), without its checks. */
export function makeList(m: { seed: Uint8Array; accountId: Uint8Array; counter: bigint; previousBody: Uint8Array | null; devices: Dev[] }): Uint8Array {
  const b = body({
    accountId: m.accountId,
    counter: m.counter,
    previousHash: m.previousBody ? sha256(m.previousBody) : EMPTY,
    devices: m.devices,
  });
  return signList(b, m.accountId, sodium.crypto_sign_seed_keypair(m.seed).privateKey);
}

/** A device's signing key pair, whose public key is device()'s signingKey, and a signer with it. */
export function signingPair(name: string): {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
} {
  const kp = sodium.crypto_sign_seed_keypair(seed(`${name} signing`));
  return {
    publicKey: kp.publicKey,
    sign: (m) => sodium.crypto_sign_detached(m, kp.privateKey),
  };
}
