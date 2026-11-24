// `/pirc join` (docs/e2e.md, section 6): this computer joins a hosted
// account. It makes fresh keys, a one-time secret and a lookup, waits under
// the lookup at the relay, and shows the text and its QR code; the
// account's phone reads it and runs Noise XXpsk3 with the secret, this
// computer the responder. Then this computer sends its signed offer, and
// takes the phone's accept: the phone's own signed offer, version 1 of the
// list and the version that adds this computer. The secret works once,
// for ten minutes on this computer's clock.
import { create, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { joinPrologue, joinText, makeOffer, newLookup, ROLE_CLIENT, SECRET_BYTES, type DeviceKeys, type E2e } from "@pirc/e2e";
import type { Handshake, Noise, Transport } from "@pirc/e2e/noise";
import { FrameSchema, JoinAcceptSchema, type Frame, type JoinAccept } from "@pirc/protocol/v1alpha2";
import { HostedConnection, type OpenSocket } from "@pirc/relay-client/hosted";
import { encode } from "uqr";

import { keysOf, newSecrets, selfDevice, type AccountInfo, type Secrets } from "./account.ts";

export const JOIN_MS = 10 * 60_000;
const NAME_MAX_BYTES = 200;

export interface Joined {
  secrets: Secrets;
  info: AccountInfo;
  lists: { counter: bigint; bytes: Uint8Array }[];
  phoneName: string;
}

export interface JoinDeps {
  origin: string;
  e2e: E2e;
  noise: Noise;
  open: OpenSocket;
  random(n: number): Uint8Array;
  log(msg: string): void;
  /** For tests: how long the code works, JOIN_MS otherwise. */
  joinMs?: number;
}

const sameDevice = (a: DeviceKeys, b: DeviceKeys) =>
  a.role === b.role && [a.signingKey, a.channelKey, a.boxKey, a.readOnlyKey, a.notificationKey].every((k, i) => {
    const o = [b.signingKey, b.channelKey, b.boxKey, b.readOnlyKey, b.notificationKey][i];
    return k.length === o.length && k.every((x, j) => x === o[j]);
  });

/** One join, from its code shown to the account it joined, or its failure. */
export class ComputerJoin {
  readonly text: string;
  readonly lookup: string;
  private readonly secret: Uint8Array;
  private readonly secrets = newSecrets();
  private readonly conn: HostedConnection;
  private readonly keys;
  private readonly self: DeviceKeys;
  private joinId = "";
  private handshake: Handshake | undefined;
  private transport: Transport | undefined;
  private step = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settle: { resolve(j: Joined): void; reject(e: Error): void } | undefined;
  private chain: Promise<void> = Promise.resolve();
  private over = false;
  readonly done: Promise<Joined>;

  constructor(private readonly d: JoinDeps) {
    this.secret = d.random(SECRET_BYTES);
    this.lookup = newLookup(d.random);
    this.text = joinText(this.lookup, this.secret);
    this.keys = keysOf(this.secrets, (s) => {
      const k = d.noise.staticKey(s);
      const p = k.publicKey;
      k.dispose();
      return p;
    });
    this.self = selfDevice(this.keys);
    this.done = new Promise<Joined>((resolve, reject) => (this.settle = { resolve, reject }));
    this.conn = new HostedConnection({
      origin: d.origin,
      accountId: new Uint8Array(0),
      signer: { publicKey: this.keys.signingKey, sign: async (m) => this.keys.sign(m) },
      open: d.open,
      onFrame: (f) => this.onFrame(f),
      onState: (s) => {
        if (this.over) return;
        if (s.kind === "ready") {
          // A connection lost after the phone paired loses the join.
          if (this.joinId) return this.fail("the connection to the relay was lost; run /pirc join again");
          this.send({ case: "joinWait", value: { lookup: this.lookup } });
        } else if (s.kind === "unsupported") this.fail(`the relay: ${s.reason}`);
      },
      onError: (where, e) => d.log(`join ${where}: ${(e as Error).message}`),
    });
  }

  /** Waits under the lookup; the code works for ten minutes. */
  start(): Promise<Joined> {
    this.timer = setTimeout(() => this.fail("the code expired after ten minutes; run /pirc join again"), this.d.joinMs ?? JOIN_MS);
    this.timer.unref?.();
    this.conn.start();
    return this.done;
  }

  cancel(): void {
    this.fail("cancelled");
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
    if (this.over) return;
    const b = f.body;
    switch (b.case) {
      case "error":
        return this.fail(`the relay: ${b.value.message || "refused the join"}`);
      case "joinPaired":
        if (this.joinId) return this.fail("the relay paired the join twice");
        this.joinId = b.value.joinId;
        this.handshake = this.d.noise.xxpsk3Responder({ staticKey: this.d.noise.staticKey(this.secrets.channel), prologue: joinPrologue(this.lookup), psk: this.secret });
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
    if (this.over) return;
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
      if (!r3.ok || !r3.transport) return this.fail("the code did not match: run /pirc join again");
      this.transport = r3.transport;
      this.handshake = undefined;
      const offer = makeOffer(this.self, this.transport.handshakeHash, (m) => this.keys.sign(m));
      const sent = this.transport.send(offer);
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
    const newest = this.d.e2e.checkList({ bytes: a.list, phoneKey: phone.signingKey, mode: "later", accountId, highest: 1n, self: this.self });
    if (newest.result !== "accepted") return `the list was refused (${newest.result === "refused" || newest.result === "unsupported" ? newest.reason : newest.result})`;
    const name = a.phoneName.length <= NAME_MAX_BYTES ? new TextDecoder("utf-8", { fatal: false }).decode(a.phoneName) : "";
    return {
      secrets: this.secrets,
      info: { accountId, phoneKey: phone.signingKey, origin: this.d.origin },
      lists: [{ counter: 1n, bytes: a.first }, { counter: newest.counter, bytes: a.list }],
      phoneName: name,
    };
  }
}

// Dark on light whatever the terminal's colours, from the 256-colour
// palette's fixed cube, as pirc-relay's codes are drawn.
const QR_COLOURS = "\x1b[38;5;16;48;5;231m";
const QR_RESET = "\x1b[0m";

/** The text as a QR code, two rows of modules to a line in half blocks, with the standard's quiet zone. */
export function qrLines(text: string): string[] {
  const { data } = encode(text, { ecc: "M", border: 4 });
  const lines: string[] = [];
  for (let y = 0; y < data.length; y += 2) {
    let line = "";
    for (let x = 0; x < data.length; x++) {
      const top = data[y][x];
      const bottom = y + 1 < data.length && data[y + 1][x];
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(QR_COLOURS + line + QR_RESET);
  }
  return lines;
}
