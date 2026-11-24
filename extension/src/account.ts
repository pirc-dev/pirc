// A computer's account files (docs/e2e.md, sections 3 and 9): its keys,
// the account it joined, and every version of the account's list it has
// received. They live in an `account` folder beside host.json, and exist
// only on a computer that has joined a hosted account:
//
//   account/keys          {signing, channel, box}: 32-byte secrets, base64url
//   account/account.json  {accountId, phoneKey, origin}
//   account/lists/<n>     version n of the list, as signed bytes
//
// Several pi processes share the folder and no lock: a version is written
// aside, flushed, then linked to its name, which fails if the name exists,
// so no process can undo or tear another's write.
import { createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DeviceKeys, E2e } from "@pirc/e2e";
import { ROLE_CLIENT, ROLE_COMPUTER } from "@pirc/e2e";
import type { ListBody } from "@pirc/protocol/v1alpha2";

export const ACCOUNT_DIR = "account";
const KEY_BYTES = 32;
// PKCS #8 for an Ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function accountDir(configPath: string): string {
  return join(dirname(configPath), ACCOUNT_DIR);
}

export interface Secrets {
  signing: Uint8Array;
  channel: Uint8Array;
  box: Uint8Array;
}

export interface AccountKeys {
  signingKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
  channelSecret: Uint8Array;
  channelKey: Uint8Array;
  boxSecret: Uint8Array;
  boxKey: Uint8Array;
}

export interface AccountInfo {
  accountId: Uint8Array;
  phoneKey: Uint8Array;
  origin: string;
}

export function newSecrets(): Secrets {
  return { signing: new Uint8Array(randomBytes(KEY_BYTES)), channel: new Uint8Array(randomBytes(KEY_BYTES)), box: new Uint8Array(randomBytes(KEY_BYTES)) };
}

/** The public halves; X25519's by libsodium, given as scalarmultBase. */
export function keysOf(s: Secrets, scalarmultBase: (secret: Uint8Array) => Uint8Array): AccountKeys {
  const privateKey: KeyObject = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(s.signing)]), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return {
    signingKey: new Uint8Array(Buffer.from(jwk.x!, "base64url")),
    sign: (m) => new Uint8Array(sign(null, m, privateKey)),
    channelSecret: s.channel,
    channelKey: scalarmultBase(s.channel),
    boxSecret: s.box,
    boxKey: scalarmultBase(s.box),
  };
}

