// What a client of a hosted account does with sessions (docs/e2e.md,
// section 4), in the shape web/core's Client knows: it takes v1alpha1's
// frames from it (subscribing, attaching, requests) and gives it v1alpha1's
// back (the session list, its changes, routed messages), opened. Bundles
// are taken only when signed by a host on the list as this client checked
// it, with every recipient on that list, made less than 26 hours ago, and
// the newest of their process (an older one for a minute after); frames
// only under such a bundle, with a counter higher than the last; requests
// go in envelopes, signed, with a counter written down before they go, and
// the versions the host is missing.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs, timestampMs } from "@bufbuild/protobuf/wkt";
import {
  FrameSchema as Frame1Schema,
  RegisteredKeySchema,
  Role,
  SessionEntrySchema as Entry1Schema,
  type Frame as Frame1,
  type SessionEntry as Entry1,
  type SessionRef,
} from "@pirc/protocol";
import {
  DeviceRole,
  Direction,
  EnvelopeBodySchema,
  FrameKind,
  FrameSchema,
  VersionRefSchema,
  type BundleBody,
  type Frame,
  type FrameKeys,
  type SessionEntry,
} from "@pirc/protocol/v1alpha2";
import type { HostedState } from "@pirc/relay-client/hosted";

import { equal, hex } from "@pirc/crypto/bytes";
import { sha256 } from "@pirc/crypto/hpke";
import * as keys from "@pirc/crypto/keys";
import { decode, encode, open, sign } from "@pirc/crypto/objects";

import type { Chain } from "@pirc/crypto/chain";
import type { Signer } from "@pirc/crypto/ed25519";
import type { X25519Pair } from "@pirc/crypto/hpke";
import type { Version } from "@pirc/crypto/list";

import type { Store } from "./store.ts";

/** What the sessions need of the account (account.ts's HostedClient; a fixed one in cases/exchanges/hosted). */
export interface SessionsAccount {
  readonly accountId: Uint8Array;
  readonly latest: Version;
  readonly list: Chain;
  readonly publicKey: Uint8Array;
  readonly signer: Signer;
  /** Why the client may send nothing now (an undecided fork), if it may not. */
  readonly blocked?: string;
  myPreKeys(): X25519Pair[];
  label(key: Uint8Array): string | undefined;
  send2(body: Parameters<HostedSend>[0]): boolean;
}
type HostedSend = (body: MessageInitShape<typeof FrameSchema>["body"]) => boolean;

export interface SessionsOptions {
  now?: () => number;
  /** For recorded cases: the ephemeral key each envelope is sealed with. */
  ephemeral?: () => Promise<X25519Pair>;
}

/** How long a bundle is read at all, and an older bundle after a newer one is made. */
export const BUNDLE_LIFE_MS = 26 * 3600_000;
export const OLD_BUNDLE_MS = 60_000;

/**
 * The highest counter taken per key ID and session, kept in the store
 * (key "seen") so that a restart forgets none; and the announcement last
 * taken, by counter and hash, the one frame that may come again (the
 * relay's stored copy, after newer frames too), and only as the same
 * bytes. Kept while its key ID can be read, and an hour more.
 */
type Seen = Record<string, { counter: bigint; announcement?: { counter: bigint; hash: Uint8Array }; until: number }>;
const SEEN = "seen";

type Bundle = {
  body: BundleBody;
  keys: { announcement: Uint8Array; conversation: Uint8Array | null };
  madeAt: number;
};

const process = (hostKey: Uint8Array, instanceId: string) => `${hex(hostKey)}/${instanceId}`;
const sessionKey = (r: Pick<SessionRef, "hostKey" | "sessionId" | "instanceId">) => `${hex(r.hostKey)}/${r.sessionId}/${r.instanceId}`;

