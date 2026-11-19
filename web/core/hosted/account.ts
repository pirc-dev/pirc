// A client of a hosted account (docs/e2e.md): the reference the app's Dart
// is held to, and the test client of the hosts. It keeps the account's
// list and signs its changes, adopting a version only once the relay has
// taken it and withdrawing one that lost; renews its pre-key weekly,
// keeping the old private key two days past the new one's publication;
// keeps the label key, made new after a client or read-only key leaves,
// and the label records; joins a device by the code it shows, or approves
// again one listed already; leaves; deletes what it keeps only after a
// version it checked removes it, recording that first; and, in
// sessions.ts, opens what hosts send and seals what it asks. Nothing in it
// is Node's.
import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ErrorCode, type Frame as Frame1 } from "@pirc/protocol";
import {
  DeviceRole,
  DeviceSchema,
  FrameSchema,
  LabelKeyRefSchema,
  LabelSchema,
  LabelsBodySchema,
  LabelsSchema,
  ListVersionBodySchema,
  PreKeyBodySchema,
  VersionRefSchema,
  type AccountSubscription,
  type Attestation,
  type Device,
  type Frame,
  type LabelKeyRef,
  type LabelsBody,
  type PreKeyBody,
  type SignedObject,
  type VersionRef,
} from "@pirc/protocol/v1alpha2";
import { HostedConnection, type HostedState, type OpenSocket } from "@pirc/relay-client/hosted";

import { compare, equal, hex, random, unhex } from "@pirc/crypto/bytes";
import { Chain, type Change, type Saved } from "@pirc/crypto/chain";
import type { Signer } from "@pirc/crypto/ed25519";
import * as hpke from "@pirc/crypto/hpke";
import { ClientJoin, JoinFailed, readCode, type JoiningDevice } from "@pirc/crypto/join";
import * as keys from "@pirc/crypto/keys";
import { checkPreKey, isClient, PRE_KEY_MAX_MS, Refused, overCaps, type Version } from "@pirc/crypto/list";
import { decode, encode, hash, open, sign } from "@pirc/crypto/objects";

import { Sessions } from "./sessions.ts";
import type { Store } from "./store.ts";

const DAY = 24 * 3600_000;
/** A pre-key is renewed weekly, lives 14 days, and its private key is kept two days after the next one is made. */
export const PRE_KEY_RENEW_MS = 7 * DAY;
export const PRE_KEY_KEEP_MS = 2 * DAY;
const PRE_KEY_LIFE_MS = Number(PRE_KEY_MAX_MS);
/** How often a client looks at its pre-key and its label key while connected. */
export const MAINTAIN_MS = 3600_000;
/**
 * How long a client waits for the remover of a client or read-only key to
 * make the new label key before it makes one itself (docs/e2e.md, section
 * 3, Labels): the repair of a remover that stopped half-way.
 */
export const LABEL_REPAIR_MS = 10 * 60_000;
/** A purchase is offered when no live subscription renews and the last ends within this. */
export const OFFER_BEFORE_MS = 7 * DAY;

/**
 * Whether a client offers a purchase (docs/design.md, step 14, stage 5,
 * decision D1): only when no subscription is live, or none of the live
 * ones renews and the last ends within a week; otherwise a second one is
 * a mistake.
 */
export function offerPurchase(subs: readonly AccountSubscription[] | undefined, nowMs: number): boolean {
  // Not known (not logged in yet): nothing offered.
  if (!subs) return false;
  const live = subs.filter((s) => !s.lapsed);
  if (!live.length) return true;
  if (live.some((s) => s.renews)) return false;
  const ends = Math.max(...live.map((s) => (s.ends ? Number(s.ends.seconds) * 1000 : Infinity)));
  return ends - nowMs <= OFFER_BEFORE_MS;
}

export type AccountEvent =
  | { type: "state"; state: HostedState }
  | { type: "list"; latest: bigint }
  // Every addition, shown in every client (docs/e2e.md, section 3).
  | { type: "added"; device: Device; by: Uint8Array }
  | { type: "removed"; device: Device }
  // A version no withdrawal explains: this client keeps its branch.
  | { type: "fork"; number: bigint; signer: Uint8Array }
  // A fork no withdrawal explains, at a version this client adopted
  // neither side of (docs/e2e.md, section 3, Forks): it changes nothing and
  // sends nothing until it is joined again.
  | { type: "undecided"; number: bigint }
  // This client was removed by a version it checked: it keeps nothing.
  // `mutual` when the remover is a device this client was removing at the
  // same time: the account may be in that device's hands. `by` is this
  // client's own key when it left.
  | { type: "removed-me"; by: Uint8Array; mutual: boolean }
  // The version that added this client was withdrawn: its join failed. It
  // stops, deletes nothing, and can be joined again.
  | { type: "join-failed" }
  | { type: "labels" };

export interface ClientOptions {
  origin: string;
  open: OpenSocket;
  store: Store;
  signer: Signer;
  /** This device's own name, for its label. */
  name: string;
  now?: () => number;
  /** v1alpha1's frames, opened, for web/core's Client. */
  onFrame?(f: Frame1): void;
  onEvent?(e: AccountEvent): void;
  log?(m: string): void;
}

/** `pending` until the relay has taken it; then `publishedAt` (missing on keys kept before it was recorded: their madeAt). */
type PreKey = { pair: hpke.X25519Pair; obj: Uint8Array; madeAt: number; expiresAt: number; pending?: true; publishedAt?: number };
const publishedAt = (p: PreKey) => (p.pending ? undefined : (p.publishedAt ?? p.madeAt));
type LabelKey = { number: bigint; hash: Uint8Array; key: Uint8Array };
type PendingLabelKey = LabelKey & { record: Uint8Array };

const S = {
  account: "account",
  chain: "chain",
  preKeys: "pre-keys",
  labelKeys: "label-keys",
  pending: "pending-version",
  // A label key made, with its first record, until the relay takes that
  // record: the relay takes one first record per label key's name, so a
  // second client making one at once drops its own.
  pendingLabelKey: "pending-label-key",
  // Version 1, signed and kept before SignUp is sent, until it is answered.
  signUp: "sign-up",
  // A removal taken, kept before anything is deleted.
  removed: "removed",
} as const;

