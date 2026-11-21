// A device's view of its account's list (docs/e2e.md, section 3): the
// branch it follows from version 1, the versions it has seen off that
// branch, and the withdrawals. Versions are taken only when they check
// against the version they chain from, and the branch only grows: it
// follows a version when it is the only one chaining from its tip, and
// nothing, a withdrawal least of all, takes one off it. Two versions of
// one number are a fork, which the caller acts on (a host stops, a client
// keeps its branch and says so), unless the one off the branch was
// withdrawn by its own signer: the device is then on the side that won.
//
// The same for hosts and clients, so that both decide alike; persisted by
// the caller as `saved()`, and loaded again with `Chain.load`.

import { fromBinary } from "@bufbuild/protobuf";
import { WithdrawalBodySchema, type SignedObject } from "@pirc/protocol/v1alpha2";
import { equal, hex } from "./bytes.ts";
import { checkFirst, checkNext, checkWithdrawal, isClient, Refused, type Version } from "./list.ts";
import { hash, open } from "./objects.ts";

/** What a change did: versions taken onto the branch, and the forks the device holds (Chain.forks). A branch only grows. */
export type Change = {
  taken: Version[];
  forks: Version[];
  /** Objects that did not check, and why. */
  refused: { object: SignedObject; reason: string }[];
};

export type Saved = { branch: SignedObject[]; others: SignedObject[]; withdrawals: SignedObject[] };

