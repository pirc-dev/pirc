// A pi process of a computer in a hosted account (docs/e2e.md): logged in
// to the account's relay with the account's keys, its list folder kept up
// to date, a channel per client, and each session's announcement sealed
// to every client and its notice to every phone.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { load as loadE2e, type E2e } from "@pirc/e2e";
import { load as loadNoise, type Noise, type SodiumStaticKey } from "@pirc/e2e/noise";
import { ErrorCode, SessionAnnouncementSchema, SessionMessageSchema, type SessionMessage } from "@pirc/protocol";
import { FrameSchema, type Frame, type SessionFrame } from "@pirc/protocol/v1alpha2";
import { HostedConnection, type HostedState } from "@pirc/relay-client/hosted";
import { wsSocket } from "@pirc/relay-client/hosted-ws";
import { randomBytes } from "node:crypto";

import { folderIdentity, keysOf, ListFolder, listsSelf, readInfo, readSecrets, selfDevice, type AccountInfo, type AccountKeys, type HeldList, type Offered } from "./account.ts";
import { Channel, Channels, FRAME_MAX, type ChannelHost } from "./channel.ts";
import type { Live } from "./live.ts";

// The folder is read again this often: for a version another process
// stored, and to stop soon after another process left the account or
// joined another.
const RESCAN_MS = 10_000;
// What a session's message may take inside a channel's frame.
export const HOSTED_PAYLOAD_BYTES = FRAME_MAX - 4096;

export type HostedStatus =
  | { kind: "connecting" | "stopped" }
  | { kind: "ready" }
  | { kind: "offline" | "refused" | "unsupported"; reason: string }
  // The newest list no longer has this computer.
  | { kind: "removed" }
  // The account's phone signed two versions with one counter.
  | { kind: "conflict"; counter: bigint }
  // Another process of this computer left the account, or joined another.
  | { kind: "left" };

/** What the process gives the hosted link. */
export interface HostedSink {
  readonly instanceId: string;
  /** The computer's name, sealed with each announcement. */
  readonly computerName: string;
  /** The sessions to announce: the live one and one suspended by a reload. */
  lives(): Live[];
  /** Announces a session again: on a newer list, with push as the process decides. */
  announce(live: Live): void;
  /** A client's request for a session, answered through deliver. */
  request(sessionId: string, clientKey: Uint8Array, m: SessionMessage, deliver: (reply: SessionMessage) => void): void;
  onStatus(s: HostedStatus): void;
  log(msg: string): void;
  fail(where: string, e: unknown): void;
}

const utf8 = new TextEncoder();

export class Hosted implements ChannelHost {
  readonly accountId: Uint8Array;
  readonly staticKey: SodiumStaticKey;
  private readonly conn: HostedConnection;
  private readonly channels: Channels;
  readonly lists: ListFolder;
  private readonly self;
  private status: HostedStatus = { kind: "stopped" };
  private rescan: ReturnType<typeof setInterval> | undefined;
  private lastOrdering = 0n;
  private over = false;

  private constructor(
    readonly e2e: E2e,
    readonly noise: Noise,
    readonly info: AccountInfo,
    readonly keys: AccountKeys,
    dir: string,
    private readonly sink: HostedSink,
    private readonly rescanMs: number,
  ) {
    this.accountId = info.accountId;
    this.staticKey = noise.staticKey(keys.channelSecret);
    this.self = selfDevice(keys);
    this.lists = new ListFolder(dir, e2e, info, (m) => sink.log(m));
    this.channels = new Channels(this);
    this.conn = new HostedConnection({
      origin: info.origin,
      accountId: info.accountId,
      signer: { publicKey: keys.signingKey, sign: async (m) => keys.sign(m) },
      listCounter: () => this.lists.newest?.counter ?? 0n,
      instanceId: sink.instanceId,
      open: wsSocket,
      onFrame: (f) => this.onFrame(f),
      onState: (s) => this.onState(s),
      onError: (where, e) => sink.fail(where, e),
    });
  }

