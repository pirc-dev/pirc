// Checking a version of an account's device list (docs/e2e.md, sections 3
// and 6): the signature first, on the bytes as received, then the body.
// No input makes it throw; only a caller's own mistake does.
import { fromBinary } from "@bufbuild/protobuf";
import { ListBodySchema, type Device, type ListBody } from "@pirc/protocol/v1alpha2";
import type sodiumType from "libsodium-wrappers-sumo";

import { equal, hex, isBytes } from "./bytes.ts";
import { framed } from "./framed.ts";

type Sodium = typeof sodiumType;

export const LIST_CONTEXT = "pirc-e2e-v2 list";

export const SIGNATURE_BYTES = 64;
export const LIST_MAX_BYTES = 16_384;
export const MAX_CLIENTS = 10;
export const MAX_COMPUTERS = 50;
export const ROLE_COMPUTER = 1;
export const ROLE_CLIENT = 2;

const COUNTER_LIMIT = 1n << 63n;
const KEY_BYTES = 32;
const ACCOUNT_ID_BYTES = 32;

/** A device's role and its five keys, as the list holds them (empty where it has none). */
export type DeviceKeys = Pick<Device, "role" | "signingKey" | "channelKey" | "boxKey" | "readOnlyKey" | "notificationKey">;

export interface ListInput {
  /** The signed list as received: the 64-byte signature, then the body. */
  bytes: Uint8Array;
  /** The account's phone's signing key, pinned at the join. */
  phoneKey: Uint8Array;
  /**
   * "first" for version 1, "later" for any other. In first mode
   * `accountId` is optional: when given, version 1's body must hash to it.
   * In later mode it is required. Either way it is 32 bytes.
   */
  mode: "first" | "later";
  accountId?: Uint8Array;
  /** The highest counter held, 0n if none; a bigint. */
  highest: bigint;
  /** At a join, the joining device itself; later mode only. */
  self?: DeviceKeys;
}

export type ListRefusedReason = "size" | "signature" | "parse" | "range" | "mode" | "self";
export type ListUnsupportedReason = "unknown-field" | "role" | "key" | "phone-keys" | "duplicate-key" | "count" | "phone";

export type ListResult =
  | { result: "accepted"; list: ListBody; counter: bigint; hash: Uint8Array }
  | { result: "old"; counter: bigint; hash: Uint8Array }
  | { result: "unsupported"; reason: ListUnsupportedReason; counter: bigint; hash: Uint8Array }
  | { result: "refused"; reason: ListRefusedReason };

const isAccountId = (x: unknown): x is Uint8Array => isBytes(x) && x.length === ACCOUNT_ID_BYTES;

/** A role and five byte arrays. */
export function isDeviceKeys(x: unknown): x is DeviceKeys {
  if (typeof x !== "object" || x === null) return false;
  const d = x as Record<string, unknown>;
  return (
    Number.isInteger(d.role) &&
    isBytes(d.signingKey) &&
    isBytes(d.channelKey) &&
    isBytes(d.boxKey) &&
    isBytes(d.readOnlyKey) &&
    isBytes(d.notificationKey)
  );
}

function unsupported(reason: ListUnsupportedReason, counter: bigint, hash: Uint8Array): ListResult {
  return { result: "unsupported", reason, counter, hash };
}

