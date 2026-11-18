// A client of a hosted account (docs/e2e.md): the reference the app's Dart
// is held to, and the test client of the hosts. It keeps the account's
// list and signs its changes, adopting a version only once the relay has
// taken it and withdrawing one that lost; renews its pre-key weekly; keeps
// the label key and the label records; joins a device by the code it
// shows; and, in sessions.ts, opens what hosts send and seals what it
// asks. Nothing in it is Node's.
import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ErrorCode, type Frame as Frame1 } from "@pirc/protocol";
import {
  DeviceRole,
  DeviceSchema,
  FrameSchema,
  LabelKeyRefSchema,
  LabelSchema,
  LabelsSchema,
  ListVersionBodySchema,
  PreKeyBodySchema,
  VersionRefSchema,
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
import { checkPreKey, PRE_KEY_MAX_MS, Refused, type Version } from "@pirc/crypto/list";
import { decode, encode, hash, open, sign } from "@pirc/crypto/objects";

import { Sessions } from "./sessions.ts";
import type { Store } from "./store.ts";

const DAY = 24 * 3600_000;
/** A pre-key is renewed weekly, lives 14 days, and its private key is kept two days after the next one is made. */
export const PRE_KEY_RENEW_MS = 7 * DAY;
export const PRE_KEY_KEEP_MS = 2 * DAY;
const PRE_KEY_LIFE_MS = Number(PRE_KEY_MAX_MS);

export type AccountEvent =
  | { type: "state"; state: HostedState }
  | { type: "list"; latest: bigint }
  // Every addition, shown in every client (docs/e2e.md, section 3).
  | { type: "added"; device: Device; by: Uint8Array }
  | { type: "removed"; device: Device }
  // A version no withdrawal explains: this client keeps its branch.
  | { type: "fork"; number: bigint; signer: Uint8Array }
  // This client was removed by a version it checked: it keeps nothing.
  | { type: "removed-me"; by: Uint8Array }
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

type PreKey = { pair: hpke.X25519Pair; obj: Uint8Array; madeAt: number; expiresAt: number };
type LabelKey = { number: bigint; hash: Uint8Array; key: Uint8Array };

const S = {
  account: "account",
  chain: "chain",
  preKeys: "pre-keys",
  labelKeys: "label-keys",
  pending: "pending-version",
} as const;

type SavedBytes = { branch: Uint8Array[]; others: Uint8Array[]; withdrawals: Uint8Array[] };
const toBytes = (s: Saved): SavedBytes => ({ branch: s.branch.map(encode), others: s.others.map(encode), withdrawals: s.withdrawals.map(encode) });
const fromBytes = (s: SavedBytes): Saved => ({ branch: s.branch.map(decode), others: s.others.map(decode), withdrawals: s.withdrawals.map(decode) });

const refOf = (v: Version): VersionRef => create(VersionRefSchema, { number: v.body.number, hash: v.hash });
const sortDevices = (ds: Device[]) => [...ds].sort((a, b) => compare(a.publicKey, b.publicKey));

/** What a typed code led to. */
export type JoinOutcome = { joined: JoiningDevice } | { refused: JoiningDevice };

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
  private requests = new Map<string, (f: Frame) => void>();
  private joins = new Map<string, { steps: Uint8Array[]; wake?: () => void; ended: boolean }>();
  private nextId = 0;
  /** Serialises everything that changes the account. */
  private work: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly o: ClientOptions,
    readonly accountId: Uint8Array,
    private chain: Chain,
  ) {
    this.now = o.now ?? Date.now;
    this.sessions = new Sessions(this, o.store, (f) => o.onFrame?.(f), (m) => this.log(m));
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
   * makes version 1 with itself in it, and the first label key.
   */
  static async signUp(o: ClientOptions, attestation: Attestation, inviteCode = ""): Promise<HostedClient> {
    const now = o.now?.() ?? Date.now();
    const body = create(ListVersionBodySchema, {
      number: 1n,
      devices: [create(DeviceSchema, { role: DeviceRole.CLIENT, publicKey: o.signer.publicKey, addedAt: timestampFromMs(now) })],
      signer: o.signer.publicKey,
    });
    const v1 = await sign("list", new Uint8Array(0), o.signer, body);
    const chain = await Chain.start(v1);
    const accountId = chain.accountId;
    await new Promise<void>((resolve, reject) => {
      const conn: HostedConnection = new HostedConnection({
        origin: o.origin,
        accountId: new Uint8Array(0),
        signer: o.signer,
        open: o.open,
        onState: (s) => {
          if (s.kind === "ready") conn.send(create(FrameSchema, { body: { case: "signUp", value: { requestId: "sign-up", version: v1, attestation, inviteCode } } }));
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
    await o.store.set(S.account, { origin: o.origin, accountId });
    await o.store.set(S.chain, toBytes(chain.saved()));
    // The first label key is named by version 1.
    await o.store.set(S.labelKeys, [{ number: 1n, hash: chain.latest.hash, key: random(32) }] satisfies LabelKey[]);
    return HostedClient.open(o) as Promise<HostedClient>;
  }

  /** The account this store holds, or undefined. */
  static async open(o: ClientOptions): Promise<HostedClient | undefined> {
    const a = await o.store.get<{ origin: string; accountId: Uint8Array }>(S.account);
    const saved = await o.store.get<SavedBytes>(S.chain);
    if (!a || !saved) return undefined;
    const c = new HostedClient(o, a.accountId, await Chain.load(fromBytes(saved), a.accountId));
    c.preKeys = (await o.store.get<PreKey[]>(S.preKeys)) ?? [];
    c.labelKeys = (await o.store.get<LabelKey[]>(S.labelKeys)) ?? [];
    return c;
  }

  /**
   * Makes the store of a client joined by another (docs/e2e.md, section
   * 5): from the approval's account, version and label key, once the chain
   * from the relay checks.
   */
  static async joined(o: ClientOptions, accountId: Uint8Array, chain: Chain, labelKey: { ref: LabelKeyRef; key: Uint8Array } | undefined): Promise<HostedClient> {
    await o.store.set(S.account, { origin: o.origin, accountId });
    await o.store.set(S.chain, toBytes(chain.saved()));
    const v = labelKey?.ref.version;
    await o.store.set(S.labelKeys, v && labelKey ? [{ number: v.number, hash: v.hash, key: labelKey.key }] : []);
    return HostedClient.open(o) as Promise<HostedClient>;
  }

  start(): void {
    this.conn.start();
  }

  stop(): void {
    this.conn.stop();
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
    const p = this.work.then(fn);
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
      this.requests.set(id, resolve);
      if (!this.send2(body(id))) {
        this.requests.delete(id);
        reject(new Error("not connected to the relay"));
      }
    });
  }

  private onState(s: HostedState): void {
    if (s.kind === "ready") {
      void this.serial(async () => {
        const relayHas = s.welcome.listVersion;
        if (relayHas && relayHas.number > this.chain.latest.body.number) await this.fetchVersions(this.chain.latest.body.number + 1n);
        // A version signed before a restart, whose fate is unknown: sent
        // again as it was (docs/e2e.md, section 3, Adopting a version).
        const pending = await this.o.store.get<Uint8Array>(S.pending);
        if (pending) await this.publish(decode(pending)).catch((e) => this.log(`pending version: ${(e as Error).message}`));
      }).catch((e) => this.log(`after login: ${(e as Error).message}`));
    } else {
      for (const [, resolve] of this.requests) resolve(create(FrameSchema, { body: { case: "error", value: { code: ErrorCode.SESSION_GONE, message: "lost the connection to the relay" } } }));
      this.requests.clear();
    }
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
      return answer(f);
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
        this.sessions.onFrame(f);
    }
  }

  private async fetchVersions(from: bigint): Promise<void> {
    const f = await this.request((requestId) => ({ case: "getVersions", value: { requestId, from } }));
    if (f.body.case !== "versions") throw new Error(`fetching versions: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
    await this.takeVersions(f.body.value.versions, f.body.value.withdrawals);
  }

  private async save(): Promise<void> {
    await this.o.store.set(S.chain, toBytes(this.chain.saved()));
  }

  /** Versions from the relay or a host: checked, followed, and what they changed told. */
  async takeVersions(versions: SignedObject[], withdrawals: SignedObject[]): Promise<Change> {
    const before = this.chain.latest;
    const change = await this.chain.add(versions, withdrawals);
    for (const r of change.refused) this.log(`refused: ${r.reason}`);
    if (change.taken.length || change.dropped.length || withdrawals.length) await this.save();
    for (const v of change.forks) this.emit({ type: "fork", number: v.body.number, signer: v.body.signer });
    if (before !== this.chain.latest) await this.listChanged(before);
    return change;
  }

  private async listChanged(before: Version): Promise<void> {
    const now = this.chain.latest;
    const had = new Map(before.body.devices.map((d) => [hex(d.publicKey), d]));
    const has = new Map(now.body.devices.map((d) => [hex(d.publicKey), d]));
    if (!has.has(hex(this.publicKey))) {
      // Removed by a version this client checked: it keeps nothing.
      this.conn.stop();
      await this.o.store.clear();
      this.emit({ type: "removed-me", by: now.body.signer });
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
        const prev = this.chain.latest;
        const devices = change(prev.body.devices.map((d) => create(DeviceSchema, d)));
        if (!devices) return null;
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
    await this.o.store.set(S.pending, encode(obj));
    const f = await this.request((requestId) => ({ case: "publishVersion", value: { requestId, version: obj } }));
    const h = await hash(obj);
    if (f.body.case === "done") {
      await this.takeVersions([obj], []);
      await this.o.store.delete(S.pending);
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
      await this.o.store.delete(S.pending);
      if (!w) throw new Error("lost to a version the relay does not show");
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
    await this.o.store.delete(S.pending);
    throw new Error(`the relay refused the version: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
  }

  /** Removes a device, and its read-only key with a client; then a new label key, which the removed one never had. */
  async remove(key: Uint8Array): Promise<Version | null> {
    if (equal(key, this.publicKey)) throw new Error("a client cannot remove the key it signs with");
    const v = await this.change((ds) => {
      if (!ds.some((d) => equal(d.publicKey, key))) return null;
      return ds.filter((d) => !equal(d.publicKey, key) && !equal(d.owner, key));
    });
    if (v) await this.serial(() => this.newLabelKey(v));
    return v;
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

  /** A pre-key while the newest is less than a week old; older private keys kept two days after the next is made. */
  private async ensurePreKey(): Promise<void> {
    const now = this.now();
    const newest = this.preKeys.reduce<PreKey | undefined>((a, p) => (!a || p.madeAt > a.madeAt ? p : a), undefined);
    if (!newest || now - newest.madeAt >= PRE_KEY_RENEW_MS) {
      const pair = await hpke.x25519Generate();
      const obj = await sign("pre-key", this.accountId, this.o.signer, {
        $typeName: "pirc.v1alpha2.PreKeyBody",
        signer: this.publicKey,
        preKey: pair.publicKey,
        madeAt: timestampFromMs(now),
        expiresAt: timestampFromMs(now + PRE_KEY_LIFE_MS),
      });
      this.preKeys.push({ pair, obj: encode(obj), madeAt: now, expiresAt: now + PRE_KEY_LIFE_MS });
      this.preKeys = this.preKeys.filter((p) => p === this.preKeys[this.preKeys.length - 1] || now - p.madeAt < PRE_KEY_RENEW_MS + PRE_KEY_KEEP_MS);
      await this.o.store.set(S.preKeys, this.preKeys);
      const f = await this.request((requestId) => ({ case: "publishPreKey", value: { requestId, preKey: obj } }));
      if (f.body.case !== "done") throw new Error(`pre-key: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
      // Its own wrap, so that the label key reaches this device's other
      // installs and survives here the store it was made in.
      await this.wrapLabelKey([fromBinary(PreKeyBodySchema, obj.body)]);
    } else {
      await this.o.store.set(S.preKeys, this.preKeys);
    }
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
          await this.o.store.set(S.labelKeys, this.labelKeys);
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
    const k = this.currentLabelKey();
    if (!k) throw new Error("this client has no label key yet");
    const ref = create(LabelKeyRefSchema, { version: create(VersionRefSchema, { number: k.number, hash: k.hash }) });
    const latest = await this.latestRecord();
    const sameKey = latest?.body.labelKey?.version?.number === k.number && equal(latest.body.labelKey.version.hash, k.hash);
    const counter = sameKey ? latest!.body.counter + 1n : 1n;
    const names = new Map(this.names);
    set(names);
    // Only devices on the list.
    const on = new Set(this.chain.latest.body.devices.map((d) => hex(d.publicKey)));
    const labels = create(LabelsSchema, { labels: [...names].filter(([key]) => on.has(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, label]) => create(LabelSchema, { publicKey: unhex(key), label })) });
    const obj = await sign("labels", this.accountId, this.o.signer, {
      $typeName: "pirc.v1alpha2.LabelsBody",
      labelKey: ref,
      counter,
      listVersion: refOf(this.chain.latest),
      sealed: await keys.sealLabels(k.key, this.accountId, ref, counter, labels),
      signer: this.publicKey,
    });
    const f = await this.request((requestId) => ({ case: "publishLabels", value: { requestId, labels: obj } }));
    if (f.body.case !== "done") throw new Error(`labels: ${f.body.case === "error" ? f.body.value.message : f.body.case}`);
    this.names = new Map([...names].filter(([key]) => on.has(key)));
    this.emit({ type: "labels" });
  }

  /** Names a device. */
  rename(key: Uint8Array, name: string): Promise<void> {
    return this.serial(() => this.writeLabels((n) => n.set(hex(key), name)));
  }

  /** The label key, wrapped for each of these pre-keys, each wrap signed. */
  private async wrapLabelKey(preKeys: PreKeyBody[]): Promise<void> {
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

  /** After a removal: a new label key, named by that version, its record at once, and a wrap for every current pre-key. */
  private async newLabelKey(v: Version): Promise<void> {
    this.labelKeys.push({ number: v.body.number, hash: v.hash, key: random(32) });
    await this.o.store.set(S.labelKeys, this.labelKeys);
    await this.writeLabels(() => {});
    const mine = this.preKeys.length ? [fromBinary(PreKeyBodySchema, decode(this.preKeys[this.preKeys.length - 1].obj).body)] : [];
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
   */
  async join(typed: string, decide: (d: JoiningDevice) => Promise<boolean>): Promise<JoinOutcome> {
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
      if (!(await decide(device))) {
        send(await join.result({ case: "refused", value: {} }));
        return { refused: device };
      }
      const v = await this.change((ds) => {
        if (ds.some((d) => equal(d.publicKey, device.publicKey))) return null;
        return [...ds, create(DeviceSchema, { role: device.role, publicKey: device.publicKey, addedBy: this.publicKey, addedAt: timestampFromMs(this.now()) })];
      });
      if (!v) throw new JoinFailed("that device is on the list already");
      await this.serial(() => this.writeLabels((n) => n.set(hex(device.publicKey), device.name)));
      const k = this.currentLabelKey();
      const latest = await this.latestRecord();
      send(await join.result({
        case: "approval",
        value: {
          $typeName: "pirc.v1alpha2.JoinApproval",
          accountId: this.accountId,
          version: v.object,
          approver: this.publicKey,
          approverName: this.names.get(hex(this.publicKey)) ?? this.o.name,
          ...(device.role === DeviceRole.CLIENT && k
            ? { labelKeyRef: create(LabelKeyRefSchema, { version: create(VersionRefSchema, { number: k.number, hash: k.hash }) }), labelKey: k.key, labelCounter: latest?.body.counter ?? 0n }
            : { labelKey: new Uint8Array(0), labelCounter: 0n }),
        },
      }));
      return { joined: device };
    } finally {
      this.joins.delete(joinId);
      this.send2({ case: "joinEnded", value: { joinId } });
    }
  }
}