/** How many withdrawals of versions not seen a chain keeps, in all and of one signer. */
export const MAX_UNCHECKED = 64;
export const MAX_UNCHECKED_PER_SIGNER = 8;

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
    // The branch alone first: with the others beside it, a fork this
    // client had taken a side of would read as undecided again.
    const branch = await c.add(rest);
    const others = await c.add(s.others, s.withdrawals);
    const refused = [...branch.refused, ...others.refused];
    if (refused.length) throw new Refused(`saved chain: ${refused[0].reason}`);
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
    // In hash order, then the signer's, so that the same withdrawals save
    // the same bytes in any order.
    const order = (w: SignedObject) => {
      const b = fromBinary(WithdrawalBodySchema, w.body);
      return `${hex(b.withdrawn?.hash ?? new Uint8Array(0))}/${hex(b.signer)}`;
    };
    return [...this.withdrawn.values(), ...this.unchecked.values()].sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
  }

  isWithdrawn(h: Uint8Array): boolean {
    return this.withdrawn.has(hex(h));
  }

  /**
   * A fork at the branch's tip: two versions or more chaining from it,
   * withdrawn or not, so that this device adopted neither (docs/e2e.md,
   * section 3, Forks). A client then takes neither and is joined again; one that took
   * a side has it on its branch, and the other is only a fork.
   */
  undecided(): Version | undefined {
    const tip = hex(this.latest.hash);
    const next = [...this.others.values()].filter((v) => hex(v.body.previous) === tip);
    return next.length > 1 ? next[0] : undefined;
  }

  /**
   * The forks this device holds: each version off the branch that chains
   * from it, unless its own signer withdrew it, which says the device is on
   * the side that won an honest race. A withdrawn version on the branch
   * explains nothing: the device is on the side that lost, and the fork
   * stands, whatever else is withdrawn beside it.
   */
  forks(): Version[] {
    const onBranch = new Set(this.branch.map((v) => hex(v.hash)));
    return [...this.others.values()].filter((v) => {
      if (!onBranch.has(hex(v.body.previous))) return false;
      const mine = this.at(v.body.number);
      return !this.withdrawn.has(hex(v.hash)) || (mine !== undefined && this.withdrawn.has(hex(mine.hash)));
    });
  }

  /** Whether `ref` names a version on the branch. */
  onBranch(number: bigint, h: Uint8Array): boolean {
    const v = this.at(number);
    return v !== undefined && hex(v.hash) === hex(h);
  }

  saved(): Saved {
    return {
      branch: this.branch.map((v) => v.object),
      others: [...this.others.values()]
        .sort((a, b) => (a.body.number < b.body.number ? -1 : a.body.number > b.body.number ? 1 : hex(a.hash) < hex(b.hash) ? -1 : hex(a.hash) > hex(b.hash) ? 1 : 0))
        .map((v) => v.object),
      withdrawals: this.withdrawals(),
    };
  }

  private known(h: string): Version | undefined {
    return this.others.get(h) ?? this.branch.find((v) => hex(v.hash) === h);
  }

  /** Takes versions (any order) and withdrawals, as a relay or a request carries them. */
  async add(versions: SignedObject[], withdrawals: SignedObject[] = []): Promise<Change> {
    const change: Change = { taken: [], forks: [], refused: [] };
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
    // By hash within a number, so that every language takes them in one order.
    pending.sort((a, b) => (a.number < b.number ? -1 : a.number > b.number ? 1 : a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
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

  /**
   * A withdrawal counts once its version and the winner it names are both
   * here, and only if the winner is what docs/e2e.md (section 3, Adopting a
   * version) says a withdrawal names: another device's version of the same
   * number, chaining from the same version. A device removed since has no
   * such version to name, so it cannot take back an old one of its own and
   * send every device back to a list it is on. It depends on the versions
   * alone, never on this device's branch, so that the same objects give
   * the same withdrawals in any order, and on a load.
   */
  private async takeWithdrawal(obj: SignedObject, change: Change): Promise<void> {
    const body = await open("withdrawal", this.accountId, obj);
    const key = body?.withdrawn ? hex(body.withdrawn.hash) : "";
    if (!body || !key) {
      change.refused.push({ object: obj, reason: "the signature does not check, or the body names another signer" });
      return;
    }
    // Kept until it can be checked by hash, signer and winner: another
    // key naming the same hash first, or the signer naming another winner,
    // does not take its place.
    const slot = `${key}/${hex(body.signer)}/${hex(body.winner?.hash ?? new Uint8Array(0))}`;
    if (this.withdrawn.has(key)) {
      this.unchecked.delete(slot);
      return;
    }
    const v = this.known(key);
    const winner = body.winner ? this.known(hex(body.winner.hash)) : undefined;
    if (!v || !winner) {
      // Kept to check when both come, and to pass on: only one signed by a
      // key some version has as a client, and only so many, so that a
      // relay cannot grow what every later version must carry.
      if (![...this.branch, ...this.others.values()].some((x) => isClient(x.body, body.signer))) {
        change.refused.push({ object: obj, reason: "a withdrawal of a version not seen, by a key no version has as a client" });
        return;
      }
      if (!this.unchecked.has(slot)) {
        // A few per signer, the oldest let go first, so that one key, a
        // removed device's, cannot push out the others'.
        const mine = [...this.unchecked].filter(([, w]) => equal(fromBinary(WithdrawalBodySchema, w.body).signer, body.signer)).map(([k]) => k);
        if (mine.length >= MAX_UNCHECKED_PER_SIGNER) this.unchecked.delete(mine[0]);
        if (this.unchecked.size >= MAX_UNCHECKED) this.unchecked.delete(this.unchecked.keys().next().value!);
      }
      this.unchecked.set(slot, obj);
      return;
    }
    this.unchecked.delete(slot);
    try {
      await checkWithdrawal(this.accountId, v, obj);
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      change.refused.push({ object: obj, reason: e.message });
      return;
    }
    if (winner.body.number !== v.body.number || !equal(winner.body.previous, v.body.previous) || equal(winner.body.signer, v.body.signer)) {
      change.refused.push({ object: obj, reason: "the winner it names is not another device's version beside it" });
      return;
    }
    this.withdrawn.set(key, obj);
  }

  /** Follows the branch as far as one version leads, and finds the forks. */
  //
  // A device never leaves the branch it follows, whatever a withdrawal
  // says (docs/e2e.md, section 3, Forks): with an honest relay no device
  // but its signer ever holds a version that lost, so none needs to, and a
  // withdrawal signed by a device removed since must not be able to move
  // it back to a list that device is on. Nor does a withdrawal choose for
  // it at a fork it has not taken a side of: it takes neither.
  private settle(change: Change): void {
    for (;;) {
      const tip = hex(this.latest.hash);
      const next = [...this.others.values()].filter((v) => hex(v.body.previous) === tip);
      if (next.length !== 1) break;
      this.others.delete(hex(next[0].hash));
      this.branch.push(next[0]);
      change.taken.push(next[0]);
    }
    change.forks.push(...this.forks());
  }
}
