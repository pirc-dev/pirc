// Opening the devices' names (docs/e2e.md, section 3): signed by the
// account's phone over framed("pirc-e2e-v2 names", account ID, body), the
// signature then the body sealed with crypto_box from the phone's box key
// to each client's. No input bytes make opening throw; only a caller's
// mistake does.
import { fromBinary } from "@bufbuild/protobuf";
import { NamesSchema, type Names } from "@pirc/protocol/v1alpha2";
import type sodiumType from "libsodium-wrappers-sumo";

import { equal, hex, isBytes, utf8Text } from "./bytes.ts";
import { framed } from "./framed.ts";
import { isDeviceKeys } from "./list.ts";
import { FUTURE_MS, NONCE_BYTES, type ListView } from "./sealed.ts";

type Sodium = typeof sodiumType;

export const NAMES_CONTEXT = "pirc-e2e-v2 names";
export const NAMES_MAX_BYTES = 32_768;
export const NAME_MAX_BYTES = 200;

const SIGNATURE_BYTES = 64;
const ORDERING_LIMIT = 1n << 63n;

export interface NamesInput {
  sealed: Uint8Array;
  accountId: Uint8Array;
  list: ListView;
  /** The account's phone's signing key, pinned at the join. */
  phoneKey: Uint8Array;
  /** This client's box secret key. */
  recipientSecretKey: Uint8Array;
  /** The highest names ordering seen, or null if none. */
  highest: bigint | null;
  /** The time now, in milliseconds. */
  now: bigint;
}

export interface DeviceName {
  signingKey: Uint8Array;
  name: string;
}

export type NamesRefusedReason = "size" | "box" | "signature" | "parse" | "range" | "ordering" | "future" | "text" | "duplicate-key";

export type NamesResult =
  | { result: "accepted"; ordering: bigint; listCounter: bigint; names: DeviceName[]; dropped: DeviceName[] }
  | { result: "later" }
  | { result: "refused"; reason: NamesRefusedReason };

function isNamesInput(x: NamesInput): boolean {
  const l = x?.list as unknown as Record<string, unknown> | undefined;
  return (
    isBytes(x?.sealed) &&
    isBytes(x.accountId) &&
    typeof l === "object" &&
    l !== null &&
    typeof l.counter === "bigint" &&
    Array.isArray(l.devices) &&
    l.devices.every(isDeviceKeys) &&
    isBytes(x.phoneKey) &&
    isBytes(x.recipientSecretKey) &&
    (x.highest === null || (typeof x.highest === "bigint" && x.highest >= 0n)) &&
    typeof x.now === "bigint"
  );
}

export function openNames(sodium: Sodium, input: NamesInput): NamesResult {
  if (!isNamesInput(input)) throw new TypeError("openNames: the inputs are bytes, a list, keys, the highest seen (or null) and now");
  const refused = (reason: NamesRefusedReason) => ({ result: "refused", reason }) as const;
  const { sealed, list } = input;

  // 1. Size.
  if (sealed.length > NAMES_MAX_BYTES) return refused("size");
  // 2. The box, from the phone's box key on the newest list; then room for a signature.
  const phone = list.devices.find((d) => equal(d.signingKey, input.phoneKey));
  if (!phone) return refused("box");
  let plaintext: Uint8Array;
  try {
    plaintext = sodium.crypto_box_open_easy(sealed.subarray(NONCE_BYTES), sealed.subarray(0, NONCE_BYTES), phone.boxKey, input.recipientSecretKey);
  } catch {
    return refused("box");
  }
  if (plaintext.length < SIGNATURE_BYTES) return refused("signature");
  // 3. The phone's signature over the body, then the parse.
  const body = plaintext.subarray(SIGNATURE_BYTES);
  let verified = false;
  try {
    verified = sodium.crypto_sign_verify_detached(plaintext.subarray(0, SIGNATURE_BYTES), framed(NAMES_CONTEXT, input.accountId, body), input.phoneKey);
  } catch {
    verified = false;
  }
  if (!verified) return refused("signature");
  let names: Names;
  try {
    names = fromBinary(NamesSchema, body);
  } catch {
    return refused("parse");
  }
  // 4. The ordering value.
  if (names.ordering >= ORDERING_LIMIT) return refused("range");
  if (input.highest !== null && names.ordering <= input.highest) return refused("ordering");
  if (names.ordering > input.now + FUTURE_MS) return refused("future");
  // 5. Names from a list the caller does not have yet.
  if (names.listCounter > list.counter) return { result: "later" };
  // 6. Each name, and each key once.
  const seen = new Set<string>();
  const all: DeviceName[] = [];
  for (const n of names.names) {
    const text = n.name.length <= NAME_MAX_BYTES ? utf8Text(n.name) : undefined;
    if (text === undefined) return refused("text");
    all.push({ signingKey: n.signingKey.slice(), name: text });
  }
  for (const n of all) {
    const k = hex(n.signingKey);
    if (seen.has(k)) return refused("duplicate-key");
    seen.add(k);
  }
  // 7. Names of devices not on the newest list, apart.
  const listed = (n: DeviceName) => list.devices.some((d) => equal(d.signingKey, n.signingKey));
  return { result: "accepted", ordering: names.ordering, listCounter: names.listCounter, names: all.filter(listed), dropped: all.filter((n) => !listed(n)) };
}