export class Sessions {
  /** Bundles taken, by key ID. */
  private bundles = new Map<string, Bundle>();
  /** Each process's newest bundle's time. */
  private newest = new Map<string, number>();
  /** The live sessions as the relay last sent them, sealed, for a list change to reopen. */
  private entries = new Map<string, SessionEntry>();
  /** Each session's newest announcement time, and the version its host had. */
  private announced = new Map<string, { madeAt: number; listVersion: bigint }>();
  /** Per key ID and session, the highest counter taken, as the store has it. */
  private seen: Promise<Seen> | undefined;
  private out: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(
    private readonly c: SessionsAccount,
    private readonly store: Store,
    private readonly emit: (f: Frame1) => void,
    private readonly log: (m: string) => void,
    private readonly opts: SessionsOptions = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Resolves once every frame taken so far has been handled. */
  settled(): Promise<void> {
    return this.out;
  }

  onState(s: HostedState): void {
    this.ready = s.kind === "ready";
    if (!this.ready) this.entries.clear();
  }

  /** The list changed: bundles are checked again, against it. */
  onList(): void {
    this.bundles.clear();
    this.newest.clear();
    // In the frames' order: a frame taken after this is opened after.
    this.out = this.out.then(() => this.reopen()).catch((e) => this.log(`reopening: ${(e as Error).message}`));
  }

  private async reopen(): Promise<void> {
    const opened: Entry1[] = [];
    for (const e of this.entries.values()) {
      const x = await this.openEntry(e);
      if (x) opened.push(x);
    }
    for (const e of opened) this.emit(create(Frame1Schema, { body: { case: "sessionUpdated", value: { entry: e } } }));
  }

  /** What a host's announcements say it has of the list, by host key: for the clients' "not yet confirmed". */
  hostVersion(hostKey: Uint8Array): bigint | undefined {
    let v: bigint | undefined;
    for (const [k, a] of this.announced) if (k.startsWith(hex(hostKey))) v = v === undefined || a.listVersion > v ? a.listVersion : v;
    return v;
  }

  private async takeBundle(obj: Parameters<typeof open>[2]): Promise<void> {
    const body = await open("bundle", this.c.accountId, obj);
    if (!body || this.bundles.has(hex(body.keyId))) return;
    const host = this.c.latest.body.devices.find((d) => equal(d.publicKey, body.hostKey));
    if (host?.role !== DeviceRole.HOST) return this.log("a bundle not signed by a host on the list");
    const madeAt = body.madeAt ? timestampMs(body.madeAt) : 0;
    if (this.now() - madeAt > BUNDLE_LIFE_MS) return this.log("a bundle older than 26 hours");
    let got: Bundle["keys"] | null = null;
    for (const preKey of this.c.myPreKeys()) {
      got = await keys.unwrap(this.c.accountId, body, this.c.latest.body, { publicKey: this.c.publicKey, preKey });
      if (got) break;
    }
    if (!got) return this.log("a bundle with nothing for this device, or a recipient off the list");
    this.bundles.set(hex(body.keyId), { body, keys: got, madeAt });
    const p = process(body.hostKey, body.instanceId);
    this.newest.set(p, Math.max(this.newest.get(p) ?? 0, madeAt));
  }

  /** The bundle a frame may be read under: taken, of the session's process, and not passed by a newer one more than a minute ago. */
  private bundleFor(ref: SessionRef, keyId: Uint8Array): Bundle | undefined {
    const b = this.bundles.get(hex(keyId));
    if (!b || !equal(b.body.hostKey, ref.hostKey) || b.body.instanceId !== ref.instanceId) return undefined;
    const newest = this.newest.get(process(ref.hostKey, ref.instanceId)) ?? 0;
    if (b.madeAt < newest && this.now() > newest + OLD_BUNDLE_MS) return undefined;
    if (this.now() - b.madeAt > BUNDLE_LIFE_MS) return undefined;
    return b;
  }

  /**
   * Whether a frame's counter is past the last taken under its key ID in
   * its session; for an announcement (`payload` given), also the one last
   * taken again, with its counter and the same bytes. Written to the store
   * before the frame is handed on, and kept an hour past the last time its
   * bundle can be read.
   */
  private async counterOk(b: Bundle, ref: SessionRef, counter: bigint, payload?: Uint8Array): Promise<boolean> {
    const h = payload && (await sha256(payload));
    const seen = await (this.seen ??= this.store.get<Seen>(SEEN).then((s) => s ?? {}));
    // From here to the write, no await: two frames cannot both pass.
    const k = `${hex(b.body.keyId)}/${sessionKey(ref)}`;
    const last = seen[k];
    if (h && last?.announcement && counter === last.announcement.counter) return equal(h, last.announcement.hash);
    if (last && counter <= last.counter) return false;
    const now = this.now();
    for (const [x, v] of Object.entries(seen)) if (now > v.until) delete seen[x];
    seen[k] = { counter, announcement: h ? { counter, hash: h } : last?.announcement, until: Math.max(now, b.madeAt) + BUNDLE_LIFE_MS + 3600_000 };
    await this.store.set(SEEN, seen);
    return true;
  }

  private async openEntry(e: SessionEntry): Promise<Entry1 | undefined> {
    const ref = e.session;
    const k = e.keys;
    if (!ref || !k) return undefined;
    for (const b of e.bundles) await this.takeBundle(b);
    const b = this.bundleFor(ref, k.keyId);
    if (!b) return void this.log("an announcement under keys this client cannot read");
    const at: keys.FrameAt = { accountId: this.c.accountId, keyId: k.keyId, session: ref, kind: FrameKind.ANNOUNCEMENT, recipient: new Uint8Array(0), listVersion: k.listVersion, counter: k.counter };
    const plain = await keys.openFrame(b.keys.announcement, at, e.payload);
    if (!plain) return void this.log("an announcement that does not open");
    let ann;
    try {
      ann = await open("announcement", this.c.accountId, decode(plain));
    } catch {
      ann = null;
    }
    if (!ann || !ann.session || sessionKey(ann.session) !== sessionKey(ref) || !equal(ann.keyId, k.keyId) || ann.listVersion?.number !== k.listVersion) {
      return void this.log("an announcement whose signature or target does not check");
    }
    const madeAt = ann.madeAt ? timestampMs(ann.madeAt) : 0;
    const seen = this.announced.get(sessionKey(ref));
    // Not an older announcement than one seen; the stored one may come
    // again, with its counter.
    if (seen && madeAt < seen.madeAt) return void this.log("an announcement older than one seen");
    if (!(await this.counterOk(b, ref, k.counter, e.payload))) return void this.log("an announcement replayed out of order, or again with other bytes");
    this.announced.set(sessionKey(ref), { madeAt, listVersion: ann.listVersion.number });
    // A host behind this client's list is sent the rest at once, in an
    // envelope of its own (docs/e2e.md, section 3, Freshness).
    if (ann.listVersion.number < this.c.latest.body.number && this.ready) {
      const r = ref;
      this.out = this.out.then(() => this.request(r, new Uint8Array(0))).catch((e) => this.log(`versions to a host: ${(e as Error).message}`));
    }
    return create(Entry1Schema, { session: ref, hostLabel: this.c.label(ref.hostKey) ?? "", payload: ann.announcement, announcedAt: timestampFromMs(madeAt) });
  }

  /** Frames from the relay for sessions. */
  onFrame(f: Frame): void {
    this.out = this.out.then(() => this.take(f)).catch((e) => this.log(`session frame: ${(e as Error).message}`));
  }

  private async take(f: Frame): Promise<void> {
    const b = f.body;
    switch (b.case) {
      case "sessionList": {
        const opened: Entry1[] = [];
        for (const e of b.value.sessions) {
          if (e.session) this.entries.set(sessionKey(e.session), e);
          const x = await this.openEntry(e);
          if (x) opened.push(x);
        }
        this.emit(create(Frame1Schema, { body: { case: "sessionList", value: { sessions: opened, more: b.value.more } } }));
        return;
      }
      case "sessionUpdated": {
        const e = b.value.entry;
        if (!e?.session) return;
        this.entries.set(sessionKey(e.session), e);
        const x = await this.openEntry(e);
        if (x) this.emit(create(Frame1Schema, { body: { case: "sessionUpdated", value: { entry: x } } }));
        return;
      }
      case "sessionEnded":
        if (b.value.session) this.entries.delete(sessionKey(b.value.session));
        this.emit(create(Frame1Schema, { body: { case: "sessionEnded", value: { session: b.value.session } } }));
        return;
      case "routed": {
        const r = b.value;
        const ref = r.session;
        const k = r.keys;
        if (!ref || !k) return;
        // An answer to another client is not ours; the relay should not
        // have sent it.
        if (r.clientKey.length && !equal(r.clientKey, this.c.publicKey)) return;
        const bundle = this.bundleFor(ref, k.keyId);
        if (!bundle?.keys.conversation) return this.log("a frame under keys this client cannot read");
        const at: keys.FrameAt = { accountId: this.c.accountId, keyId: k.keyId, session: ref, kind: r.clientKey.length ? FrameKind.ANSWER : FrameKind.BROADCAST, recipient: r.clientKey, listVersion: k.listVersion, counter: k.counter };
        const plain = await keys.openFrame(bundle.keys.conversation, at, r.payload);
        if (!plain) return this.log("a frame that does not open");
        if (!(await this.counterOk(bundle, ref, k.counter))) return this.log("a frame replayed or out of order");
        this.emit(create(Frame1Schema, { body: { case: "routed", value: { session: ref, clientKey: r.clientKey, payload: plain } } }));
        return;
      }
      case "devices": {
        const list = this.c.latest.body.devices;
        const by = new Map(b.value.devices.map((d) => [hex(d.publicKey), d]));
        this.emit(create(Frame1Schema, {
          body: {
            case: "keys",
            value: {
              keys: list.filter((d) => d.role !== DeviceRole.READ_ONLY).map((d) => {
                const st = by.get(hex(d.publicKey));
                return create(RegisteredKeySchema, {
                  publicKey: d.publicKey,
                  role: d.role === DeviceRole.HOST ? Role.HOST : Role.CLIENT,
                  label: this.c.label(d.publicKey) ?? "",
                  addedAt: d.addedAt,
                  online: st?.online ?? false,
                  push: st?.push ?? false,
                  readKey: list.some((x) => x.role === DeviceRole.READ_ONLY && equal(x.owner, d.publicKey)),
                });
              }),
            },
          },
        }));
        return;
      }
      case "error":
        this.emit(create(Frame1Schema, { body: { case: "error", value: b.value } }));
        return;
    }
  }

  /** v1alpha1's frames from web/core's Client: false when not connected. */
  send(f: Frame1): boolean {
    if (!this.ready || this.c.blocked) return false;
    const b = f.body;
    switch (b.case) {
      case "subscribeSessions":
        return this.c.send2({ case: "subscribeSessions", value: {} });
      case "attach":
        return this.c.send2({ case: "attach", value: { session: b.value.session } });
      case "detach":
        return this.c.send2({ case: "detach", value: { session: b.value.session } });
      case "watchKeys":
        return this.c.send2({ case: "watchDevices", value: {} });
      case "routed": {
        const ref = b.value.session;
        if (!ref) return false;
        this.out = this.out.then(() => this.request(ref, b.value.payload)).catch((e) => this.log(`request: ${(e as Error).message}`));
        return true;
      }
      default:
        // Hosts awaiting approval, tokens and renames are the self-hosted
        // relay's; a hosted account has none of them.
        return false;
    }
  }

  /** The process's newest bundle this client has taken. */
  private newestBundle(ref: SessionRef): Bundle | undefined {
    let best: Bundle | undefined;
    for (const b of this.bundles.values()) {
      if (equal(b.body.hostKey, ref.hostKey) && b.body.instanceId === ref.instanceId && (!best || b.madeAt > best.madeAt)) best = b;
    }
    return best && this.now() - best.madeAt <= BUNDLE_LIFE_MS ? best : undefined;
  }

  /** A request, in its envelope, to the process's request key. */
  private async request(ref: SessionRef, request: Uint8Array): Promise<void> {
    if (this.c.blocked) return this.log(`request not sent: ${this.c.blocked}`);
    const b = this.newestBundle(ref);
    if (!b) return this.log("no keys from that process: its session is stale");
    // The counter is written before the envelope goes, so that a crash
    // cannot send one counter twice.
    const ck = `counter:${hex(b.body.requestKey)}`;
    const counter = ((await this.store.get<bigint>(ck)) ?? 0n) + 1n;
    await this.store.set(ck, counter);
    const latest = this.c.latest;
    const hostHas = this.announced.get(sessionKey(ref))?.listVersion ?? 0n;
    const missing = hostHas < latest.body.number ? this.c.list.from(hostHas + 1n).map((v) => v.object) : [];
    const env = await sign("request", this.c.accountId, this.c.signer, create(EnvelopeBodySchema, {
      session: ref,
      keyId: b.body.keyId,
      direction: Direction.CLIENT_TO_HOST,
      sentAt: timestampFromMs(this.now()),
      counter,
      listVersion: create(VersionRefSchema, { number: latest.body.number, hash: latest.hash }),
      versions: missing,
      withdrawals: missing.length ? this.c.list.withdrawals() : [],
      request,
      signer: this.c.publicKey,
    }));
    const payload = await keys.sealEnvelope(b.body.requestKey, this.c.accountId, ref.hostKey, b.body.keyId, encode(env), await this.opts.ephemeral?.());
    const keysOut: FrameKeys = { $typeName: "pirc.v1alpha2.FrameKeys", keyId: b.body.keyId, counter: 0n, listVersion: 0n };
    this.c.send2({ case: "routed", value: { session: ref, clientKey: new Uint8Array(0), keys: keysOut, payload } });
  }
}