/** What a removal recorded, for a client opened again before its deletion finished. */
export type Removal = { by: Uint8Array; number: bigint; mutual: boolean };

type SavedBytes = { branch: Uint8Array[]; others: Uint8Array[]; withdrawals: Uint8Array[] };
const toBytes = (s: Saved): SavedBytes => ({ branch: s.branch.map(encode), others: s.others.map(encode), withdrawals: s.withdrawals.map(encode) });
const fromBytes = (s: SavedBytes): Saved => ({ branch: s.branch.map(decode), others: s.others.map(decode), withdrawals: s.withdrawals.map(decode) });

const refOf = (v: Version): VersionRef => create(VersionRefSchema, { number: v.body.number, hash: v.hash });
const sortDevices = (ds: Device[]) => [...ds].sort((a, b) => compare(a.publicKey, b.publicKey));

/** A request whose answer was lost with the connection: its fate is unknown. */
export class Lost extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Lost";
  }
}

/** What a typed code led to; `again` when the device was listed already and only its approval is sent again. */
export type JoinOutcome = { joined: JoiningDevice; again: boolean } | { refused: JoiningDevice };

export class HostedClient {
  readonly conn: HostedConnection;
  readonly sessions: Sessions;
  private readonly now: () => number;
  private preKeys: PreKey[] = [];
  /** Other devices' current pre-keys, checked, by key. */
  private others = new Map<string, PreKeyBody>();
  private labelKeys: LabelKey[] = [];
  private labelRecords: { body: LabelsBody; obj: SignedObject }[] = [];
  private names = new Map<string, string>();
  private requests = new Map<string, { resolve: (f: Frame) => void; reject: (e: Error) => void }>();
  private joins = new Map<string, { steps: Uint8Array[]; wake?: () => void; ended: boolean }>();
  private nextId = 0;
  /** Serialises everything that changes the account. */
  private work: Promise<unknown> = Promise.resolve();
  private maintainTimer: ReturnType<typeof setInterval> | undefined;
  private repairTimer: ReturnType<typeof setTimeout> | undefined;
  /** The store, which takes no writes once this client was removed. */
  private readonly store: Store;
  /** Set when a version this client checked removed it: it does nothing more. */
  private gone = false;
  /** Set when the version that added this client was withdrawn: its join failed. */
  private joinFailed = false;
  /** When this client first saw each removal still lacking its new label key, by version number. */
  private awaitingLabelKey = new Map<bigint, number>();
  /** Set once the list forks at a version this client adopted neither side of. */
  private undecidedAt: bigint | undefined;

  private constructor(
    private readonly o: ClientOptions,
    readonly accountId: Uint8Array,
    private chain: Chain,
  ) {
    this.now = o.now ?? Date.now;
    // Once removed, nothing still queued writes anything back.
    const raw = o.store;
    this.store = {
      get: (k) => raw.get(k),
      set: (k, v) => (this.gone ? Promise.resolve() : raw.set(k, v)),
      delete: (k) => (this.gone ? Promise.resolve() : raw.delete(k)),
      clear: () => (this.gone ? Promise.resolve() : raw.clear()),
    };
    this.sessions = new Sessions(this, this.store, (f) => o.onFrame?.(f), (m) => this.log(m), { now: this.now });
    this.conn = new HostedConnection({
      origin: o.origin,
      accountId,
      signer: o.signer,
      open: o.open,
      onFrame: (f) => this.onFrame(f),
      onState: (s) => this.onState(s),
      onError: (where, e) => this.log(`${where}: ${(e as Error).message}`),
    });
  }

  // --- making and opening ---

  /**
   * Signs up on the hosted relay (docs/e2e.md, section 6): this device
   * makes version 1 with itself in it, and the first label key. Version 1
   * is kept before SignUp goes; a sign-up whose answer never came (the app
   * killed, the connection lost) is finished by calling this again, with a
   * fresh attestation: the same bytes go again, and the relay answers the
   * same, so that one phone makes one account.
   */
  static async signUp(o: ClientOptions, attestation: Attestation, inviteCode = ""): Promise<HostedClient> {
    const now = o.now?.() ?? Date.now();
    let v1: SignedObject | undefined;
    const kept = await o.store.get<{ origin: string; v1: Uint8Array }>(S.signUp);
    if (kept?.origin === o.origin) {
      const obj = decode(kept.v1);
      const body = await open("list", new Uint8Array(0), obj);
      if (body && equal(body.signer, o.signer.publicKey)) v1 = obj;
    }
    if (!v1) {
      const body = create(ListVersionBodySchema, {
        number: 1n,
        devices: [create(DeviceSchema, { role: DeviceRole.CLIENT, publicKey: o.signer.publicKey, addedAt: timestampFromMs(now) })],
        signer: o.signer.publicKey,
      });
      v1 = await sign("list", new Uint8Array(0), o.signer, body);
      // A new account: nothing of another (its pre-keys, counters, a
      // failed join's state) carries over.
      await o.store.clear();
      await o.store.set(S.signUp, { origin: o.origin, v1: encode(v1) });
    }
    const chain = await Chain.start(v1);
    const accountId = chain.accountId;
    await new Promise<void>((resolve, reject) => {
      const conn: HostedConnection = new HostedConnection({
        origin: o.origin,
        accountId: new Uint8Array(0),
        signer: o.signer,
        open: o.open,
        onState: (s) => {
          if (s.kind === "ready") conn.send(create(FrameSchema, { body: { case: "signUp", value: { requestId: "sign-up", version: v1!, attestation, inviteCode } } }));
          if (s.kind === "unsupported") {
            conn.stop();
            reject(new Error(s.reason));
          }
        },
        onFrame: (f) => {
          if (f.body.case === "signedUp" && equal(f.body.value.accountId, accountId)) {
            conn.stop();
            resolve();
          } else if (f.body.case === "error" && f.body.value.requestId === "sign-up") {
            conn.stop();
            reject(new Error(f.body.value.message));
          }
        },
      });
      conn.start();
    });
    await o.store.set(S.chain, toBytes(chain.saved()));
    // The first label key is named by version 1.
    await o.store.set(S.labelKeys, [{ number: 1n, hash: chain.latest.hash, key: random(32) }] satisfies LabelKey[]);
    // The account last: what open() looks for.
    await o.store.set(S.account, { origin: o.origin, accountId });
    await o.store.delete(S.signUp);
    return HostedClient.open(o) as Promise<HostedClient>;
  }

