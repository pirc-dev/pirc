// A client's end of a channel, for tests: Noise IK's initiator, the list
// first, frames cut into pieces and joined again, and `received` sent as
// channel.proto asks. No client is written in TypeScript yet; the app's is
// Dart (part 8).
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Handshake, Noise, Transport } from "@pirc/e2e/noise";
import { SessionAnnouncementSchema, SessionMessageSchema, type SessionAnnouncement, type SessionMessage } from "@pirc/protocol";
import { ChannelFrameSchema, type ChannelFrame } from "@pirc/protocol/v1alpha2";

import { ACK_EVERY, Joiner, pieces } from "../src/channel.ts";

type Received = { sessionId: string; message: SessionMessage } | { sessionId: string; announcement: SessionAnnouncement };

export class ChannelClient {
  private handshake: Handshake;
  private transport: Transport | undefined;
  private joiner = new Joiner();
  private taken = 0n;
  readonly frames: ChannelFrame[] = [];

  constructor(
    noise: Noise,
    channelSecret: Uint8Array,
    computerChannelKey: Uint8Array,
    accountId: Uint8Array,
    /** Sends one Noise message toward the computer. */
    private readonly out: (message: Uint8Array) => void,
    private readonly ackEvery = ACK_EVERY,
  ) {
    this.handshake = noise.ikInitiator({ staticKey: noise.staticKey(channelSecret), responderKey: computerChannelKey, accountId });
  }

  async message1(): Promise<Uint8Array> {
    const r = await this.handshake.writeMessage();
    if (!r.ok) throw new Error(`IK message 1: ${r.reason}`);
    return r.message;
  }

  /** A Noise message from the computer: message 2, then the transport's. */
  async take(m: Uint8Array): Promise<void> {
    if (!this.transport) {
      const r = await this.handshake.readMessage(m);
      if (!r.ok || !r.transport) throw new Error(`IK message 2: ${r.ok ? "no transport" : r.reason}`);
      this.transport = r.transport;
      return;
    }
    const r = this.transport.receive(m);
    if (!r.ok) throw new Error(`receive: ${r.reason}`);
    this.taken++;
    const f = this.joiner.push(r.plaintext);
    if (f === "invalid") throw new Error("a bad piece");
    if (f) this.frames.push(fromBinary(ChannelFrameSchema, f));
    if (this.ackEvery && this.taken % BigInt(this.ackEvery) === 0n) this.send(create(ChannelFrameSchema, { body: { case: "received", value: this.taken } }));
  }

  get received(): bigint {
    return this.taken;
  }

  send(f: ChannelFrame): void {
    for (const p of pieces(toBinary(ChannelFrameSchema, f))) this.raw(p);
  }

  /** One plaintext as it is, for tests of bad pieces. */
  raw(plaintext: Uint8Array): void {
    const r = this.transport!.send(plaintext);
    if (!r.ok) throw new Error(`send: ${r.reason}`);
    this.out(r.message);
  }

  sendList(list: Uint8Array): void {
    this.send(create(ChannelFrameSchema, { body: { case: "list", value: list } }));
  }

  request(sessionId: string, m: SessionMessage): void {
    this.send(create(ChannelFrameSchema, { body: { case: "session", value: { sessionId, body: { case: "message", value: toBinary(SessionMessageSchema, m) } } } }));
  }

  /** The session messages and announcements received, decoded. */
  sessions(): Received[] {
    return this.frames.flatMap((f): Received[] => {
      if (f.body.case !== "session") return [];
      const s = f.body.value;
      if (s.body.case === "message") return [{ sessionId: s.sessionId, message: fromBinary(SessionMessageSchema, s.body.value) }];
      if (s.body.case === "announcement") return [{ sessionId: s.sessionId, announcement: fromBinary(SessionAnnouncementSchema, s.body.value) }];
      return [];
    });
  }
}
