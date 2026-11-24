// The form of cases/e2e/'s files (cases/README.md), shared by the generator
// (gen.ts) and the runner (cases.test.ts).
import type { ListBody } from "@pirc/protocol/v1alpha2";

import type { AnnouncementText, DeviceKeys, DeviceName, ListResult, ListView, NamesResult, NoticeText, OpenResult, Sealed, Slot } from "../index.ts";

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

// ------------------------------------------------- sealed.json, names.json

export interface ListViewJson {
  counter: string;
  devices: DeviceJson[];
}

export interface SlotJson {
  accountId: string;
  computerKey: string;
  sessionId: string;
  kind: "announcement" | "notice";
}

export interface CopyJson {
  signingKey: string;
  recipientKey: string;
  sealed: string;
}

/** opened: the text each copy opens to; present exactly when there are copies. */
export type SealExpect = { copies: CopyJson[]; skipped: string[]; opened?: Record<string, string> } | { throws: true };

export type OpenExpect = { result: "accepted"; ordering: string; body: Record<string, string> } | { result: "refused"; reason: string };

export type SealedCase =
  | {
      check: "open";
      about: string;
      needs: string[];
      sealed: string;
      slot: SlotJson;
      recipientSecretKey: string;
      list: ListViewJson;
      highest?: string;
      now: string;
      expect: OpenExpect;
    }
  | {
      check: "seal";
      about: string;
      needs: string[];
      list: ListViewJson;
      boxSecretKey: string;
      slot: SlotJson;
      ordering: string;
      body: Record<string, string>;
      nonces: string[];
      /** Each copy's recipient's secret key, in the order of the copies. */
      recipientSecretKeys: string[];
      expect: SealExpect;
    };

export interface NameJson {
  signingKey: string;
  name: string;
}

export type NamesExpect =
  | { result: "accepted"; ordering: string; listCounter: string; names: NameJson[]; dropped: NameJson[] }
  | { result: "later" }
  | { result: "refused"; reason: string };

export type NamesCase =
  | {
      check: "open-names";
      about: string;
      needs: string[];
      sealed: string;
      accountId: string;
      list: ListViewJson;
      phoneKey: string;
      recipientSecretKey: string;
      highest?: string;
      now: string;
      expect: NamesExpect;
    }
  | {
      check: "make-names";
      about: string;
      needs: string[];
      accountId: string;
      list: ListViewJson;
      phoneSeed: string;
      phoneBoxSecretKey: string;
      ordering: string;
      names: NameJson[];
      nonces: string[];
      expect: { copies: CopyJson[]; skipped: string[] };
    };

export function listViewJson(l: ListView): ListViewJson {
  return { counter: l.counter.toString(), devices: l.devices.map(deviceJson) };
}

export function listView(l: ListViewJson): ListView {
  return { counter: BigInt(l.counter), devices: l.devices.map(deviceKeys) };
}

export function slotJson(s: Slot): SlotJson {
  return { accountId: hex(s.accountId), computerKey: hex(s.computerKey), sessionId: hex(s.sessionId), kind: s.kind };
}

export function slotOf(s: SlotJson): Slot {
  return { accountId: unhex(s.accountId), computerKey: unhex(s.computerKey), sessionId: unhex(s.sessionId), kind: s.kind };
}

export function sealedJson(s: Sealed): { copies: CopyJson[]; skipped: string[] } {
  return {
    copies: s.copies.map((c) => ({ signingKey: hex(c.signingKey), recipientKey: hex(c.recipientKey), sealed: hex(c.sealed) })),
    skipped: s.skipped.map(hex),
  };
}

export function openExpectOf(r: OpenResult<AnnouncementText | NoticeText>): OpenExpect {
  return r.result === "accepted" ? { result: r.result, ordering: r.ordering.toString(), body: { ...r.body } } : { result: r.result, reason: r.reason };
}

export function namesExpectOf(r: NamesResult): NamesExpect {
  const names = (ns: DeviceName[]) => ns.map((n) => ({ signingKey: hex(n.signingKey), name: n.name }));
  if (r.result === "accepted") {
    return { result: r.result, ordering: r.ordering.toString(), listCounter: r.listCounter.toString(), names: names(r.names), dropped: names(r.dropped) };
  }
  return r.result === "later" ? { result: r.result } : { result: r.result, reason: r.reason };
}

/** cases/e2e/join.json: a join's text, its prologue, and the offers (docs/e2e.md, section 6). */
export type JoinCase =
  | { check: "join-text"; about: string; lookup: string; secret: string; text: string }
  | { check: "read-join-text"; about: string; input: string; expect: { lookup: string; secret: string } | null }
  | { check: "join-prologue"; about: string; lookup: string; bytes: string }
  | { check: "make-offer"; about: string; device: DeviceJson; seed: string; handshakeHash: string; bytes: string }
  | {
      check: "check-offer";
      about: string;
      offer: string;
      role: number;
      remoteStatic: string;
      handshakeHash: string;
      expect: { result: "accepted"; device: DeviceJson } | { result: "refused"; reason: string };
    };
