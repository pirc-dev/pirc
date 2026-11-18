// A host's connection to a hosted account (docs/e2e.md, section 4), in the
// shape Host uses for a self-hosted relay: it takes and gives v1alpha1's
// frames (announcements, routed messages, session ends) and does the
// rest itself. Per Host object, renewed daily and on every removal from
// the list, it makes a key ID, sending keys and a request key, and
// publishes them wrapped for every current pre-key in a signed bundle;
// announcements are signed and sealed under the announcement key, routed
// frames under the conversation key, with a counter; requests are opened
// and checked in order before Host sees them. None of these keys is
// handed to a successor: after a /reload each Host object has its own.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { timestampFromMs, timestampMs } from "@bufbuild/protobuf/wkt";
import {
  errorReply,
  ErrorCode,
  FrameSchema as Frame1Schema,
  messageRequestId,
  SessionMessageSchema,
  type Frame as Frame1,
  type SessionRef,
} from "@pirc/protocol";
import {
  AnnouncementBodySchema,
  BundleBodySchema,
  DeviceRole,
  Direction,
  FrameKind,
  FrameSchema,
  VersionRefSchema,
  type Frame,
  type PreKeyBody,
  type SignedObject,
  type VersionRef,
} from "@pirc/protocol/v1alpha2";
import type { ConnectionState } from "@pirc/relay-client";
import { HostedConnection, type HostedState } from "@pirc/relay-client/hosted";
import { wsSocket } from "@pirc/relay-client/hosted-ws";

import { equal, hex, random } from "@pirc/crypto/bytes";
import type { Signer } from "@pirc/crypto/ed25519";
import * as hpke from "@pirc/crypto/hpke";
import * as keys from "@pirc/crypto/keys";
import { checkPreKey, Refused } from "@pirc/crypto/list";
import { decode, encode, open, sign } from "@pirc/crypto/objects";

import type { Anchor, AnchorState } from "./anchor.ts";

/** How long keys live, and how long an old request key is kept after a new bundle. */
export const KEY_LIFE_MS = 24 * 3600_000;
export const OLD_REQUEST_KEY_MS = 2 * 60_000;
/** How far a request's time may be from the host's. */
export const REQUEST_WINDOW_MS = 2 * 60_000;

export interface TransportEvents {
  onFrame(f: Frame1): void;
  onState(s: ConnectionState): void;
  /** The anchor no longer lets this host serve: removed, a fork, or a join that failed. */
  onAnchor(s: AnchorState): void;
  log(msg: string): void;
  fail(where: string, e: unknown): void;
}

export interface TransportOptions {
  anchor: Anchor;
  signer: Signer;
  instanceId: string;
  now?: () => number;
  /** For tests: a shorter day. */
  keyLifeMs?: number;
}

type ProcessKeys = {
  keyId: Uint8Array;
  sending: keys.SendingKeys;
  request: hpke.X25519Pair;
  madeAt: number;
  counter: bigint;
};

const refOf = (v: { body: { number: bigint }; hash: Uint8Array }): VersionRef => create(VersionRefSchema, { number: v.body.number, hash: v.hash });
const sessionKey = (r: Pick<SessionRef, "hostKey" | "sessionId" | "instanceId">) => `${hex(r.hostKey)}/${r.sessionId}/${r.instanceId}`;

export class HostedTransport {
  private readonly conn: HostedConnection;
  private readonly anchor: Anchor;
  private readonly now: () => number;
  private keys: ProcessKeys | undefined;
  private oldRequest: { keyId: Uint8Array; key: hpke.X25519Pair; until: number } | undefined;
  /** Current pre-keys, by device key, as checked against the list. */
  private preKeys = new Map<string, { body: PreKeyBody; obj: SignedObject }>();
  private preKeysAll = false;
  /** The last announcement of each session, to announce again under new keys. */
  private sessions = new Map<string, { ref: SessionRef; payload: Uint8Array; push: boolean }>();
  /** Per signer and key ID, the highest envelope counter taken. */
  private counters = new Map<string, bigint>();
  /** The bundle published on this connection, by its request ID. */
  private bundlePending = "";
  private ready = false;
  /** The devices of the list the keys were last made or wrapped for. */
  private lastDevices: Set<string>;
  private renewTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Sealing and checking are asynchronous; frames go out, and requests are checked, in order. */
  private out: Promise<void> = Promise.resolve();
  private inbox: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(
    private readonly o: TransportOptions,
    private readonly ev: TransportEvents,
  ) {
    this.anchor = o.anchor;
    this.now = o.now ?? Date.now;
    this.lastDevices = new Set(o.anchor.latest.body.devices.map((d) => hex(d.publicKey)));
    this.conn = new HostedConnection({
      origin: o.anchor.account.origin,
      accountId: o.anchor.accountId,
      signer: o.signer,
      open: wsSocket,
      onFrame: (f) => this.onFrame(f),
      onState: (s) => this.onConnState(s),
      onError: (where, e) => ev.fail(where, e),
    });
  }

