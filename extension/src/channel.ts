// A pi process's channels with clients (docs/e2e.md, section 4): Noise IK
// with the process as responder, the client's list first, then the
// session's frames (channel.proto), cut into pieces and sent no faster
// than the client takes them.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Handshake, Noise, StaticKey, Transport } from "@pirc/e2e/noise";
import { ErrorCode } from "@pirc/protocol";
import { ChannelFrameSchema, FrameSchema, type ChannelFrame, type Device, type Frame, type SessionFrame } from "@pirc/protocol/v1alpha2";

import { clientByChannelKey, type HeldList, type Offered } from "./account.ts";

// A Noise message's plaintext is at most 65,519 bytes; one goes to the piece's flag.
export const PIECE_DATA_MAX = 65_518;
export const FRAME_MAX = (1 << 20) + 4096;
const LAST = 1;
const MORE = 0;

// The relay closes a channel past 64 frames or 1 MiB queued toward one end.
// The client counts every 8 messages it takes, so the window holds more
// than 8 of the largest.
export const WINDOW_MESSAGES = 32;
export const WINDOW_BYTES = 768 * 1024;
export const ACK_EVERY = 8;
// What one channel may hold back before it gives up on a slow client.
export const QUEUE_BYTES = 4 << 20;
// Responder states: those still waiting for the client's list, and all.
export const MAX_WAITING = 16;
export const MAX_CHANNELS = 128;
export const WAIT_MS = 30_000;
export const IK_MESSAGE_1_BYTES = 96;

/** A frame's pieces, each a Noise message's plaintext. */
export function pieces(frame: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; ; at += PIECE_DATA_MAX) {
    const data = frame.subarray(at, at + PIECE_DATA_MAX);
    const last = at + PIECE_DATA_MAX >= frame.length;
    const p = new Uint8Array(1 + data.length);
    p[0] = last ? LAST : MORE;
    p.set(data, 1);
    out.push(p);
    if (last) return out;
  }
}

/** Joins pieces into frames: a frame when one ends, undefined for more, "invalid" past the cap or for a bad flag. */
export class Joiner {
  private parts: Uint8Array[] = [];
  private size = 0;

  push(piece: Uint8Array): Uint8Array | undefined | "invalid" {
    if (piece.length < 1 || (piece[0] !== LAST && piece[0] !== MORE)) return "invalid";
    const data = piece.subarray(1);
    this.size += data.length;
    if (this.size > FRAME_MAX) return "invalid";
    this.parts.push(data);
    if (piece[0] === MORE) return undefined;
    const frame = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      frame.set(p, at);
      at += p.length;
    }
    this.parts = [];
    this.size = 0;
    return frame;
  }
}

/** What the channels need of the process. */
export interface ChannelHost {
  readonly accountId: Uint8Array;
  readonly staticKey: StaticKey;
  readonly noise: Noise;
  /** Reads the list folder again for a version another process stored. */
  refreshList(): void;
  /** The newest version held, after any refresh. */
  newestList(): HeldList | undefined;
  /** A client's list, checked, stored if newer and acted on (removals). */
  offerList(bytes: Uint8Array): Offered;
  /** Whether this computer is on the list it holds. */
  listed(): boolean;
  sendFrame(f: Frame): boolean;
  ready(ch: Channel): void;
  session(ch: Channel, s: SessionFrame): void;
  log(msg: string): void;
}

type State = "handshake" | "waiting" | "ready" | "closed";

export class Channel {
  state: State = "handshake";
  /** The client, once its list checked out. */
  client: Device | undefined;
  private handshake: Handshake | undefined;
  private transport: Transport | undefined;
  private joiner = new Joiner();
  // In order: incoming Noise messages wait for the handshake.
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  // Pieces waiting for the window, and the sizes of those in flight.
  private queue: Uint8Array[] = [];
  private queued = 0;
  private inFlight: number[] = [];
  private inFlightBytes = 0;
  private sent = 0n;
  private acked = 0n;

