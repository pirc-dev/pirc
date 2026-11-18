// A host's anchor (docs/e2e.md, section 3, "A host's anchor"): the account
// this machine joined with /pirc join, in a folder of its own beside
// host.json, shared by every pi process on the machine:
//
//   hosted/account.json            the relay's origin, the account ID, and
//                                  the version the join set
//   hosted/versions/N-HASH         each version checked, as signed
//   hosted/withdrawals/HASH        each withdrawal checked, by the hash
//                                  withdrawn
//
// Each file is created once, by an exclusive link, and never replaced, so
// that processes writing at once agree. The anchor is the highest version
// on the chain from the joined one that is not withdrawn; two of one
// number, neither withdrawn, are a fork, which every process finds by
// reading the folder. The folder is never pruned. Only /pirc join sets it,
// and /pirc leave removes it.
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { SignedObjectSchema, type SignedObject } from "@pirc/protocol/v1alpha2";
import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { hex, unhex } from "@pirc/crypto/bytes";
import { Chain, type Change } from "@pirc/crypto/chain";
import { hash, open } from "@pirc/crypto/objects";

import { configPath } from "../config.ts";

export interface AccountFile {
  origin: string;
  accountId: string;
  // The version /pirc join set, by number and hash.
  joined: { number: string; hash: string };
  joinedAt: string;
  // The client that approved the join, by key, and the name it gave.
  approver: string;
  approverName: string;
}

export function anchorDir(): string {
  return join(dirname(configPath()), "hosted");
}

/** Writes a file once: aside, then linked into place; false when it was there. */
function createOnce(path: string, data: Uint8Array | string): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  } finally {
    unlinkSync(tmp);
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.includes("."));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

const readObject = (path: string): SignedObject => fromBinary(SignedObjectSchema, new Uint8Array(readFileSync(path)));

export type AnchorState =
  // Serving: the chain's latest version lists this host.
  | { kind: "joined" }
  // Two versions of one number that no withdrawal explains: this host
  // cannot tell which is its account's, and stops until /pirc join.
  | { kind: "fork"; number: bigint }
  // A version this host checked has removed it: the anchor is deleted.
  | { kind: "removed" }
  // The version that added this host was withdrawn: its join failed.
  | { kind: "join-failed" };

export class Anchor {
  private seen = new Set<string>();
  private constructor(
    readonly dir: string,
    readonly account: AccountFile,
    readonly accountId: Uint8Array,
    private chain: Chain,
  ) {}

  /** The anchor on this machine, or undefined when it has joined no account. */
  static async read(dir = anchorDir()): Promise<Anchor | undefined> {
    let account: AccountFile;
    try {
      account = JSON.parse(readFileSync(join(dir, "account.json"), "utf8")) as AccountFile;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`${join(dir, "account.json")}: ${(e as Error).message}`);
    }
    const accountId = unhex(account.accountId);
    const names = list(join(dir, "versions"));
    const v1 = names.find((n) => n.startsWith("1-"));
    if (!v1) throw new Error(`${dir}: no version 1`);
    const chain = await Chain.start(readObject(join(dir, "versions", v1)), accountId);
    const a = new Anchor(dir, account, accountId, chain);
    a.seen.add(v1);
    await a.refresh();
    return a;
  }

  /**
   * Makes the anchor from a join: the folder written aside and moved into
   * place, replacing any anchor there (only /pirc join does this).
   */
  static async create(account: AccountFile, chain: Chain, dir = anchorDir()): Promise<Anchor> {
    const tmp = `${dir}.${process.pid}.${randomBytes(4).toString("hex")}`;
    mkdirSync(join(tmp, "versions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(tmp, "withdrawals"), { recursive: true, mode: 0o700 });
    writeFileSync(join(tmp, "account.json"), JSON.stringify(account, null, 2) + "\n", { mode: 0o600 });
    const s = chain.saved();
    for (const v of [...s.branch, ...s.others]) {
      const body = (await open("list", chain.accountId, v)) ?? (await open("list", new Uint8Array(0), v));
      writeFileSync(join(tmp, "versions", `${body!.number}-${hex(await hash(v))}`), toBinary(SignedObjectSchema, v), { mode: 0o600 });
    }
    for (const w of chain.withdrawals()) {
      const body = await open("withdrawal", chain.accountId, w);
      if (body?.withdrawn) writeFileSync(join(tmp, "withdrawals", hex(body.withdrawn.hash)), toBinary(SignedObjectSchema, w), { mode: 0o600 });
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    const a = await Anchor.read(dir);
    if (!a) throw new Error(`${dir}: not written`);
    return a;
  }

  /** /pirc leave: the host stops serving at once. */
  static remove(dir = anchorDir()): void {
    rmSync(dir, { recursive: true, force: true });
  }

  get latest() {
    return this.chain.latest;
  }

  get versions(): Chain {
    return this.chain;
  }

  /** Reads what other processes have written since. */
  async refresh(): Promise<Change> {
    const versions: SignedObject[] = [];
    const withdrawals: SignedObject[] = [];
    for (const n of list(join(this.dir, "versions"))) {
      if (this.seen.has(`v${n}`)) continue;
      this.seen.add(`v${n}`);
      versions.push(readObject(join(this.dir, "versions", n)));
    }
    for (const n of list(join(this.dir, "withdrawals"))) {
      if (this.seen.has(`w${n}`)) continue;
      this.seen.add(`w${n}`);
      withdrawals.push(readObject(join(this.dir, "withdrawals", n)));
    }
    return this.chain.add(versions, withdrawals);
  }

  /** Checks versions and withdrawals (from the relay, or a request) and records those that check. */
  async record(versions: SignedObject[], withdrawals: SignedObject[]): Promise<Change> {
    await this.refresh();
    const change = await this.chain.add(versions, withdrawals);
    const bad = new Set(change.refused.map((r) => r.object));
    for (const v of versions) {
      if (bad.has(v)) continue;
      const body = await open("list", this.accountId, v);
      if (!body) continue;
      const name = `${body.number}-${hex(await hash(v))}`;
      this.seen.add(`v${name}`);
      createOnce(join(this.dir, "versions", name), toBinary(SignedObjectSchema, v));
    }
    for (const w of withdrawals) {
      if (bad.has(w)) continue;
      const body = await open("withdrawal", this.accountId, w);
      if (!body?.withdrawn) continue;
      const name = hex(body.withdrawn.hash);
      this.seen.add(`w${name}`);
      createOnce(join(this.dir, "withdrawals", name), toBinary(SignedObjectSchema, w));
    }
    return change;
  }

  /** What the anchor says of this host now. */
  state(me: Uint8Array, forks: Change["forks"]): AnchorState {
    if (forks.length) return { kind: "fork", number: forks[0].body.number };
    const joined = this.chain.onBranch(BigInt(this.account.joined.number), unhex(this.account.joined.hash));
    if (!joined) return { kind: "join-failed" };
    if (!this.chain.latest.body.devices.some((d) => hex(d.publicKey) === hex(me))) return { kind: "removed" };
    return { kind: "joined" };
  }
}
