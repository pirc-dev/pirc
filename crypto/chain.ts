// A device's view of its account's list (docs/e2e.md, section 3): the
// branch it follows from version 1, the versions it has seen off that
// branch, and the withdrawals. Versions are taken only when they check
// against the version they chain from; a version withdrawn by its own
// signer is left for the other with its number; two versions of one
// number that no withdrawal explains are a fork, which the caller acts on
// (a host stops, a client keeps its branch and says so).
//
// The same for hosts and clients, so that both decide alike; persisted by
// the caller as `saved()`, and loaded again with `Chain.load`.

import type { SignedObject } from "@pirc/protocol/v1alpha2";
import { hex } from "./bytes.ts";
import { checkFirst, checkNext, checkWithdrawal, Refused, type Version } from "./list.ts";
import { hash, open } from "./objects.ts";

/** What a change did: versions taken onto the branch, versions moved off it by a withdrawal, and forks no withdrawal explains. */
export type Change = {
  taken: Version[];
  dropped: Version[];
  forks: Version[];
  /** Objects that did not check, and why. */
  refused: { object: SignedObject; reason: string }[];
};

export type Saved = { branch: SignedObject[]; others: SignedObject[]; withdrawals: SignedObject[] };

export class Chain {
  /** The branch, version 1 first. */
  private readonly branch: Version[];
  /** Every checked version off the branch, by hash. */
  private readonly others = new Map<string, Version>();
  /** Withdrawals checked against the version they withdraw, by its hash. */
  private readonly withdrawn = new Map<string, SignedObject>();
  /** Withdrawals of versions not seen, kept to check when they are, and to pass on. */
  private readonly unchecked = new Map<string, SignedObject>();

  private constructor(
    readonly accountId: Uint8Array,
    first: Version,
  ) {
    this.branch = [first];
  }

  /** From version 1, which the account ID must be the hash of. */
  static async start(v1: SignedObject, accountId?: Uint8Array): Promise<Chain> {
    const first = await checkFirst(v1);
    if (accountId && hex(first.hash) !== hex(accountId)) throw new Refused("version 1 is not this account's");
    return new Chain(first.hash, first);
  }

  /** A chain as saved: the branch replayed first, so that the same branch is followed. */
  static async load(s: Saved, accountId?: Uint8Array): Promise<Chain> {
    const [v1, ...rest] = s.branch;
    if (!v1) throw new Refused("no version 1");
    const c = await Chain.start(v1, accountId);
    const change = await c.add([...rest, ...s.others], s.withdrawals);
    if (change.refused.length) throw new Refused(`saved chain: ${change.refused[0].reason}`);
    return c;
  }

  get latest(): Version {
    return this.branch[this.branch.length - 1];
  }

  /** The branch's version with that number, if it reaches it. */
  at(number: bigint): Version | undefined {
    return this.branch[Number(number) - 1];
  }

  /** The branch's versions from `from` on. */
  from(from: bigint): Version[] {
    return this.branch.slice(Math.max(0, Number(from) - 1));
  }

  /** Every withdrawal known, checked or not. */
  withdrawals(): SignedObject[] {
    return [...this.withdrawn.values(), ...this.unchecked.values()];
  }

  isWithdrawn(h: Uint8Array): boolean {
    return this.withdrawn.has(hex(h));
  }

  /**
   * A fork at the branch's tip: two versions or more chaining from it, none
   * withdrawn, so that this device adopted neither (docs/e2e.md, section 3,
   * Forks). A client then takes neither and is joined again; one that took
   * a side has it on its branch, and the other is only a fork.
   */
  undecided(): Version | undefined {
    const tip = hex(this.latest.hash);
    const next = [...this.others.values()].filter((v) => hex(v.body.previous) === tip && !this.withdrawn.has(hex(v.hash)));
    return next.length > 1 ? next[0] : undefined;
  }