  /** The account in `dir`, read and checked; throws, saying what is wrong. */
  static async open(dir: string, sink: HostedSink, opts: { rescanMs?: number } = {}): Promise<Hosted> {
    const [e2e, noise] = await Promise.all([loadE2e(), loadNoise()]);
    const before = folderIdentity(dir);
    const info = readInfo(dir);
    const keys = keysOf(readSecrets(dir), (secret) => {
      const k = noise.staticKey(secret);
      const pub = k.publicKey;
      k.dispose();
      return pub;
    });
    const h = new Hosted(e2e, noise, info, keys, dir, sink, opts.rescanMs ?? RESCAN_MS);
    // The folder the list folder took as this account's is the one read.
    if (before === undefined || h.lists.identity !== before) {
      h.staticKey.dispose();
      throw new Error("the account folder changed while it was read; /pirc reconnect");
    }
    return h;
  }

  get signingKey(): Uint8Array {
    return this.keys.signingKey;
  }

  get current(): HostedStatus {
    return this.status;
  }

  get listCounter(): bigint {
    return this.lists.newest?.counter ?? 0n;
  }

  start(): void {
    this.lists.scan();
    if (!this.check()) return;
    this.rescan = setInterval(() => this.refreshList(), this.rescanMs);
    this.rescan.unref?.();
    this.conn.start();
  }

  stop(): void {
    clearInterval(this.rescan);
    this.channels.closeAll(ErrorCode.SESSION_GONE, true);
    this.conn.stop();
    this.staticKey.dispose();
  }

  private setStatus(s: HostedStatus): void {
    this.status = s;
    this.sink.onStatus(s);
  }

  // Stops for good on a removal, a conflict, or the folder no longer this
  // account; false then.
  private check(conflict?: bigint): boolean {
    if (this.over) return false;
    const newest = this.lists.newest;
    const ours = this.lists.ours();
    if (ours && conflict === undefined && newest && listsSelf(newest.body, this.self)) return true;
    this.over = true;
    clearInterval(this.rescan);
    this.channels.closeAll(ErrorCode.PERMISSION_DENIED, true);
    this.conn.stop();
    this.setStatus(!ours ? { kind: "left" } : conflict !== undefined ? { kind: "conflict", counter: conflict } : { kind: "removed" });
    return false;
  }

  private onState(s: HostedState): void {
    if (this.over) return;
    if (s.kind !== "ready") this.channels.closeAll(ErrorCode.SESSION_GONE, false);
    switch (s.kind) {
      case "ready":
        if (!this.check()) return;
        if (s.welcome.list.length) this.take(this.lists.offer(s.welcome.list), false);
        if (this.over) return;
        this.setStatus({ kind: "ready" });
        return;
      case "offline":
      case "refused":
      case "unsupported":
        return this.setStatus({ kind: s.kind, reason: s.reason });
      default:
        return this.setStatus({ kind: s.kind });
    }
  }

  private onFrame(f: Frame): void {
    if (this.over) return;
    if (this.channels.onFrame(f)) return;
    const b = f.body;
    if (b.case === "list") return void this.take(this.lists.offer(b.value.list), false);
    if (b.case === "error") return this.sink.log(`relay: ${b.value.message}`);
  }

  // A version offered by the relay or a client, after the folder's check.
  private take(o: Offered, fromClient: boolean): Offered {
    if (o.result === "refused") this.sink.log(`a list was refused: ${o.reason}`);
    if (o.result === "conflict") this.check(o.counter);
    if (o.result === "gone") this.check();
    if (o.result !== "newer") return o;
    this.newer(o.list);
    if (fromClient && !this.over) {
      this.conn.send(create(FrameSchema, { body: { case: "publishList", value: { requestId: randomBytes(8).toString("hex"), list: o.list.bytes } } }));
    }
    return o;
  }

  private newer(list: HeldList): void {
    this.sink.log(`list version ${list.counter}`);
    if (!this.check()) return;
    this.channels.dropUnlisted(list);
    if (this.status.kind === "ready") for (const live of this.sink.lives()) this.sink.announce(live);
  }

  // --- ChannelHost ----------------------------------------------------

  refreshList(): void {
    if (this.over) return;
    if (this.lists.scan()) this.newer(this.lists.newest!);
    else this.check();
  }

  newestList(): HeldList | undefined {
    return this.lists.newest;
  }

  offerList(bytes: Uint8Array): Offered {
    return this.take(this.lists.offer(bytes), true);
  }

  listed(): boolean {
    return !this.over;
  }

  sendFrame(f: Frame): boolean {
    return this.conn.send(f);
  }