  get hostKey(): Uint8Array {
    return this.o.signer.publicKey;
  }

  start(): void {
    this.stopped = false;
    this.conn.start();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.renewTimer);
    this.conn.stop();
  }

  /** v1alpha1's frames from Host: sealed and sent in order. False when not connected. */
  send(f: Frame1): boolean {
    const b = f.body;
    if (b.case === "sessionAnnounce" && b.value.session) {
      this.sessions.set(sessionKey(b.value.session), { ref: b.value.session, payload: b.value.payload, push: b.value.push });
    } else if (b.case === "sessionEnd" && b.value.session) {
      this.sessions.delete(sessionKey(b.value.session));
    }
    if (!this.ready) return false;
    this.enqueue(() => this.sendNow(f));
    return true;
  }

  private enqueue(fn: () => Promise<void>): void {
    this.out = this.out.then(fn).catch((e) => this.ev.fail("hosted send", e));
  }

  private async sendNow(f: Frame1): Promise<void> {
    const k = this.keys;
    if (!k || !this.ready) return;
    const b = f.body;
    switch (b.case) {
      case "sessionAnnounce": {
        const ref = b.value.session!;
        const listVersion = refOf(this.anchor.latest);
        const ann = await sign("announcement", this.anchor.accountId, this.o.signer, create(AnnouncementBodySchema, {
          session: ref,
          keyId: k.keyId,
          listVersion,
          madeAt: timestampFromMs(this.now()),
          announcement: b.value.payload,
        }));
        const counter = k.counter++;
        const at: keys.FrameAt = { accountId: this.anchor.accountId, keyId: k.keyId, session: ref, kind: FrameKind.ANNOUNCEMENT, recipient: new Uint8Array(0), listVersion: listVersion.number, counter };
        const payload = await keys.sealFrame(k.sending.announcement, at, encode(ann));
        this.conn.send(create(FrameSchema, { body: { case: "sessionAnnounce", value: { session: ref, keys: { keyId: k.keyId, counter, listVersion: listVersion.number }, payload, push: b.value.push } } }));
        return;
      }
      case "sessionEnd":
        this.conn.send(create(FrameSchema, { body: { case: "sessionEnd", value: { session: b.value.session } } }));
        return;
      case "routed": {
        const r = b.value;
        const to = r.clientKey;
        const kind = to.length ? FrameKind.ANSWER : FrameKind.BROADCAST;
        const listVersion = this.anchor.latest.body.number;
        const counter = k.counter++;
        const at: keys.FrameAt = { accountId: this.anchor.accountId, keyId: k.keyId, session: r.session!, kind, recipient: to, listVersion, counter };
        const payload = await keys.sealFrame(k.sending.conversation, at, r.payload);
        this.conn.send(create(FrameSchema, { body: { case: "routed", value: { session: r.session, clientKey: to, keys: { keyId: k.keyId, counter, listVersion }, payload } } }));
        return;
      }
    }
  }

  private onConnState(s: HostedState): void {
    this.ready = false;
    switch (s.kind) {
      case "ready": {
        // The relay sends every pre-key next; the bundle waits for them.
        this.preKeysAll = false;
        this.bundlePending = "";
        const relayHas = s.welcome.listVersion;
        if (relayHas && relayHas.number > this.anchor.latest.body.number) {
          this.conn.send(create(FrameSchema, { body: { case: "getVersions", value: { requestId: "catch-up", from: this.anchor.latest.body.number + 1n } } }));
        }
        this.ev.onState({ kind: "connecting" });
        return;
      }
      case "connecting":
      case "stopped":
        this.ev.onState({ kind: s.kind });
        return;
      case "offline":
        this.ev.onState({ kind: "offline", reason: s.reason });
        return;
      case "refused":
        this.ev.onState({ kind: "refused", code: s.code, reason: s.reason });
        return;
      case "unsupported":
        this.ev.onState({ kind: "refused", code: ErrorCode.VERSION_UNSUPPORTED, reason: s.reason });
        return;
    }
  }

  private onFrame(f: Frame): void {
    const b = f.body;
    switch (b.case) {
      case "preKeys":
        this.inbox = this.inbox.then(() => this.takePreKeys(b.value.preKeys, b.value.all)).catch((e) => this.ev.fail("pre-keys", e));
        return;
      case "versions":
        this.inbox = this.inbox.then(() => this.takeVersions(b.value.versions, b.value.withdrawals)).catch((e) => this.ev.fail("versions", e));
        return;
      case "done":
        if (b.value.requestId && b.value.requestId === this.bundlePending) {
          this.bundlePending = "";
          if (!this.ready) {
            this.ready = true;
            this.ev.onState({ kind: "ready", maxFrameBytes: this.maxFrameBytes() });
          }
        }
        return;
      case "routed": {
        const r = b.value;
        this.inbox = this.inbox.then(() => this.takeRequest(r.session, r.clientKey, r.keys?.keyId ?? new Uint8Array(0), r.payload)).catch((e) => this.ev.fail("request", e));
        return;
      }
      case "error":
        this.ev.onFrame(create(Frame1Schema, { body: { case: "error", value: b.value } }));
        return;
    }
  }

  private maxFrameBytes(): number {
    const s = this.conn.current;
    // Room for the frame's keys and the seal's tag.
    return s.kind === "ready" ? s.welcome.maxFrameBytes - 256 : 1 << 20;
  }

  /** Reads the anchor; false, having told Host, when it lets this host serve no more. */
  private async anchorAllows(change?: Awaited<ReturnType<Anchor["refresh"]>>): Promise<boolean> {
    const c = change ?? (await this.anchor.refresh());
    const state = this.anchor.state(this.hostKey, c.forks);
    if (state.kind === "joined") {
      if (c.taken.length || c.dropped.length) await this.listChanged();
      return true;
    }
    this.stop();
    this.ev.onAnchor(state);
    return false;
  }

  /** After the list changed: new keys on a removal; otherwise the same keys wrapped for the list as it is. */
  private async listChanged(): Promise<void> {
    const devices = new Set(this.anchor.latest.body.devices.map((d) => hex(d.publicKey)));
    for (const k of [...this.preKeys.keys()]) if (!devices.has(k)) this.preKeys.delete(k);
    // What comes after a removal must be under keys the removed device
    // never had.
    const removed = [...this.lastDevices].some((d) => !devices.has(d));
    this.lastDevices = devices;
    if (removed) await this.renew("a device removed from the list");
    else await this.publishBundle();
  }

  private async takePreKeys(objs: SignedObject[], all: boolean): Promise<void> {
    if (!(await this.anchorAllows())) return;
    if (all) this.preKeys.clear();
    for (const obj of objs) {
      try {
        const body = await checkPreKey(this.anchor.accountId, this.anchor.latest.body, obj, BigInt(this.now()));
        const have = this.preKeys.get(hex(body.signer));
        if (!have || timestampMs(have.body.madeAt!) <= timestampMs(body.madeAt!)) this.preKeys.set(hex(body.signer), { body, obj });
      } catch (e) {
        if (!(e instanceof Refused)) throw e;
        this.ev.log(`pre-key refused: ${e.message}`);
      }
    }
    if (all) this.preKeysAll = true;
    if (!this.preKeysAll) return;
    if (!this.keys || this.now() - this.keys.madeAt >= this.keyLife()) await this.renew("a new day");
    else await this.publishBundle();
  }

  private async takeVersions(versions: SignedObject[], withdrawals: SignedObject[]): Promise<void> {
    const change = await this.anchor.record(versions, withdrawals);
    for (const r of change.refused) this.ev.log(`a version from the relay refused: ${r.reason}`);
    await this.anchorAllows(change);
  }

  private keyLife(): number {
    return this.o.keyLifeMs ?? KEY_LIFE_MS;
  }

  /** New keys, a new bundle, and every session announced again under them. */
  private async renew(why: string): Promise<void> {
    const old = this.keys;
    if (old) this.oldRequest = { keyId: old.keyId, key: old.request, until: this.now() + OLD_REQUEST_KEY_MS };
    const keyId = random(16);
    this.keys = {
      keyId,
      sending: await keys.sendingKeys(random(32), keyId, this.anchor.accountId, this.hostKey),
      request: await hpke.x25519Generate(),
      madeAt: this.now(),
      counter: 0n,
    };
    this.ev.log(`new keys: ${why}`);
    clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(() => {
      this.inbox = this.inbox.then(() => this.renew("a new day")).catch((e) => this.ev.fail("renew", e));
    }, this.keyLife());
    this.renewTimer.unref?.();
    await this.publishBundle();
    if (this.ready) for (const s of this.sessions.values()) this.enqueue(() => this.sendNow(create(Frame1Schema, { body: { case: "sessionAnnounce", value: s } })));
  }

  /** The current keys, wrapped for every current pre-key on the list, signed and published. */
  private async publishBundle(): Promise<void> {
    const k = this.keys;
    if (!k || this.stopped) return;
    const list = this.anchor.latest.body;
    const recipients = await keys.wrapFor(list, [...this.preKeys.values()].map((p) => ({ publicKey: p.body.signer, preKey: p.body.preKey })), k.sending, { accountId: this.anchor.accountId, hostKey: this.hostKey, keyId: k.keyId });
    const bundle = await sign("bundle", this.anchor.accountId, this.o.signer, create(BundleBodySchema, {
      hostKey: this.hostKey,
      instanceId: this.o.instanceId,
      keyId: k.keyId,
      // Never the same time twice for one key ID: the relay takes a newer one.
      madeAt: timestampFromMs(Math.max(this.now(), k.madeAt + this.seq++)),
      listVersion: refOf(this.anchor.latest),
      requestKey: k.request.publicKey,
      recipients,
    }));
    const id = `bundle-${hex(random(4))}`;
    this.bundlePending = id;
    this.conn.send(create(FrameSchema, { body: { case: "publishBundle", value: { requestId: id, bundle } } }));
  }

  /** A client's request, checked in the order of docs/e2e.md, section 4; given to Host only if every check passes. */
  private async takeRequest(session: SessionRef | undefined, clientKey: Uint8Array, keyId: Uint8Array, payload: Uint8Array): Promise<void> {
    if (!session || !this.keys) return;
    const k = this.keys;
    const old = this.oldRequest && this.now() < this.oldRequest.until ? this.oldRequest : undefined;
    const requestKey = equal(keyId, k.keyId) ? k.request : old && equal(keyId, old.keyId) ? old.key : undefined;
    if (!requestKey) return this.ev.log("a request under keys this process does not have");
    // 1. It opens: it was meant for this process's key, which anyone can
    // encrypt to.
    const plain = await keys.openEnvelope(requestKey, this.anchor.accountId, this.hostKey, keyId, payload);
    if (!plain) return this.ev.log("a request that does not open");
    let obj: SignedObject;
    try {
      obj = decode(plain);
    } catch {
      return this.ev.log("an undecodable request");
    }
    // The signature first, on the bytes as signed; whose key it is, after
    // the versions the request carries.
    const body = await open("request", this.anchor.accountId, obj);
    if (!body) return this.ev.log("a request whose signature does not check");
    // 2. Its target is this process as it is now.
    const live = this.sessions.get(sessionKey(session));
    if (!live || !body.session || sessionKey(body.session) !== sessionKey(session) || !equal(body.keyId, keyId) || body.direction !== Direction.CLIENT_TO_HOST) {
      return this.ev.log("a request for another target");
    }
    // 3. The versions it carries, which check themselves.
    if (body.versions.length || body.withdrawals.length) {
      const change = await this.anchor.record(body.versions, body.withdrawals);
      if (!(await this.anchorAllows(change))) return;
    } else if (!(await this.anchorAllows())) return;
    // 4. A client's key on the list as it now is.
    const signer = this.anchor.latest.body.devices.find((d) => equal(d.publicKey, body.signer));
    if (signer?.role !== DeviceRole.CLIENT) return this.ev.log("a request not signed by a client on the list");
    let requestId = "";
    try {
      requestId = messageRequestId(fromBinary(SessionMessageSchema, body.request));
    } catch {
      // Refused below as undecodable, by Host.
    }
    const refuse = (msg: string) => {
      this.ev.log(`request refused: ${msg}`);
      this.enqueue(() => this.sendNow(create(Frame1Schema, { body: { case: "routed", value: { session, clientKey: body.signer, payload: toBinary(SessionMessageSchema, errorReply(requestId, ErrorCode.INVALID, msg)) } } })));
    };
    // 5. The client the relay named.
    if (!equal(body.signer, clientKey)) return refuse("the relay named another client");
    // 6. Its time, and its counter.
    const sent = body.sentAt ? timestampMs(body.sentAt) : 0;
    if (Math.abs(sent - this.now()) > REQUEST_WINDOW_MS) return refuse("the request's time is more than two minutes from this computer's clock");
    const ck = `${hex(body.signer)}/${hex(keyId)}`;
    if (body.counter <= (this.counters.get(ck) ?? 0n)) return refuse("a request older than one already taken from this client");
    this.counters.set(ck, body.counter);
    // An envelope with no request carries only versions, which step 3
    // took (docs/e2e.md, section 3, Freshness).
    if (body.request.length === 0) return;
    this.ev.onFrame(create(Frame1Schema, { body: { case: "routed", value: { session, clientKey: body.signer, payload: body.request } } }));
  }
}
