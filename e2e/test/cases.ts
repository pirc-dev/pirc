// The form of cases/e2e/'s files (cases/README.md), shared by the generator
// (gen.ts) and the runner (cases.test.ts).
import type { ListBody } from "@pirc/protocol/v1alpha2";

import type { DeviceKeys, ListResult } from "../index.ts";

export const CASES_DIR = new URL("../../cases/e2e/", import.meta.url);

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const unhex = (s: string): Uint8Array => {
  if (!/^([0-9a-f]{2})*$/.test(s)) throw new Error(`not hex: ${s.slice(0, 40)}`);
  return Uint8Array.from(Buffer.from(s, "hex"));
};

export interface DeviceJson {
  role: number;
  signingKey: string;
  channelKey: string;
  boxKey: string;
  readOnlyKey: string;
  notificationKey: string;
}

export interface ListJson {
  accountId: string;
  counter: string;
  previousHash: string;
  devices: DeviceJson[];
}

export type Expect =
  | { result: "accepted"; counter: string; hash: string; list: ListJson }
  | { result: "old"; counter: string; hash: string }
  | { result: "unsupported"; reason: string; counter: string; hash: string }
  | { result: "refused"; reason: string }
  | { throws: true };

/** The relay's result where Go's crypto/ed25519 accepts what libsodium refuses. */
export type GoExpect = { result: "accepted"; counter: string; hash: string };

/** framed.json: framed(context, parts...), or the 8-byte number of a value. */
export type FramedCase =
  | { check: "framed"; about: string; needs: string[]; context: string; parts: string[]; bytes: string }
  | { check: "framed"; about: string; needs: string[]; context: string; parts: string[]; throws: true }
  | { check: "number"; about: string; needs: string[]; value: string; bytes: string }
  | { check: "number"; about: string; needs: string[]; value: string; throws: true };

/** list.json: the list check, the list maker, and the raw Ed25519 verify. */
export type ListCase =
  | {
      check: "list";
      about: string;
      needs: string[];
      bytes: string;
      phoneKey: string;
      mode: "first" | "later";
      accountId?: string;
      highest: string;
      self?: DeviceJson;
      expect: Expect;
      go?: GoExpect;
    }
  | {
      check: "make-list";
      about: string;
      needs: string[];
      seed: string;
      accountId: string;
      counter: string;
      previousBody: string;
      devices: DeviceJson[];
      bytes: string;
    }
  | { check: "verify"; about: string; needs: string[]; key: string; message: string; signature: string; valid: boolean };

export interface CaseFile<C> {
  about: string;
  cases: C[];
}

export function deviceJson(d: DeviceKeys): DeviceJson {
  return {
    role: d.role,
    signingKey: hex(d.signingKey),
    channelKey: hex(d.channelKey),
    boxKey: hex(d.boxKey),
    readOnlyKey: hex(d.readOnlyKey),
    notificationKey: hex(d.notificationKey),
  };
}

export function deviceKeys(d: DeviceJson): DeviceKeys {
  return {
    role: d.role,
    signingKey: unhex(d.signingKey),
    channelKey: unhex(d.channelKey),
    boxKey: unhex(d.boxKey),
    readOnlyKey: unhex(d.readOnlyKey),
    notificationKey: unhex(d.notificationKey),
  };
}

function listJson(l: ListBody): ListJson {
  return { accountId: hex(l.accountId), counter: l.counter.toString(), previousHash: hex(l.previousHash), devices: l.devices.map(deviceJson) };
}

/** A check's result as the files write it. */
export function expectOf(r: ListResult): Expect {
  switch (r.result) {
    case "accepted":
      return { result: r.result, counter: r.counter.toString(), hash: hex(r.hash), list: listJson(r.list) };
    case "old":
      return { result: r.result, counter: r.counter.toString(), hash: hex(r.hash) };
    case "unsupported":
      return { result: r.result, reason: r.reason, counter: r.counter.toString(), hash: hex(r.hash) };
    case "refused":
      return { result: r.result, reason: r.reason };
  }
}
