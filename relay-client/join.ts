// A new device's side of a join (docs/e2e.md, section 6), for a computer
// at `/pirc join` and a browser or app joining as a client alike. It makes
// a one-time secret and a lookup, waits under the lookup at the relay,
// and gives the text to show; the account's phone reads it and runs Noise
// XXpsk3 with the secret, this device the responder. Then this device
// sends its signed offer, and takes the phone's accept: the phone's own
// signed offer, version 1 of the list and the version that adds this
// device in its role. The secret works once, for ten minutes on this
// device's clock. Nothing in it is Node's.
import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { joinPrologue, joinText, makeOffer, newLookup, offerSigned, ROLE_CLIENT, SECRET_BYTES, type DeviceKeys, type E2e } from "@pirc/e2e";
import type { Handshake, Noise, StaticKey, Transport } from "@pirc/e2e/noise";
import { FrameSchema, JoinAcceptSchema, type Frame, type JoinAccept } from "@pirc/protocol/v1alpha2";

import { HostedConnection, type OpenSocket } from "./hosted.ts";

export const JOIN_MS = 10 * 60_000;
const NAME_MAX_BYTES = 200;

/** What a join ends with: the account, the two versions taken, the name the phone gave. */
export interface Joined {
  accountId: Uint8Array;
  phoneKey: Uint8Array;
  lists: { counter: bigint; bytes: Uint8Array }[];
  phoneName: string;
}

export interface DeviceJoinOptions {
  origin: string;
  e2e: E2e;
  noise: Noise;
  open: OpenSocket;
  random(n: number): Uint8Array;
  log(msg: string): void;
  /** The joining device: its role and keys, as the list is to hold them. */
  self: DeviceKeys;
  /** Its channel key's secret half, for XXpsk3. */
  staticKey: StaticKey;
  /** Signs with its signing key: the login and the offer. */
  sign(m: Uint8Array): Promise<Uint8Array>;
  /** For tests: how long the code works, JOIN_MS otherwise. */
  joinMs?: number;
  /** The wall clock in milliseconds, Date.now by default. */
  now?(): number;
  /** The wait asked of the relay, at each login; a refusal follows as a failure. */
  onWaiting?(): void;
  /** A phone has the code and the handshake has begun. */
  onPaired?(): void;
}

const sameDevice = (a: DeviceKeys, b: DeviceKeys) =>
  a.role === b.role && [a.signingKey, a.channelKey, a.boxKey, a.readOnlyKey, a.notificationKey].every((k, i) => {
    const o = [b.signingKey, b.channelKey, b.boxKey, b.readOnlyKey, b.notificationKey][i];
    return k.length === o.length && k.every((x, j) => x === o[j]);
  });

const expiredText = "the code expired after ten minutes; start the join again";

/** One join, from its code shown to the account it joined, or its failure. */
export class DeviceJoin {
  readonly text: string;
  readonly lookup: string;
  readonly done: Promise<Joined>;
  private readonly secret: Uint8Array;
  private readonly conn: HostedConnection;
  private joinId = "";
  private handshake: Handshake | undefined;
  private transport: Transport | undefined;
  private step = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settle: { resolve(j: Joined): void; reject(e: Error): void } | undefined;
  private chain: Promise<void> = Promise.resolve();
  private over = false;
  private deadline = 0;

  constructor(private readonly d: DeviceJoinOptions) {
    this.secret = d.random(SECRET_BYTES);
    this.lookup = newLookup(d.random);
    this.text = joinText(this.lookup, this.secret);
    this.done = new Promise<Joined>((resolve, reject) => (this.settle = { resolve, reject }));
    this.conn = new HostedConnection({
      origin: d.origin,
      accountId: new Uint8Array(0),
      signer: { publicKey: d.self.signingKey, sign: d.sign },
      open: d.open,
      onFrame: (f) => this.onFrame(f),
      onState: (s) => {
        if (this.over || this.expired()) return;
        if (s.kind === "refused") this.fail(`the relay refused: ${s.reason}`);
        else if (s.kind === "ready") {
          // A connection lost after the phone paired loses the join.
          if (this.joinId) return this.fail("the connection to the relay was lost; start the join again");
          this.send({ case: "joinWait", value: { lookup: this.lookup } });
          d.onWaiting?.();
        } else if (s.kind === "unsupported") this.fail(`the relay: ${s.reason}`);
      },
      onError: (where, e) => d.log(`join ${where}: ${(e as Error).message}`),
    });
  }

  /** Waits under the lookup; the code works for ten minutes. */
  start(): Promise<Joined> {
    const ms = this.d.joinMs ?? JOIN_MS;
    // On the wall clock too: a timer does not run while the machine sleeps.
    this.deadline = this.now() + ms;
    this.timer = setTimeout(() => this.fail(expiredText), ms);
    (this.timer as { unref?(): void }).unref?.();
    this.conn.start();
    return this.done;
  }