export function checkList(sodium: Sodium, input: ListInput): ListResult {
  const { mode, self } = input;
  if (mode !== "first" && mode !== "later") throw new TypeError(`checkList: mode ${String(mode)}`);
  if (mode === "first" && self) throw new TypeError("checkList: self is checked in later mode only");
  if (mode === "later" ? !isAccountId(input.accountId) : input.accountId !== undefined && !isAccountId(input.accountId)) {
    throw new TypeError("checkList: the account ID is 32 bytes, and later mode needs it");
  }
  if (self !== undefined && !isDeviceKeys(self)) throw new TypeError("checkList: self is a role and five byte arrays");
  if (typeof input.highest !== "bigint" || input.highest < 0n) throw new TypeError("checkList: highest must be a bigint, 0n or more");

  // 1. Size, before anything is read.
  if (input.bytes.length < SIGNATURE_BYTES || input.bytes.length > LIST_MAX_BYTES) return { result: "refused", reason: "size" };
  // A copy, never a view (Buffer's slice is one): the parsed list's bytes
  // fields are views of it, and so share nothing with the caller's buffer.
  const bytes = new Uint8Array(input.bytes);
  const signature = bytes.subarray(0, SIGNATURE_BYTES);
  const body = bytes.subarray(SIGNATURE_BYTES);

  // 2. The signature, over the body as received; only then the parse.
  const signedId = mode === "first" ? new Uint8Array(0) : input.accountId!;
  let verified = false;
  try {
    verified = sodium.crypto_sign_verify_detached(signature, framed(LIST_CONTEXT, signedId, body), input.phoneKey);
  } catch {
    verified = false;
  }
  if (!verified) return { result: "refused", reason: "signature" };
  let list: ListBody;
  try {
    list = fromBinary(ListBodySchema, body);
  } catch {
    return { result: "refused", reason: "parse" };
  }
  const counter = list.counter;
  const hash = sodium.crypto_hash_sha256(body);

  // 3. The counter's range, before it is compared with anything.
  if (counter >= COUNTER_LIMIT) return { result: "refused", reason: "range" };

  // 4. The mode and the body agree.
  if (mode === "first") {
    const expected = input.accountId;
    if (counter !== 1n || list.accountId.length !== 0 || list.previousHash.length !== 0 || (expected && !equal(hash, expected))) {
      return { result: "refused", reason: "mode" };
    }
  } else if (counter < 2n || !equal(list.accountId, input.accountId!) || list.previousHash.length !== KEY_BYTES) {
    return { result: "refused", reason: "mode" };
  }

  // 5. Newer than what is held.
  if (counter <= input.highest) return { result: "old", counter, hash };

  // 6. No unknown field, in the body or in any device.
  if ((list.$unknown?.length ?? 0) > 0 || list.devices.some((d) => (d.$unknown?.length ?? 0) > 0)) {
    return unsupported("unknown-field", counter, hash);
  }

  // 7. Roles.
  if (list.devices.some((d) => d.role !== ROLE_COMPUTER && d.role !== ROLE_CLIENT)) return unsupported("role", counter, hash);

  // 8. The three keys every device has.
  if (list.devices.some((d) => d.signingKey.length !== KEY_BYTES || d.channelKey.length !== KEY_BYTES || d.boxKey.length !== KEY_BYTES)) {
    return unsupported("key", counter, hash);
  }

  // 9. A phone's two keys: both or neither, and only on a client.
  for (const d of list.devices) {
    const r = d.readOnlyKey.length;
    const n = d.notificationKey.length;
    const both = r === KEY_BYTES && n === KEY_BYTES;
    const neither = r === 0 && n === 0;
    if (!(both || neither) || (both && d.role !== ROLE_CLIENT)) return unsupported("phone-keys", counter, hash);
  }

  // 10. No public key twice, across devices and kinds.
  const seen = new Set<string>();
  for (const d of list.devices) {
    for (const k of [d.signingKey, d.channelKey, d.boxKey, d.readOnlyKey, d.notificationKey]) {
      if (k.length === 0) continue;
      const h = hex(k);
      if (seen.has(h)) return unsupported("duplicate-key", counter, hash);
      seen.add(h);
    }
  }

  // 11. How many.
  const clients = list.devices.filter((d) => d.role === ROLE_CLIENT).length;
  const computers = list.devices.length - clients;
  if (list.devices.length === 0 || clients > MAX_CLIENTS || computers > MAX_COMPUTERS || (mode === "first" && list.devices.length !== 1)) {
    return unsupported("count", counter, hash);
  }

  // 12. The pinned phone, as a client with its phone keys.
  const phone = list.devices.find((d) => equal(d.signingKey, input.phoneKey));
  if (!phone || phone.role !== ROLE_CLIENT || phone.readOnlyKey.length !== KEY_BYTES) return unsupported("phone", counter, hash);

  // 13. At a join, the joining device exactly as it is.
  if (self && !list.devices.some((d) => sameDevice(d, self))) return { result: "refused", reason: "self" };

  return { result: "accepted", list, counter, hash };
}

function sameDevice(d: DeviceKeys, self: DeviceKeys): boolean {
  return (
    d.role === self.role &&
    equal(d.signingKey, self.signingKey) &&
    equal(d.channelKey, self.channelKey) &&
    equal(d.boxKey, self.boxKey) &&
    equal(d.readOnlyKey, self.readOnlyKey) &&
    equal(d.notificationKey, self.notificationKey)
  );
}