/** This computer as the list holds it. */
export function selfDevice(k: AccountKeys): DeviceKeys {
  return { role: ROLE_COMPUTER, signingKey: k.signingKey, channelKey: k.channelKey, boxKey: k.boxKey, readOnlyKey: new Uint8Array(0), notificationKey: new Uint8Array(0) };
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function bytes32(v: unknown, what: string): Uint8Array {
  if (typeof v !== "string") throw new Error(`${what} is missing`);
  const b = new Uint8Array(Buffer.from(v, "base64url"));
  if (b.length !== KEY_BYTES || b64(b) !== v) throw new Error(`${what} is not 32 bytes of base64url`);
  return b;
}

/** Whether this computer has joined an account: its account folder exists. */
export function hasAccount(dir: string): boolean {
  try {
    readdirSync(dir);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export function readSecrets(dir: string): Secrets {
  const f = JSON.parse(readFileSync(join(dir, "keys"), "utf8")) as Record<string, unknown>;
  return { signing: bytes32(f.signing, "keys: signing"), channel: bytes32(f.channel, "keys: channel"), box: bytes32(f.box, "keys: box") };
}

export function readInfo(dir: string): AccountInfo {
  const f = JSON.parse(readFileSync(join(dir, "account.json"), "utf8")) as Record<string, unknown>;
  if (typeof f.origin !== "string" || !f.origin) throw new Error("account.json: origin is missing");
  return { accountId: bytes32(f.accountId, "account.json: accountId"), phoneKey: bytes32(f.phoneKey, "account.json: phoneKey"), origin: f.origin };
}

function flushFolder(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Written, flushed and closed; Node's flush on macOS is F_FULLFSYNC.
function writeFlushed(path: string, data: Uint8Array | string, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data) : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a whole account folder at `dir`, replacing any there: made aside,
 * then renamed into place, so a crash leaves the old account or the new
 * one. For the join, and tests.
 */
export function writeAccount(dir: string, s: Secrets, info: AccountInfo, lists: { counter: bigint; bytes: Uint8Array }[]): void {
  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tmp = join(parent, `.${ACCOUNT_DIR}-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(join(tmp, "lists"), { recursive: true, mode: 0o700 });
  writeFlushed(join(tmp, "keys"), JSON.stringify({ signing: b64(s.signing), channel: b64(s.channel), box: b64(s.box) }) + "\n", 0o600);
  writeFlushed(join(tmp, "account.json"), JSON.stringify({ accountId: b64(info.accountId), phoneKey: b64(info.phoneKey), origin: info.origin }, null, 2) + "\n", 0o600);
  for (const l of lists) writeFlushed(join(tmp, "lists", String(l.counter)), l.bytes, 0o600);
  flushFolder(join(tmp, "lists"));
  flushFolder(tmp);
  const old = `${tmp}.old`;
  let moved = false;
  try {
    renameSync(dir, old);
    moved = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  renameSync(tmp, dir);
  flushFolder(parent);
  if (moved) rmSync(old, { recursive: true, force: true });
}

/** Deletes the account folder: /pirc leave. */
export function removeAccount(dir: string): void {
  const gone = `${dir}.${process.pid}-${randomBytes(4).toString("hex")}.gone`;
  try {
    renameSync(dir, gone);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  flushFolder(dirname(dir));
  rmSync(gone, { recursive: true, force: true });
}

export interface HeldList {
  counter: bigint;
  bytes: Uint8Array;
  body: ListBody;
}

export type Offered =
  | { result: "newer"; list: HeldList }
  | { result: "old"; counter: bigint }
  // The phone signed two versions with one counter.
  | { result: "conflict"; counter: bigint }
  | { result: "refused"; reason: string };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The account's lists in `dir`/lists: the newest one this computer holds,
 * read again on demand, and newer ones stored as they arrive.
 */
export class ListFolder {
  private held: HeldList | undefined;
  // Files already found wanting, so each is reported once.
  private refused = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly e2e: E2e,
    private readonly info: AccountInfo,
    private readonly report: (msg: string) => void,
  ) {}

  get newest(): HeldList | undefined {
    return this.held;
  }

  private get lists(): string {
    return join(this.dir, "lists");
  }

  private check(bytes: Uint8Array, counter: bigint): HeldList | string {
    const r = this.e2e.checkList(
      counter === 1n
        ? { bytes, phoneKey: this.info.phoneKey, mode: "first", accountId: this.info.accountId, highest: 0n }
        : { bytes, phoneKey: this.info.phoneKey, mode: "later", accountId: this.info.accountId, highest: 0n },
    );
    if (r.result !== "accepted") return r.result === "refused" || r.result === "unsupported" ? `${r.result} (${r.reason})` : r.result;
    if (r.counter !== counter) return `holds version ${r.counter}`;
    return { counter, bytes, body: r.list };
  }

  /** Reads the folder for a version newer than the one held; true if it found one. */
  scan(): boolean {
    let names: string[];
    try {
      names = readdirSync(this.lists);
    } catch (e) {
      this.report(`account lists: ${(e as Error).message}`);
      return false;
    }
    const above = this.held?.counter ?? 0n;
    const counters = names
      .filter((n) => /^[1-9][0-9]{0,18}$/.test(n))
      .map((n) => BigInt(n))
      .filter((c) => c > above)
      .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    for (const c of counters) {
      const name = String(c);
      if (this.refused.has(name)) continue;
      let got: HeldList | string;
      try {
        got = this.check(new Uint8Array(readFileSync(join(this.lists, name))), c);
      } catch (e) {
        got = (e as Error).message;
      }
      if (typeof got === "string") {
        this.refused.add(name);
        this.report(`account list ${name} is not usable: ${got}`);
        continue;
      }
      this.held = got;
      return true;
    }
    return false;
  }

  /** A version from the relay or a client: stored and taken if newer. */
  offer(bytes: Uint8Array): Offered {
    const r = this.e2e.checkList({ bytes, phoneKey: this.info.phoneKey, mode: "later", accountId: this.info.accountId, highest: this.held?.counter ?? 0n });
    if (r.result === "refused" || r.result === "unsupported") return { result: "refused", reason: `${r.result} (${r.reason})` };
    const path = join(this.lists, String(r.counter));
    if (r.result === "old") {
      let mine: Uint8Array | undefined;
      try {
        mine = new Uint8Array(readFileSync(path));
      } catch {
        // Not kept: an older version this computer skipped.
      }
      if (mine && !sameBytes(mine, bytes)) return { result: "conflict", counter: r.counter };
      return { result: "old", counter: r.counter };
    }
    const tmp = join(this.lists, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    writeFlushed(tmp, bytes, 0o600);
    try {
      linkSync(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!sameBytes(new Uint8Array(readFileSync(path)), bytes)) return { result: "conflict", counter: r.counter };
    } finally {
      unlinkSync(tmp);
    }
    flushFolder(this.lists);
    this.held = { counter: r.counter, bytes, body: r.list };
    return { result: "newer", list: this.held };
  }
}

/** Whether `list` holds this computer, keys and role exactly. */
export function listsSelf(list: ListBody, self: DeviceKeys): boolean {
  return list.devices.some(
    (d) =>
      d.role === ROLE_COMPUTER &&
      sameBytes(d.signingKey, self.signingKey) &&
      sameBytes(d.channelKey, self.channelKey) &&
      sameBytes(d.boxKey, self.boxKey),
  );
}

/** The client on `list` whose channel key this is, if any. */
export function clientByChannelKey(list: ListBody, channelKey: Uint8Array) {
  return list.devices.find((d) => d.role === ROLE_CLIENT && sameBytes(d.channelKey, channelKey));
}