  constructor(
    readonly id: bigint,
    private readonly host: ChannelHost,
    private readonly onClosed: (ch: Channel) => void,
  ) {}

  start(message1: Uint8Array): void {
    this.timer = setTimeout(() => this.close(ErrorCode.TIMEOUT), WAIT_MS);
    this.timer.unref?.();
    this.run(async () => {
      if (message1.length !== IK_MESSAGE_1_BYTES) return this.close(ErrorCode.INVALID);
      this.host.refreshList();
      this.handshake = this.host.noise.ikResponder({ staticKey: this.host.staticKey, accountId: this.host.accountId });
      const r1 = await this.handshake.readMessage(message1);
      if (!r1.ok) return this.close(ErrorCode.PERMISSION_DENIED);
      const r2 = await this.handshake.writeMessage();
      if (!r2.ok || !r2.transport) return this.close(ErrorCode.INTERNAL);
      if (this.state === "closed") return;
      this.transport = r2.transport;
      this.handshake = undefined;
      this.state = "waiting";
      this.host.sendFrame(create(FrameSchema, { body: { case: "channelMessage", value: { channelId: this.id, message: r2.message } } }));
    });
  }

  private run(step: () => Promise<void> | void): void {
    this.chain = this.chain.then(step).catch((e) => {
      this.host.log(`channel ${this.id}: ${(e as Error).message}`);
      this.close(ErrorCode.INTERNAL);
    });
  }

  /** A Noise message from the client. */
  message(m: Uint8Array): void {
    this.run(() => {
      if (this.state === "closed") return;
      const t = this.transport;
      if (!t) return this.close(ErrorCode.INVALID);
      const r = t.receive(m);
      if (!r.ok) return this.close(ErrorCode.PERMISSION_DENIED);
      const frame = this.joiner.push(r.plaintext);
      if (frame === "invalid") return this.close(ErrorCode.INVALID);
      if (frame) this.frame(frame);
    });
  }

  private frame(bytes: Uint8Array): void {
    let f: ChannelFrame;
    try {
      f = fromBinary(ChannelFrameSchema, bytes);
    } catch {
      return this.close(ErrorCode.INVALID);
    }
    const b = f.body;
    if (this.state === "waiting") {
      // The list first; nothing is sent before it checks out.
      if (b.case !== "list") return this.close(ErrorCode.PERMISSION_DENIED);
      const offered = this.host.offerList(b.value);
      if (offered.result === "refused" || offered.result === "conflict") return this.close(ErrorCode.PERMISSION_DENIED);
      const newest = this.host.newestList();
      if (!newest || !this.host.listed()) return this.close(ErrorCode.PERMISSION_DENIED);
      const client = clientByChannelKey(newest.body, this.transport!.remoteStatic ?? new Uint8Array(0));
      if (!client) return this.close(ErrorCode.PERMISSION_DENIED);
      const clientCounter = offered.result === "newer" ? offered.list.counter : offered.counter;
      this.client = client;
      this.state = "ready";
      clearTimeout(this.timer);
      this.send(create(ChannelFrameSchema, { body: { case: "listState", value: { counter: newest.counter, list: newest.counter > clientCounter ? newest.bytes : new Uint8Array(0) } } }));
      this.host.ready(this);
      return;
    }
    if (this.state !== "ready") return;
    if (b.case === "received") return this.ack(b.value);
    if (b.case === "session" && b.value.sessionId) return this.host.session(this, b.value);
    this.close(ErrorCode.INVALID);
  }

  private ack(n: bigint): void {
    if (n < this.acked || n > this.sent) return this.close(ErrorCode.INVALID);
    for (; this.acked < n; this.acked++) this.inFlightBytes -= this.inFlight.shift()!;
    this.pump();
  }