  /** Whether this store holds a sign-up sent and never answered, to finish with signUp. */
  static async signUpPending(store: Store): Promise<boolean> {
    return (await store.get(S.signUp)) !== undefined && (await store.get(S.account)) === undefined;
  }

  /** A removal this store recorded and had not finished deleting; read before open(), which finishes it. */
  static removal(store: Store): Promise<Removal | undefined> {
    return store.get<Removal>(S.removed);
  }

  /** The account this store holds, or undefined; a removal recorded and not finished is finished first. */
  static async open(o: ClientOptions): Promise<HostedClient | undefined> {
    if (await o.store.get(S.removed)) {
      await HostedClient.forget(o.store);
      return undefined;
    }
    const a = await o.store.get<{ origin: string; accountId: Uint8Array }>(S.account);
    const saved = await o.store.get<SavedBytes>(S.chain);
    if (!a || !saved) return undefined;
    const c = new HostedClient(o, a.accountId, await Chain.load(fromBytes(saved), a.accountId));
    c.preKeys = (await o.store.get<PreKey[]>(S.preKeys)) ?? [];
    c.labelKeys = (await o.store.get<LabelKey[]>(S.labelKeys)) ?? [];
    c.undecidedAt = c.chain.undecided()?.body.number;
    // Not on its own list, and no removal recorded: a join that failed.
    c.joinFailed = !c.chain.latest.body.devices.some((d) => equal(d.publicKey, o.signer.publicKey));
    return c;
  }

  /**
   * The second phase of a removal (docs/e2e.md, section 3, Removal): the
   * secrets first, then the account, then everything else. The record of
   * the removal goes last, so that a client stopped half-way finishes on
   * its next open. The app deletes in its own order: push registration,
   * the extension's snapshot, the keychain's items, the account, chats,
   * drafts.
   */
  private static async forget(store: Store): Promise<void> {
    for (const k of [S.preKeys, S.labelKeys, S.pending, S.chain, S.account]) await store.delete(k);
    // Everything else, the record of the removal with it.
    await store.clear();
  }

  /**
   * Makes the store of a client joined by another (docs/e2e.md, section
   * 5): from the approval's account, version and label key, once the chain
   * from the relay checks.
   */
  static async joined(o: ClientOptions, accountId: Uint8Array, chain: Chain, labelKey: { ref: LabelKeyRef; key: Uint8Array } | undefined): Promise<HostedClient> {
    // Nothing of an account this store held before (a failed join's
    // pre-keys and counters) carries over.
    await o.store.clear();
    await o.store.set(S.chain, toBytes(chain.saved()));
    const v = labelKey?.ref.version;
    await o.store.set(S.labelKeys, v && labelKey ? [{ number: v.number, hash: v.hash, key: labelKey.key }] : []);
    await o.store.set(S.account, { origin: o.origin, accountId });
    return HostedClient.open(o) as Promise<HostedClient>;
  }

  start(): void {
    this.conn.start();
  }

  stop(): void {
    this.stopMaintaining();
    this.conn.stop();
  }

  /** The account's subscriptions as the relay said at login (docs/design.md, step 14, stage 5, decision D1); undefined until it has. */
  get subscriptions(): AccountSubscription[] | undefined {
    const s = this.conn.current;
    return s.kind === "ready" ? s.welcome.subscriptions : undefined;
  }

  /**
   * Set while the list forks at a version this client adopted neither
   * side of: it signs nothing and sends no request until it is joined
   * again (docs/e2e.md, section 3, Forks).
   */
  get blocked(): string | undefined {
    if (this.gone) return "this client was removed from the account";
    if (this.joinFailed) return "the version that added this client was withdrawn: its join failed; join it again";
    return this.undecidedAt === undefined ? undefined : `the list forks at version ${this.undecidedAt}, and this client took neither side: join it again from another client`;
  }

  /** Whether the account has room for one more device of `role` (D9): asked before a code is typed. */
  room(role: DeviceRole): boolean {
    const extra = create(DeviceSchema, { role });
    return overCaps([...this.chain.latest.body.devices, extra]) === undefined;
  }

  get publicKey(): Uint8Array {
    return this.o.signer.publicKey;
  }

  get signer(): Signer {
    return this.o.signer;
  }

  get latest(): Version {
    return this.chain.latest;
  }

  get list(): Chain {
    return this.chain;
  }

  /** A device's name as the label record says, if it has one. */
  label(key: Uint8Array): string | undefined {
    return this.names.get(hex(key));
  }

  /** This device's pre-keys, newest first, for opening bundles and wraps. */
  myPreKeys(): hpke.X25519Pair[] {
    return [...this.preKeys].sort((a, b) => b.madeAt - a.madeAt).map((p) => p.pair);
  }

  private log(m: string): void {
    this.o.log?.(m);
  }

