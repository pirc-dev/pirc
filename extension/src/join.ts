// `/pirc join` (docs/e2e.md, section 6): this computer joins a hosted
// account as a computer, with keys made fresh for it, by the new device's
// side of a join that every device shares (relay-client/join.ts); and the
// code's QR, drawn for the terminal.
import type { E2e } from "@pirc/e2e";
import type { Noise, SodiumStaticKey } from "@pirc/e2e/noise";
import type { OpenSocket } from "@pirc/relay-client/hosted";
import { DeviceJoin } from "@pirc/relay-client/join";
import { encode } from "uqr";

import { keysOf, newSecrets, selfDevice, type AccountInfo, type Secrets } from "./account.ts";

export { JOIN_MS } from "@pirc/relay-client/join";

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
  /** The wall clock in milliseconds, Date.now by default. */
  now?(): number;
}

/** One join of this computer, as a computer, with keys made fresh for it. */
export class ComputerJoin {
  readonly text: string;
  readonly lookup: string;
  private readonly secrets = newSecrets();
  private readonly staticKey: SodiumStaticKey;
  private readonly join: DeviceJoin;

  constructor(private readonly d: JoinDeps) {
    const keys = keysOf(this.secrets, (s) => {
      const k = d.noise.staticKey(s);
      const p = k.publicKey;
      k.dispose();
      return p;
    });
    this.staticKey = d.noise.staticKey(this.secrets.channel);
    this.join = new DeviceJoin({ ...d, self: selfDevice(keys), staticKey: this.staticKey, sign: async (m) => keys.sign(m) });
    this.text = this.join.text;
    this.lookup = this.join.lookup;
  }

  /** Waits under the lookup; the code works for ten minutes. */
  async start(): Promise<Joined> {
    try {
      const j = await this.join.start();
      return { secrets: this.secrets, info: { accountId: j.accountId, phoneKey: j.phoneKey, origin: this.d.origin }, lists: j.lists, phoneName: j.phoneName };
    } catch (e) {
      throw new Error((e as Error).message.replace("start the join again", "run /pirc join again"));
    } finally {
      this.staticKey.dispose();
    }
  }

  cancel(): void {
    this.join.cancel();
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