  /** Sends a frame to the client, when ready; false if the channel is over. */
  send(f: ChannelFrame): boolean {
    if (this.state !== "ready") return false;
    const ps = pieces(toBinary(ChannelFrameSchema, f));
    for (const p of ps) {
      this.queue.push(p);
      this.queued += p.length;
    }
    if (this.queued > QUEUE_BYTES) {
      this.close(ErrorCode.RATE_LIMITED);
      return false;
    }
    this.pump();
    return this.state === "ready";
  }

  sendSession(s: SessionFrame): boolean {
    return this.send(create(ChannelFrameSchema, { body: { case: "session", value: s } }));
  }

  private pump(): void {
    while (this.queue.length && this.inFlight.length < WINDOW_MESSAGES && this.inFlightBytes + this.queue[0].length <= WINDOW_BYTES) {
      const p = this.queue.shift()!;
      this.queued -= p.length;
      const r = this.transport!.send(p);
      if (!r.ok) return this.close(ErrorCode.INTERNAL);
      this.inFlight.push(r.message.length);
      this.inFlightBytes += r.message.length;
      this.sent++;
      if (!this.host.sendFrame(create(FrameSchema, { body: { case: "channelMessage", value: { channelId: this.id, message: r.message } } }))) {
        return this.close(ErrorCode.SESSION_GONE, false);
      }
    }
  }

  /** Ends the channel, telling the relay unless it was the relay that ended it. */
  close(code: ErrorCode, tell = true): void {
    if (this.state === "closed") return;
    this.state = "closed";
    clearTimeout(this.timer);
    this.transport?.close();
    this.transport = undefined;
    this.handshake = undefined;
    this.queue = [];
    if (tell) this.host.sendFrame(create(FrameSchema, { body: { case: "closeChannel", value: { channelId: this.id, code } } }));
    this.onClosed(this);
  }
}

const sameKey = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Every channel of one process. */
export class Channels {
  private all = new Map<bigint, Channel>();

  constructor(private readonly host: ChannelHost) {}

  get ready(): Channel[] {
    return [...this.all.values()].filter((c) => c.state === "ready");
  }

  get size(): number {
    return this.all.size;
  }

  /** A frame from the relay; false if it was not a channel's. */
  onFrame(f: Frame): boolean {
    const b = f.body;
    if (b.case === "openChannel") {
      const { channelId, message } = b.value;
      const refuse = (code: ErrorCode) => this.host.sendFrame(create(FrameSchema, { body: { case: "closeChannel", value: { channelId, code } } }));
      if (this.all.has(channelId)) return refuse(ErrorCode.INVALID), true;
      const waiting = [...this.all.values()].filter((c) => c.state !== "ready").length;
      if (waiting >= MAX_WAITING || this.all.size >= MAX_CHANNELS) return refuse(ErrorCode.RATE_LIMITED), true;
      const ch = new Channel(channelId, this.host, (c) => this.all.delete(c.id));
      this.all.set(channelId, ch);
      ch.start(message);
      return true;
    }
    if (b.case === "channelMessage") {
      const ch = this.all.get(b.value.channelId);
      if (ch) ch.message(b.value.message);
      return true;
    }
    if (b.case === "closeChannel") {
      this.all.get(b.value.channelId)?.close(b.value.code, false);
      return true;
    }
    return false;
  }

  /** Closes the channels of clients the newest list no longer has. */
  dropUnlisted(newest: HeldList): void {
    for (const ch of this.ready) {
      const still = ch.client && clientByChannelKey(newest.body, ch.client.channelKey);
      if (!still || !sameKey(still.signingKey, ch.client!.signingKey)) ch.close(ErrorCode.PERMISSION_DENIED);
    }
  }

  /** Every channel ends: the connection went (tell false) or the computer left. */
  closeAll(code: ErrorCode, tell: boolean): void {
    for (const ch of [...this.all.values()]) ch.close(code, tell);
  }
}