  cancel(): void {
    this.fail("cancelled");
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  // Ends the join once its ten minutes are over; true then.
  private expired(): boolean {
    if (this.now() < this.deadline) return false;
    this.fail(expiredText);
    return true;
  }

  private send(body: MessageInitShape<typeof FrameSchema>["body"]): void {
    this.conn.send(create(FrameSchema, { body }));
  }

  private finish(): void {
    this.over = true;
    clearTimeout(this.timer);
    if (this.joinId) this.send({ case: "joinEnded", value: { joinId: this.joinId } });
    this.transport?.close();
    this.conn.stop();
  }

  private fail(why: string): void {
    if (this.over) return;
    this.finish();
    this.settle?.reject(new Error(why));
  }

  private onFrame(f: Frame): void {
    if (this.over || this.expired()) return;
    const b = f.body;
    switch (b.case) {
      case "error":
        return this.fail(`the relay: ${b.value.message || "refused the join"}`);
      case "joinPaired":
        if (this.joinId) return this.fail("the relay paired the join twice");
        this.joinId = b.value.joinId;
        this.handshake = this.d.noise.xxpsk3Responder({ staticKey: this.d.staticKey, prologue: joinPrologue(this.lookup), psk: this.secret });
        this.d.onPaired?.();
        return;
      case "joinMessage":
        if (b.value.joinId !== this.joinId || !this.joinId) return this.fail("a step of another join");
        this.chain = this.chain.then(() => this.onStep(b.value.step)).catch((e) => this.fail((e as Error).message));
        return;
      case "joinEnded":
        if (b.value.joinId === this.joinId) this.fail("the phone ended the join");
        return;
    }
  }

  private async onStep(step: Uint8Array): Promise<void> {
    if (this.over || this.expired()) return;
    const n = this.step++;
    if (n === 0) {
      const r1 = await this.handshake!.readMessage(step);
      if (!r1.ok) return this.fail("the phone's first message did not check out");
      const r2 = await this.handshake!.writeMessage();
      if (!r2.ok) return this.fail("the handshake failed");
      return this.send({ case: "joinMessage", value: { joinId: this.joinId, step: r2.message } });
    }
    if (n === 1) {
      // The secret proves itself here: a wrong one fails, and the code is spent.
      const r3 = await this.handshake!.readMessage(step);
      if (!r3.ok || !r3.transport) return this.fail("the code did not match: start the join again");
      const transport = r3.transport;
      this.transport = transport;
      this.handshake = undefined;
      const signature = await this.d.sign(offerSigned(this.d.self, transport.handshakeHash));
      if (this.over) return;
      const sent = transport.send(makeOffer(this.d.self, transport.handshakeHash, () => signature));
      if (!sent.ok) return this.fail("the handshake failed");
      return this.send({ case: "joinMessage", value: { joinId: this.joinId, step: sent.message } });
    }
    if (n === 2) {
      const r = this.transport!.receive(step);
      if (!r.ok) return this.fail("the phone's answer did not check out");
      let accept: JoinAccept;
      try {
        accept = fromBinary(JoinAcceptSchema, r.plaintext);
      } catch {
        return this.fail("the phone's answer did not parse");
      }
      const joined = this.check(accept);
      if (typeof joined === "string") return this.fail(joined);
      this.finish();
      this.settle?.resolve(joined);
      return;
    }
    this.fail("the phone sent more than a join has");
  }

  private check(a: JoinAccept): Joined | string {
    const t = this.transport!;
    if (!a.phone) return "the phone sent no offer";
    const offer = this.d.e2e.checkOffer({ offer: a.phone, role: ROLE_CLIENT, remoteStatic: t.remoteStatic ?? new Uint8Array(0), handshakeHash: t.handshakeHash });
    if (offer.result !== "accepted") return `the phone's offer was refused (${offer.reason})`;
    const phone = offer.device;
    if (phone.readOnlyKey.length === 0) return "the device that answered is not a phone";
    const first = this.d.e2e.checkList({ bytes: a.first, phoneKey: phone.signingKey, mode: "first", highest: 0n });
    if (first.result !== "accepted") return `version 1 of the list was refused (${first.result === "refused" || first.result === "unsupported" ? first.reason : first.result})`;
    if (!sameDevice(first.list.devices[0], phone)) return "version 1 of the list is not that phone's";
    const accountId = first.hash;
    const newest = this.d.e2e.checkList({ bytes: a.list, phoneKey: phone.signingKey, mode: "later", accountId, highest: 1n, self: this.d.self });
    if (newest.result !== "accepted") return `the list was refused (${newest.result === "refused" || newest.result === "unsupported" ? newest.reason : newest.result})`;
    // Shown to the person: no control characters.
    const name = a.phoneName.length <= NAME_MAX_BYTES ? new TextDecoder("utf-8", { fatal: false }).decode(a.phoneName).replace(/[\p{Cc}\p{Cf}]/gu, "") : "";
    return {
      accountId,
      phoneKey: phone.signingKey,
      lists: [{ counter: 1n, bytes: a.first }, { counter: newest.counter, bytes: a.list }],
      phoneName: name,
    };
  }
}