  private emit(e: AccountEvent): void {
    try {
      this.o.onEvent?.(e);
    } catch (err) {
      this.log(`event: ${(err as Error).message}`);
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.work.then(() => (this.gone ? Promise.reject(new Error("this client was removed from the account")) : fn()));
    this.work = p.catch(() => {});
    return p;
  }

  // --- the relay ---

  send2(body: MessageInitShape<typeof FrameSchema>["body"]): boolean {
    return this.conn.send(create(FrameSchema, { body }));
  }

  private request(body: (id: string) => MessageInitShape<typeof FrameSchema>["body"]): Promise<Frame> {
    const id = `r${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      if (!this.send2(body(id))) {
        this.requests.delete(id);
        reject(new Lost("not connected to the relay"));
      }
    });
  }

  private onState(s: HostedState): void {
    if (s.kind === "ready") {
      this.startMaintaining();
      // Caught up with the relay's list before the sessions are ready and
      // the state is told, so that nothing is opened or asked under a list
      // the relay has moved past.
      void this.serial(async () => {
        try {
          // The relay's latest by number and hash: a version this client
          // has not seen, or another of a number it has, is fetched and
          // checked; versions that do not chain onto this client's branch
          // send it back to version 1.
          const relayHas = s.welcome.listVersion;
          const mine = this.chain.latest.body.number;
          let change: Change | undefined;
          if (relayHas && relayHas.number > mine) change = await this.fetchVersions(mine + 1n);
          else if (relayHas && !this.chain.onBranch(relayHas.number, relayHas.hash)) change = await this.fetchVersions(relayHas.number);
          if (change?.refused.some((r) => r.reason.startsWith("does not chain"))) await this.fetchVersions(1n);
          // A version signed before a restart, whose fate is unknown: sent
          // again as it was (docs/e2e.md, section 3, Adopting a version).
          const pending = await this.store.get<Uint8Array>(S.pending);
          if (pending && !this.blocked) await this.publish(decode(pending)).catch((e) => this.log(`pending version: ${(e as Error).message}`));
        } finally {
          if (this.conn.current === s) {
            this.sessions.onState(s);
            this.emit({ type: "state", state: s });
          }
        }
      }).catch((e) => this.log(`after login: ${(e as Error).message}`));
      return;
    }
    this.stopMaintaining();
    for (const [, r] of this.requests) r.reject(new Lost("lost the connection to the relay"));
    this.requests.clear();
    this.sessions.onState(s);
    this.emit({ type: "state", state: s });
  }

  private onFrame(f: Frame): void {
    const b = f.body;
    const id = b.value && "requestId" in b.value ? (b.value.requestId as string) : "";
    // The answer to one of this client's requests; Versions without a
    // request ID are the relay's own, to every device.
    const answer = id ? this.requests.get(id) : undefined;
    if (answer && (b.case === "done" || b.case === "error" || b.case === "versions" || b.case === "joinPaired")) {
      this.requests.delete(id);
      return answer.resolve(f);
    }
    switch (b.case) {
      case "versions":
        if (!id) void this.serial(() => this.takeVersions(b.value.versions, b.value.withdrawals)).catch((e) => this.log(`versions: ${(e as Error).message}`));
        return;
      case "preKeys":
        void this.serial(() => this.takePreKeys(b.value.preKeys, b.value.all)).catch((e) => this.log(`pre-keys: ${(e as Error).message}`));
        return;
      case "labelState":
        void this.serial(() => this.takeLabels(b.value.labels, b.value.wraps)).catch((e) => this.log(`labels: ${(e as Error).message}`));
        return;
      case "joinMessage": {
        const j = this.joins.get(b.value.joinId);
        if (!j) return;
        j.steps.push(b.value.step);
        j.wake?.();
        return;
      }
      case "joinEnded": {
        const j = this.joins.get(b.value.joinId);
        if (!j) return;
        j.ended = true;
        j.wake?.();
        return;
      }
      default:
        // In the same order as the list's changes: a frame behind a version
        // is opened under the list that version makes.
        void this.serial(async () => {
          this.sessions.onFrame(f);
          await this.sessions.settled();
        }).catch((e) => this.log(`session frame: ${(e as Error).message}`));
    }
  }

  private async fetchVersions(from: bigint): Promise<Change> {
    const f = await this.request((requestId) => ({ case: "getVersions", value: { requestId, from } }));
    if (f.body.case !== "versions") throw new Error(`fetching versions: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
    return this.takeVersions(f.body.value.versions, f.body.value.withdrawals);
  }

  private async save(): Promise<void> {
    await this.store.set(S.chain, toBytes(this.chain.saved()));
  }

  /** Versions from the relay or a host: checked, followed, and what they changed told. */
  async takeVersions(versions: SignedObject[], withdrawals: SignedObject[]): Promise<Change> {
    const before = this.chain.latest;
    const change = await this.chain.add(versions, withdrawals);
    for (const r of change.refused) this.log(`refused: ${r.reason}`);
    const undecided = this.chain.undecided();
    // Forks too: what it was shown must outlive a restart.
    if (change.taken.length || change.dropped.length || change.forks.length || withdrawals.length) await this.save();
    for (const v of change.forks) if (!undecided) this.emit({ type: "fork", number: v.body.number, signer: v.body.signer });
    // Lifted when a withdrawal explains the fork, as on the next open.
    if (undecided && this.undecidedAt === undefined) this.emit({ type: "undecided", number: undecided.body.number });
    this.undecidedAt = undecided?.body.number;
    if (before !== this.chain.latest) await this.listChanged(before);
    return change;
  }

  private async listChanged(before: Version): Promise<void> {
    const now = this.chain.latest;
    const had = new Map(before.body.devices.map((d) => [hex(d.publicKey), d]));
    const has = new Map(now.body.devices.map((d) => [hex(d.publicKey), d]));
    if (!has.has(hex(this.publicKey))) {
      this.stop();
      // Never on the branch it follows now: the version that added it was
      // withdrawn, and its join failed. Nothing is deleted.
      if (!this.chain.from(1n).some((v) => v.body.devices.some((d) => equal(d.publicKey, this.publicKey)))) {
        this.joinFailed = true;
        this.emit({ type: "join-failed" });
        return;
      }
      // Removed by a version this client checked: recorded, said, then
      // everything deleted.
      const removal: Removal = { by: now.body.signer, number: now.body.number, mutual: await this.wasRemoving(now.body.signer) };
      await this.store.set(S.removed, removal);
      this.gone = true;
      this.emit({ type: "removed-me", ...removal });
      await HostedClient.forget(this.o.store);
      return;
    }
    for (const [k, d] of has) if (!had.has(k)) this.emit({ type: "added", device: d, by: d.addedBy });
    for (const [k, d] of had) {
      if (has.has(k)) continue;
      this.others.delete(k);
      this.emit({ type: "removed", device: d });
    }
    this.emit({ type: "list", latest: now.body.number });
    this.sessions.onList();
    await this.checkLabelKey();
  }

  /** The version on the branch that last added `key`. */
  private addingVersion(key: Uint8Array): Version | undefined {
    const branch = this.chain.from(1n);
    const on = (v: Version) => v.body.devices.some((d) => equal(d.publicKey, key));
    for (let i = branch.length - 1; i > 0; i--) if (on(branch[i]) && !on(branch[i - 1])) return branch[i];
    return undefined;
  }

  /** Whether `signer` is a device this client's unanswered version removes. */
  private async wasRemoving(signer: Uint8Array): Promise<boolean> {
    if (equal(signer, this.publicKey)) return false;
    const pending = await this.store.get<Uint8Array>(S.pending);
    if (!pending) return false;
    const body = await open("list", this.accountId, decode(pending));
    return body !== null && !body.devices.some((d) => equal(d.publicKey, signer));
  }

  // --- changing the list ---

  /**
   * Signs the version after the latest with the devices `change` makes of
   * the latest's, and publishes it. On losing to another client's, it
   * withdraws its own and tries again on top of the winner, while the
   * change still applies (`change` returns null when it does not).
   */
  private change(change: (devices: Device[]) => Device[] | null): Promise<Version | null> {
    return this.serial(async () => {
      for (;;) {
        if (this.blocked) throw new Error(this.blocked);
        // A version whose answer was lost: settled first, so that no other
        // of its number is signed (docs/e2e.md, section 3, Adopting).
        const kept = await this.store.get<Uint8Array>(S.pending);
        if (kept) {
          await this.publish(decode(kept)).catch((e) => {
            if (e instanceof Lost) throw e;
            this.log(`pending version: ${(e as Error).message}`);
          });
          continue;
        }
        const prev = this.chain.latest;
        const devices = change(prev.body.devices.map((d) => create(DeviceSchema, d)));
        if (!devices) return null;
        const over = overCaps(devices);
        if (over) throw new Error(`the account would hold ${over}`);
        const withdrawn = [...prev.body.withdrawn];
        for (const w of this.chain.withdrawals()) {
          const body = await open("withdrawal", this.accountId, w);
          if (body?.withdrawn && !withdrawn.some((h) => equal(h, body.withdrawn!.hash))) withdrawn.push(body.withdrawn.hash);
        }
        const obj = await sign("list", this.accountId, this.o.signer, create(ListVersionBodySchema, {
          number: prev.body.number + 1n,
          previous: prev.hash,
          devices: sortDevices(devices),
          withdrawn,
          signer: this.publicKey,
        }));
        const won = await this.publish(obj);
        if (won) return won;
      }
    });
  }

  /** Publishes a signed version: the version once taken, or null when another got there first (and this one is withdrawn). */
  private async publish(obj: SignedObject): Promise<Version | null> {
    await this.store.set(S.pending, encode(obj));
    const f = await this.request((requestId) => ({ case: "publishVersion", value: { requestId, version: obj } }));
    const h = await hash(obj);
    if (f.body.case === "done") {
      await this.takeVersions([obj], []);
      await this.store.delete(S.pending);
      const v = this.chain.latest;
      if (!equal(v.hash, h)) throw new Error("the relay took the version, but it is not this client's latest");
      return v;
    }
    if (f.body.case === "error" && f.body.value.code === ErrorCode.CONFLICT) {
      // The winner came in Versions before the error.
      const body = fromBinary(ListVersionBodySchema, obj.body);
      const winner = this.chain.at(body.number);
      if (!winner) await this.fetchVersions(body.number);
      const w = this.chain.at(body.number);
      await this.store.delete(S.pending);
      if (!w) throw new Error("lost to a version the relay does not show");
      // Sent again after a lost answer, and taken the first time.
      if (equal(w.hash, h)) return w;
      const withdrawal = await sign("withdrawal", this.accountId, this.o.signer, {
        $typeName: "pirc.v1alpha2.WithdrawalBody",
        withdrawn: create(VersionRefSchema, { number: body.number, hash: h }),
        winner: refOf(w),
        signer: this.publicKey,
      });
      const r = await this.request((requestId) => ({ case: "publishWithdrawal", value: { requestId, withdrawal } }));
      if (r.body.case !== "done") this.log(`withdrawal: ${r.body.case === "error" ? r.body.value.message : r.body.case}`);
      return null;
    }
    await this.store.delete(S.pending);
    throw new Error(`the relay refused the version: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
  }

  /**
   * Removes a device, and its read-only key with a client. Removing a
   * client or a read-only key makes a new label key, which the removed one
   * never had (checkLabelKey); removing a host does not, since a host never
   * had the label key.
   */
  async remove(key: Uint8Array): Promise<Version | null> {
    if (equal(key, this.publicKey)) throw new Error("a client cannot remove the key it signs with: leave instead");
    return this.change((ds) => {
      if (!ds.some((d) => equal(d.publicKey, key))) return null;
      return ds.filter((d) => !equal(d.publicKey, key) && !equal(d.owner, key));
    });
  }

  /**
   * Leaves the account: a version without this client and its read-only
   * key, after which it deletes what it keeps, as on any removal. The
   * clients that stay make the new label key, not this one, which would
   * know it (docs/e2e.md, section 3, Labels). The last client cannot leave:
   * it deletes the account instead.
   */
  async leave(): Promise<Version | null> {
    return this.change((ds) => {
      if (!ds.some((d) => d.role === DeviceRole.CLIENT && !equal(d.publicKey, this.publicKey))) throw new Error("the last client cannot leave the account: delete it instead");
      return ds.filter((d) => !equal(d.publicKey, this.publicKey) && !equal(d.owner, this.publicKey));
    });
  }

  /** Registers this phone's read-only key (docs/e2e.md, section 5): a version of its own, no code needed. */
  async addReadOnly(key: Uint8Array): Promise<Version | null> {
    return this.change((ds) => {
      if (ds.some((d) => equal(d.publicKey, key))) return null;
      return [...ds, create(DeviceSchema, { role: DeviceRole.READ_ONLY, publicKey: key, addedBy: this.publicKey, addedAt: timestampFromMs(this.now()), owner: this.publicKey })];
    });
  }

  // --- pre-keys ---

  private async takePreKeys(objs: SignedObject[], all: boolean): Promise<void> {
    if (all) this.others.clear();
    const fresh: PreKeyBody[] = [];
    for (const obj of objs) {
      try {
        const body = await checkPreKey(this.accountId, this.chain.latest.body, obj, BigInt(this.now()));
        if (equal(body.signer, this.publicKey)) continue;
        const had = this.others.get(hex(body.signer));
        if (had && equal(had.preKey, body.preKey)) continue;
        this.others.set(hex(body.signer), body);
        fresh.push(body);
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
      }
    }
    if (all) await this.ensurePreKey();
    // A device with a new pre-key gets the label key wrapped again
    // (docs/e2e.md, section 3).
    if (fresh.length) await this.wrapLabelKey(fresh);
  }

  /**
   * A pre-key the relay has taken, made new once the newest published one
   * is a week old (docs/e2e.md, section 2). One not yet taken is sent
   * again, the same key, until it is. An older private key is deleted two
   * days after the next one's publication, whatever the hosts have done.
   */
  private async ensurePreKey(): Promise<void> {
    if (this.blocked) return;
    const now = this.now();
    let newest = this.newestPreKey();
    // One never taken and within a day of its end is dropped for a new
    // one: sent again, it would be refused as expired for good.
    if (newest?.pending && now >= newest.expiresAt - DAY) {
      const drop = newest;
      this.preKeys = this.preKeys.filter((p) => p !== drop);
      newest = this.newestPreKey();
      if (newest?.pending) newest = undefined;
    }
    const at = newest && publishedAt(newest);
    if (!newest || (at !== undefined && now - newest.madeAt >= PRE_KEY_RENEW_MS)) {
      const pair = await hpke.x25519Generate();
      const obj = await sign("pre-key", this.accountId, this.o.signer, {
        $typeName: "pirc.v1alpha2.PreKeyBody",
        signer: this.publicKey,
        preKey: pair.publicKey,
        madeAt: timestampFromMs(now),
        expiresAt: timestampFromMs(now + PRE_KEY_LIFE_MS),
      });
      newest = { pair, obj: encode(obj), madeAt: now, expiresAt: now + PRE_KEY_LIFE_MS, pending: true };
      this.preKeys.push(newest);
      await this.store.set(S.preKeys, this.preKeys);
    }
    if (newest.pending) {
      const obj = decode(newest.obj);
      const f = await this.request((requestId) => ({ case: "publishPreKey", value: { requestId, preKey: obj } }));
      if (f.body.case !== "done") throw new Error(`pre-key: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
      delete newest.pending;
      newest.publishedAt = this.now();
      await this.store.set(S.preKeys, this.preKeys);
      // Its own wrap, so that the label key reaches this device's other
      // installs and survives here the store it was made in.
      await this.wrapLabelKey([fromBinary(PreKeyBodySchema, obj.body)]);
    }
    await this.prunePreKeys();
  }

  private newestPreKey(): PreKey | undefined {
    return this.preKeys.reduce<PreKey | undefined>((a, p) => (!a || p.madeAt > a.madeAt ? p : a), undefined);
  }

  /** Deletes each private key whose next one was published more than two days ago. */
  private async prunePreKeys(): Promise<void> {
    const now = this.now();
    const byAge = [...this.preKeys].sort((a, b) => a.madeAt - b.madeAt);
    const keep = byAge.filter((_, i) => {
      const next = byAge[i + 1];
      const nextAt = next && publishedAt(next);
      return nextAt === undefined || now - nextAt < PRE_KEY_KEEP_MS;
    });
    if (keep.length === this.preKeys.length) return;
    this.preKeys = keep;
    await this.store.set(S.preKeys, this.preKeys);
  }

  /** What the client does on its own while connected: its pre-key, and a label key a removal still lacks. */
  maintain(): Promise<void> {
    return this.serial(async () => {
      await this.ensurePreKey();
      await this.checkLabelKey();
    });
  }

  private startMaintaining(): void {
    this.stopMaintaining();
    this.maintainTimer = setInterval(() => void this.maintain().catch((e) => this.log(`maintenance: ${(e as Error).message}`)), MAINTAIN_MS);
  }

  private stopMaintaining(): void {
    clearInterval(this.maintainTimer);
    clearTimeout(this.repairTimer);
    this.maintainTimer = this.repairTimer = undefined;
  }

  // --- labels ---

  private currentLabelKey(): LabelKey | undefined {
    return this.labelKeys.reduce<LabelKey | undefined>((a, k) => (!a || k.number > a.number || (k.number === a.number && compare(k.hash, a.hash) > 0) ? k : a), undefined);
  }

  private async takeLabels(records: SignedObject[], wraps: SignedObject[]): Promise<void> {
    for (const w of wraps) {
      const body = await open("label-key", this.accountId, w);
      if (!body?.labelKey?.version || !equal(body.recipient, this.publicKey)) continue;
      // Taken only from a client on the list as this device has it.
      if (this.chain.latest.body.devices.find((d) => equal(d.publicKey, body.signer))?.role !== DeviceRole.CLIENT) continue;
      const v = body.labelKey.version;
      if (this.labelKeys.some((k) => k.number === v.number && equal(k.hash, v.hash))) continue;
      for (const pk of this.myPreKeys()) {
        const key = await keys.unwrapLabelKey(pk, this.accountId, body.labelKey, this.publicKey, body.wrap);
        if (key) {
          this.labelKeys.push({ number: v.number, hash: v.hash, key });
          await this.store.set(S.labelKeys, this.labelKeys);
          break;
        }
      }
    }
    const taken: { body: LabelsBody; obj: SignedObject }[] = [];
    for (const r of records) {
      const body = await open("labels", this.accountId, r);
      if (!body || this.chain.latest.body.devices.find((d) => equal(d.publicKey, body.signer))?.role !== DeviceRole.CLIENT) continue;
      taken.push({ body, obj: r });
    }
    if (taken.length) this.labelRecords = taken;
    await this.readLabels();
    await this.checkLabelKey();
  }

  /**
   * After a version that removes a client or a read-only key, the label key
   * is made new and named by it (docs/e2e.md, section 3, Labels). The
   * client that removed it makes it; when that client left by that very
   * version, or has not made it within LABEL_REPAIR_MS, the first client
   * that notices makes it. Two made at once are settled by hash.
   */
  private async checkLabelKey(): Promise<void> {
    if (this.blocked) return;
    const kept = await this.store.get<PendingLabelKey>(S.pendingLabelKey);
    if (kept) return this.finishLabelKey(kept);
    const r = this.lastClientRemoval();
    if (!r) return;
    const n = r.body.number;
    const has = this.labelKeys.some((k) => k.number >= n) || this.labelRecords.some((x) => (x.body.labelKey?.version?.number ?? 0n) >= n);
    if (has) {
      this.awaitingLabelKey.delete(n);
      return;
    }
    const now = this.now();
    const since = this.awaitingLabelKey.get(n) ?? now;
    this.awaitingLabelKey.set(n, since);
    const remover = r.body.signer;
    if (equal(remover, this.publicKey) || !isClient(this.chain.latest.body, remover) || now - since >= LABEL_REPAIR_MS) {
      await this.newLabelKey(r);
      this.awaitingLabelKey.delete(n);
    } else if (since === now) {
      // Looked at again when the wait is over, not only at the next tick.
      clearTimeout(this.repairTimer);
      this.repairTimer = setTimeout(() => void this.maintain().catch((e) => this.log(`label key repair: ${(e as Error).message}`)), LABEL_REPAIR_MS + 1000);
    }
  }

  /** The latest version on the branch that removed a client or a read-only key. */
  private lastClientRemoval(): Version | undefined {
    const branch = this.chain.from(1n);
    for (let i = branch.length - 1; i > 0; i--) {
      const has = new Set(branch[i].body.devices.map((d) => hex(d.publicKey)));
      if (branch[i - 1].body.devices.some((d) => d.role !== DeviceRole.HOST && !has.has(hex(d.publicKey)))) return branch[i];
    }
    return undefined;
  }

  /** The latest record: by its label key's version, then counter, then hash (docs/e2e.md, section 3). */
  private async latestRecord(): Promise<{ body: LabelsBody; hash: Uint8Array } | undefined> {
    let best: { body: LabelsBody; hash: Uint8Array } | undefined;
    for (const r of this.labelRecords) {
      const h = await hash(r.obj);
      const b = r.body;
      const n = b.labelKey?.version?.number ?? 0n;
      const bn = best?.body.labelKey?.version?.number ?? -1n;
      if (!best || n > bn || (n === bn && (b.counter > best.body.counter || (b.counter === best.body.counter && compare(h, best.hash) > 0)))) best = { body: b, hash: h };
    }
    return best;
  }

  private async readLabels(): Promise<void> {
    const r = await this.latestRecord();
    const v = r?.body.labelKey?.version;
    const k = v && this.labelKeys.find((x) => x.number === v.number && equal(x.hash, v.hash));
    if (!r || !k) return;
    const labels = await keys.openLabels(k.key, this.accountId, r.body.labelKey!, r.body.counter, r.body.sealed);
    if (!labels) return this.log("a label record that does not open");
    this.names = new Map(labels.labels.map((l) => [hex(l.publicKey), l.label]));
    this.emit({ type: "labels" });
  }

  /** Writes a new label record, under the current label key, with `set` applied to the names. */
  private async writeLabels(set: (names: Map<string, string>) => void): Promise<void> {
    if (this.blocked) throw new Error(this.blocked);
    const k = this.currentLabelKey();
    if (!k) throw new Error("this client has no label key yet");
    const latest = await this.latestRecord();
    const sameKey = latest?.body.labelKey?.version?.number === k.number && equal(latest.body.labelKey.version.hash, k.hash);
    const counter = sameKey ? latest!.body.counter + 1n : 1n;
    const names = new Map(this.names);
    set(names);
    const obj = await this.labelRecord(k, counter, names);
    const f = await this.request((requestId) => ({ case: "publishLabels", value: { requestId, labels: obj } }));
    if (f.body.case !== "done") throw new Error(`labels: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
    const on = new Set(this.chain.latest.body.devices.map((d) => hex(d.publicKey)));
    this.names = new Map([...names].filter(([key]) => on.has(key)));
    this.emit({ type: "labels" });
  }

  /** A label record under `k`: the names of the devices on the list, sealed, signed. */
  private async labelRecord(k: LabelKey, counter: bigint, names: Map<string, string>): Promise<SignedObject> {
    const ref = create(LabelKeyRefSchema, { version: create(VersionRefSchema, { number: k.number, hash: k.hash }) });
    const on = new Set(this.chain.latest.body.devices.map((d) => hex(d.publicKey)));
    const labels = create(LabelsSchema, { labels: [...names].filter(([key]) => on.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, label]) => create(LabelSchema, { publicKey: unhex(key), label })) });
    return sign("labels", this.accountId, this.o.signer, {
      $typeName: "pirc.v1alpha2.LabelsBody",
      labelKey: ref,
      counter,
      listVersion: refOf(this.chain.latest),
      sealed: await keys.sealLabels(k.key, this.accountId, ref, counter, labels),
      signer: this.publicKey,
    });
  }

  /** Names a device. */
  rename(key: Uint8Array, name: string): Promise<void> {
    return this.serial(() => this.writeLabels((n) => n.set(hex(key), name)));
  }

  /** The label key, wrapped for each of these pre-keys, each wrap signed. */
  private async wrapLabelKey(preKeys: PreKeyBody[]): Promise<void> {
    if (this.blocked) return;
    const k = this.currentLabelKey();
    if (!k) return;
    const ref = create(LabelKeyRefSchema, { version: create(VersionRefSchema, { number: k.number, hash: k.hash }) });
    const wraps: SignedObject[] = [];
    for (const p of preKeys) {
      const role = this.chain.latest.body.devices.find((d) => equal(d.publicKey, p.signer))?.role;
      if (role !== DeviceRole.CLIENT && role !== DeviceRole.READ_ONLY) continue;
      wraps.push(await sign("label-key", this.accountId, this.o.signer, {
        $typeName: "pirc.v1alpha2.LabelKeyWrapBody",
        labelKey: ref,
        recipient: p.signer,
        preKey: p.preKey,
        wrap: await keys.wrapLabelKey(p.preKey, this.accountId, ref, p.signer, k.key),
        signer: this.publicKey,
      }));
    }
    if (!wraps.length) return;
    const f = await this.request((requestId) => ({ case: "publishLabelKeyWraps", value: { requestId, wraps } }));
    if (f.body.case !== "done") this.log(`wraps: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
  }

  /**
   * After a removal: a new label key, named by that version, and its first
   * record, with the current names, kept before they go. Taken by the
   * relay, the key is this client's and is wrapped for every current
   * pre-key; refused, another client's first record under that name came
   * first, and this one is dropped for the wrap of that one.
   */
  private async newLabelKey(v: Version): Promise<void> {
    this.log(`a new label key, for version ${v.body.number}`);
    const k: LabelKey = { number: v.body.number, hash: v.hash, key: random(32) };
    const record = await this.labelRecord(k, 1n, new Map(this.names));
    const kept: PendingLabelKey = { ...k, record: encode(record) };
    await this.store.set(S.pendingLabelKey, kept);
    await this.finishLabelKey(kept);
  }

  /** Sends a made label key's first record, the same bytes each time, and keeps or drops the key by the answer. */
  private async finishLabelKey(kept: PendingLabelKey): Promise<void> {
    const record = decode(kept.record);
    const f = await this.request((requestId) => ({ case: "publishLabels", value: { requestId, labels: record } }));
    if (f.body.case === "error" && f.body.value.code === ErrorCode.CONFLICT) {
      this.log(`label key for version ${kept.number} not taken: another came first`);
      await this.store.delete(S.pendingLabelKey);
      return;
    }
    if (f.body.case !== "done") throw new Error(`labels: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
    this.labelKeys.push({ number: kept.number, hash: kept.hash, key: kept.key });
    await this.store.set(S.labelKeys, this.labelKeys);
    await this.store.delete(S.pendingLabelKey);
    this.labelRecords = [...this.labelRecords, { body: fromBinary(LabelsBodySchema, record.body), obj: record }];
    await this.readLabels();
    const newest = this.newestPreKey();
    const mine = newest && !newest.pending ? [fromBinary(PreKeyBodySchema, decode(newest.obj).body)] : [];
    await this.wrapLabelKey([...mine, ...this.others.values()]);
  }

  /** On a new account, the first record: this device's own name. */
  async nameSelf(): Promise<void> {
    if (!this.names.has(hex(this.publicKey))) await this.serial(() => this.writeLabels((n) => n.set(hex(this.publicKey), this.o.name)));
  }

  // --- joining a device ---

  private async nextStep(joinId: string, timeoutMs: number): Promise<Uint8Array> {
    const j = this.joins.get(joinId)!;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const s = j.steps.shift();
      if (s) return s;
      if (j.ended) throw new JoinFailed("the device ended the join");
      if (this.now() > deadline) throw new JoinFailed("the device did not answer in time");
      await new Promise<void>((r) => {
        j.wake = r;
        setTimeout(r, 1000);
      });
      j.wake = undefined;
    }
  }

  /**
   * Joins the device that shows `typed` (docs/e2e.md, section 5): CPace
   * with it through the relay, then `decide` asks the person, by role, in
   * words, before the name; on yes, a version with it, and the approval.
   * Every failure is reported: it may be the relay guessing the code.
   *
   * A device on the list already, with the same key and role, is one whose
   * join was cut off after its version was taken (docs/design.md, step 14,
   * stage 5, decision D7): it is approved again, with the version that
   * added it and that version's signer as the approver, and no new
   * version. `decide` is told so.
   */
  async join(typed: string, decide: (d: JoiningDevice, again: boolean) => Promise<boolean>): Promise<JoinOutcome> {
    if (this.blocked) throw new JoinFailed(this.blocked);
    const code = readCode(typed);
    if (!code) throw new JoinFailed("a code is nine characters, such as K7QM-2XRP9");
    const paired = await this.request((requestId) => ({ case: "joinLookup", value: { requestId, lookup: code.lookup } }));
    if (paired.body.case !== "joinPaired") throw new JoinFailed(paired.body.case === "error" ? paired.body.value.message : "the relay did not pair the join");
    const joinId = paired.body.value.joinId;
    this.joins.set(joinId, { steps: [], ended: false });
    const send = (step: Uint8Array) => this.send2({ case: "joinMessage", value: { joinId, step } });
    try {
      const { join, answer } = await ClientJoin.answer(this.conn.origin, code, await this.nextStep(joinId, 60_000));
      send(answer);
      const device = await join.onConfirm(await this.nextStep(joinId, 60_000));
      const refuse = async (why: string) => {
        send(await join.result({ case: "refused", value: {} }));
        throw new JoinFailed(why);
      };
      const listed = this.chain.latest.body.devices.find((d) => equal(d.publicKey, device.publicKey));
      if (listed && listed.role !== device.role) await refuse("that key is on the list as another kind of device");
      if (!listed && !this.room(device.role)) await refuse(device.role === DeviceRole.HOST ? "this account has 256 computers, the most it can have" : "this account has 32 phones and browsers, the most it can have");
      if (!(await decide(device, listed !== undefined))) {
        send(await join.result({ case: "refused", value: {} }));
        return { refused: device };
      }
      let v: Version | null;
      if (listed) {
        v = this.addingVersion(device.publicKey) ?? null;
        if (!v) throw new JoinFailed("the version that added that device is not on this client's list");
      } else {
        v = await this.change((ds) => {
          if (ds.some((d) => equal(d.publicKey, device.publicKey))) return null;
          return [...ds, create(DeviceSchema, { role: device.role, publicKey: device.publicKey, addedBy: this.publicKey, addedAt: timestampFromMs(this.now()) })];
        });
        if (!v) throw new JoinFailed("that device is on the list already");
      }
      if (this.names.get(hex(device.publicKey)) !== device.name) await this.serial(() => this.writeLabels((n) => n.set(hex(device.publicKey), device.name)));
      const k = this.currentLabelKey();
      const latest = await this.latestRecord();
      const approver = v.body.signer;
      send(await join.result({
        case: "approval",
        value: {
          $typeName: "pirc.v1alpha2.JoinApproval",
          accountId: this.accountId,
          version: v.object,
          latest: refOf(this.chain.latest),
          approver,
          approverName: this.names.get(hex(approver)) ?? (equal(approver, this.publicKey) ? this.o.name : "another device of this account"),
          ...(device.role === DeviceRole.CLIENT && k
            ? { labelKeyRef: create(LabelKeyRefSchema, { version: create(VersionRefSchema, { number: k.number, hash: k.hash }) }), labelKey: k.key, labelCounter: latest?.body.counter ?? 0n }
            : { labelKey: new Uint8Array(0), labelCounter: 0n }),
        },
      }));
      return { joined: device, again: listed !== undefined };
    } finally {
      this.joins.delete(joinId);
      this.send2({ case: "joinEnded", value: { joinId } });
    }
  }
}