  ready(ch: Channel): void {
    for (const live of this.sink.lives()) this.sendAnnouncement(ch, live);
  }

  session(ch: Channel, s: SessionFrame): void {
    if (s.body.case !== "message") return ch.close(ErrorCode.INVALID);
    let m: SessionMessage;
    try {
      m = fromBinary(SessionMessageSchema, s.body.value);
    } catch {
      return ch.close(ErrorCode.INVALID);
    }
    const client = ch.client!;
    // To the channel it came on while that lasts, else to the client's
    // newest: a repeat of a request still pending, sent on a new channel
    // after the old one closed, is not run again, and its answer goes there.
    this.sink.request(s.sessionId, client.signingKey, m, (reply) => {
      const to = ch.state === "ready" ? ch : this.channels.newestFor(client.signingKey);
      to?.sendSession({ $typeName: "pirc.v1alpha2.SessionFrame", sessionId: s.sessionId, body: { case: "message", value: toBinary(SessionMessageSchema, reply) } });
    });
  }

  log(msg: string): void {
    this.sink.log(msg);
  }

  // --- Sessions ---------------------------------------------------------

  private sendAnnouncement(ch: Channel, live: Live): void {
    ch.sendSession({ $typeName: "pirc.v1alpha2.SessionFrame", sessionId: live.sessionId, body: { case: "announcement", value: toBinary(SessionAnnouncementSchema, live.announcement()) } });
  }

  broadcast(sessionId: string, m: SessionMessage): void {
    const bytes = toBinary(SessionMessageSchema, m);
    for (const ch of this.channels.ready) ch.sendSession({ $typeName: "pirc.v1alpha2.SessionFrame", sessionId, body: { case: "message", value: bytes } });
  }

  private ordering(): bigint {
    const now = BigInt(Date.now());
    this.lastOrdering = now > this.lastOrdering ? now : this.lastOrdering + 1n;
    return this.lastOrdering;
  }

  /**
   * Seals the session's announcement to every client and its notice to
   * every phone, sends them with push when asked, and sends the whole
   * announcement down every channel; false when it could not be sent.
   */
  announce(live: Live, push = false): boolean {
    const newest = this.lists.newest;
    if (this.over || this.status.kind !== "ready" || !newest) return false;
    const a = live.announcement();
    for (const ch of this.channels.ready) this.sendAnnouncement(ch, live);
    const slot = { accountId: this.accountId, computerKey: this.keys.signingKey, sessionId: utf8.encode(live.sessionId) };
    const list = { counter: newest.counter, devices: newest.body.devices };
    const name = a.name || a.firstPrompt;
    const notice = a.notice;
    const announcements = this.e2e.seal({
      list,
      boxSecretKey: this.keys.boxSecret,
      slot: { ...slot, kind: "announcement" },
      ordering: this.ordering(),
      body: { sessionName: name, folder: a.cwd, model: a.model ? a.model.name || a.model.id : "", computerName: this.sink.computerName, notice: notice?.text ?? "" },
    });
    // A notice keeps its number while it is the same notice, so sealing it
    // again for a new list does not raise it again.
    const notices = notice
      ? this.e2e.seal({ list, boxSecretKey: this.keys.boxSecret, slot: { ...slot, kind: "notice" }, ordering: notice.number, body: { sessionName: name, computerName: this.sink.computerName, notice: notice.text } })
      : { copies: [], skipped: [] };
    for (const k of [...announcements.skipped, ...notices.skipped]) this.sink.log(`sealing skipped a key: ${Buffer.from(k).toString("base64url")}`);
    const copy = (c: { recipientKey: Uint8Array; sealed: Uint8Array }) => ({ recipientKey: c.recipientKey, sealed: c.sealed });
    return this.conn.send(
      create(FrameSchema, {
        body: {
          case: "sessionAnnounce",
          value: { session: { hostKey: this.keys.signingKey, sessionId: live.sessionId, instanceId: this.sink.instanceId }, push, announcements: announcements.copies.map(copy), notices: notices.copies.map(copy) },
        },
      }),
    );
  }

  end(live: Live): void {
    this.conn.send(create(FrameSchema, { body: { case: "sessionEnd", value: { session: { hostKey: this.keys.signingKey, sessionId: live.sessionId, instanceId: this.sink.instanceId } } } }));
  }
}