  /** Whether `ref` names a version on the branch. */
  onBranch(number: bigint, h: Uint8Array): boolean {
    const v = this.at(number);
    return v !== undefined && hex(v.hash) === hex(h);
  }

  saved(): Saved {
    return {
      branch: this.branch.map((v) => v.object),
      others: [...this.others.values()].sort((a, b) => Number(a.body.number - b.body.number)).map((v) => v.object),
      withdrawals: this.withdrawals(),
    };
  }

  private known(h: string): Version | undefined {
    return this.others.get(h) ?? this.branch.find((v) => hex(v.hash) === h);
  }

  /** Takes versions (any order) and withdrawals, as a relay or a request carries them. */
  async add(versions: SignedObject[], withdrawals: SignedObject[] = []): Promise<Change> {
    const change: Change = { taken: [], dropped: [], forks: [], refused: [] };
    // Oldest first, so that each finds the one it chains from.
    const pending: { obj: SignedObject; number: bigint; previous: string; hash: string }[] = [];
    for (const obj of versions) {
      const body = await open("list", this.accountId, obj);
      if (!body) {
        change.refused.push({ object: obj, reason: "the signature does not check, or the body names another signer" });
        continue;
      }
      pending.push({ obj, number: body.number, previous: hex(body.previous), hash: hex(await hash(obj)) });
    }
    pending.sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : 0));
    for (const p of pending) {
      if (this.known(p.hash)) continue;
      const parent = this.known(p.previous);
      if (!parent || parent.body.number + 1n !== p.number) {
        change.refused.push({ object: p.obj, reason: "does not chain from a version this device has" });
        continue;
      }
      try {
        const v = await checkNext(this.accountId, parent, p.obj);
        this.others.set(p.hash, v);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        change.refused.push({ object: p.obj, reason: e.message });
      }
    }
    for (const w of [...withdrawals, ...this.unchecked.values()]) await this.takeWithdrawal(w, change);
    this.settle(change);
    return change;
  }

  private async takeWithdrawal(obj: SignedObject, change: Change): Promise<void> {
    const body = await open("withdrawal", this.accountId, obj);
    const key = body?.withdrawn ? hex(body.withdrawn.hash) : "";
    if (!body || !key) {
      change.refused.push({ object: obj, reason: "the signature does not check, or the body names another signer" });
      return;
    }
    if (this.withdrawn.has(key)) return;
    const v = this.known(key);
    if (!v) {
      this.unchecked.set(key, obj);
      return;
    }
    this.unchecked.delete(key);
    try {
      await checkWithdrawal(this.accountId, v, obj);
      this.withdrawn.set(key, obj);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      change.refused.push({ object: obj, reason: e.message });
    }
  }

  /** Moves off withdrawn versions, follows the branch as far as one version leads, and finds the forks. */
  private settle(change: Change): void {
    const cut = this.branch.findIndex((v) => this.withdrawn.has(hex(v.hash)));
    if (cut > 0) {
      for (const v of this.branch.splice(cut)) {
        this.others.set(hex(v.hash), v);
        change.dropped.push(v);
      }
    }
    for (;;) {
      const tip = hex(this.latest.hash);
      const next = [...this.others.values()].filter((v) => hex(v.body.previous) === tip && !this.withdrawn.has(hex(v.hash)));
      if (next.length !== 1) break;
      this.others.delete(hex(next[0].hash));
      this.branch.push(next[0]);
      const back = change.dropped.findIndex((d) => hex(d.hash) === hex(next[0].hash));
      if (back >= 0) change.dropped.splice(back, 1);
      else change.taken.push(next[0]);
    }
    // A fork: a version off the branch, not withdrawn, chaining from the
    // branch.
    const onBranch = new Set(this.branch.map((v) => hex(v.hash)));
    for (const v of this.others.values()) {
      if (!this.withdrawn.has(hex(v.hash)) && onBranch.has(hex(v.body.previous))) change.forks.push(v);
    }
  }
}
