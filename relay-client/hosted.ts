// A device's connection to a hosted relay (relay.proto v1alpha2;
// docs/e2e.md, section 7): login with the account and the relay's origin
// signed, keepalive and reconnection. Nothing in it is Node's, so the
// extension, Node's tests and a browser share it; each gives the socket
// (hosted-ws.ts for Node, browserSocket for a page).
//
// A close never removes the device: 1008 means only that the relay refuses
// its key now. A refused login is tried again, slowly.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ErrorCode } from "@pirc/protocol";
import { FrameSchema, ProtocolVersion, type Frame, type Welcome } from "@pirc/protocol/v1alpha2";

/** An Ed25519 key that signs the login. */
export type Signer = { publicKey: Uint8Array; sign(message: Uint8Array): Promise<Uint8Array> };

/** The login signature's context (relay.proto, Auth). */
export const AUTH_CONTEXT = "pirc-auth-v1alpha2";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function leb128(n: number): number[] {
  const out: number[] = [];
  do {
    out.push(n < 128 ? n : (n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  } while (n > 0);
  return out;
}

/**
 * How the login string is built: the context's ASCII, a NUL byte, then
 * each part prefixed by its length as an unsigned LEB128.
 */
export function framed(context: string, ...parts: Uint8Array[]): Uint8Array {
  const out: number[] = [...utf8(context), 0];
  for (const p of parts) out.push(...leb128(p.length), ...p);
  return Uint8Array.from(out);
}
export const HOSTED_PATH = "/v1alpha2";

export interface SocketEvents {
  open(): void;
  message(data: Uint8Array): void;
  close(code: number, reason: string): void;
  error(message: string): void;
  pong(): void;
}

export interface Socket {
  send(data: Uint8Array): void;
  close(): void;
  readonly bufferedAmount: number;
  /** Absent where the platform cannot ping (a browser): the relay's pings keep it alive. */
  ping?(): void;
}

export type OpenSocket = (url: string, on: SocketEvents) => Socket;

/** A page's WebSocket. */
export const browserSocket: OpenSocket = (url, on) => {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => on.open();
  ws.onmessage = (e) => {
    if (typeof e.data === "string") on.error("relay sent a text frame");
    else on.message(new Uint8Array(e.data as ArrayBuffer));
  };
  ws.onclose = (e) => on.close(e.code, e.reason);
  ws.onerror = () => on.error("connection failed");
  return {
    send: (d) => ws.send(d as Uint8Array<ArrayBuffer>),
    close: () => ws.close(),
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
  };
};

/**
 * A hosted relay's origin as devices sign it: ws:// or wss://, a host,
 * and nothing after it.
 */
export function hostedOrigin(s: string): string {
  if (!URL.canParse(s)) throw new Error(`not a relay origin: ${s}`);
  const u = new URL(s);
  if ((u.protocol !== "ws:" && u.protocol !== "wss:") || !u.host || u.username || u.password || u.search || u.hash || (u.pathname !== "" && u.pathname !== "/")) {
    throw new Error(`a relay origin is ws:// or wss:// and a host, with nothing after it: ${s}`);
  }
  return `${u.protocol}//${u.host}`;
}

export type HostedState =
  | { kind: "connecting" }
  | { kind: "ready"; welcome: Welcome }
  // Will retry; `reason` says why it is not connected.
  | { kind: "offline"; reason: string }
  // Will retry, slowly: the relay refuses this key now, or for this
  // account.
  | { kind: "refused"; code: ErrorCode; reason: string }
  // Will not retry: the relay does not speak v1alpha2.
  | { kind: "unsupported"; reason: string }
  | { kind: "stopped" };

export interface HostedOptions {
  origin: string;
  /** Empty to log in without an account: to sign up, or to wait for a join. */
  accountId: Uint8Array;
  signer: Signer;
  open: OpenSocket;
  onFrame(f: Frame): void;
  onState?(s: HostedState): void;
  onError?(where: string, e: unknown): void;
  pingIntervalMs?: number;
  loginTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a refused login waits before trying again. */
  refusedRetryMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

export class HostedConnection {
  private socket: Socket | undefined;
  private state: HostedState = { kind: "stopped" };
  private stopped = true;
  private attempt = 0;
  private retryTimer: Timer | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private loginTimer: Timer | undefined;
  private accountId: Uint8Array;
  readonly origin: string;

  constructor(private readonly opts: HostedOptions) {
    this.origin = hostedOrigin(opts.origin);
    this.accountId = opts.accountId;
  }

  get current(): HostedState {
    return this.state;
  }

  get account(): Uint8Array {
    return this.accountId;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.teardown();
    this.setState({ kind: "stopped" });
  }

  /** Logs in again, to another account: after signing up, or joining. */
  switchAccount(accountId: Uint8Array): void {
    this.accountId = accountId;
    this.attempt = 0;
    clearTimeout(this.retryTimer);
    this.teardown();
    if (!this.stopped) this.connect();
  }

  /** Sends a frame if logged in; false when it could not be sent. */
  send(frame: Frame): boolean {
    const s = this.state;
    if (s.kind !== "ready" || !this.socket) return false;
    const bytes = toBinary(FrameSchema, frame);
    if (bytes.length > s.welcome.maxFrameBytes) return false;
    if (this.socket.bufferedAmount > 16 * s.welcome.maxFrameBytes) {
      this.retry("relay is not reading");
      return false;
    }
    this.socket.send(bytes);
    return true;
  }

  private call<A extends unknown[]>(where: string, fn: ((...a: A) => void) | undefined, ...args: A): void {
    try {
      fn?.(...args);
    } catch (e) {
      try {
        this.opts.onError?.(where, e);
      } catch {
        // Nowhere left to report it.
      }
    }
  }

  private setState(s: HostedState): void {
    this.state = s;
    this.call("onState", this.opts.onState?.bind(this.opts), s);
  }

  private teardown(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.loginTimer);
    const s = this.socket;
    this.socket = undefined;
    try {
      s?.close();
    } catch {
      // Closing a dead socket.
    }
  }

  private retry(reason: string, refused?: { code: ErrorCode }): void {
    this.teardown();
    if (this.stopped) return;
    this.setState(refused ? { kind: "refused", code: refused.code, reason } : { kind: "offline", reason });
    if (this.stopped) return;
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const backoff = Math.min(max, min * 2 ** this.attempt++);
    const wait = refused ? (this.opts.refusedRetryMs ?? 5 * 60_000) : backoff / 2 + Math.random() * (backoff / 2);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState({ kind: "connecting" });
    let phase: "hello" | "auth" | "ready" = "hello";
    let alive = true;
    const account = this.accountId;
    let socket: Socket | undefined = undefined;
    const mine = () => this.socket === socket && socket !== undefined;
    const events: SocketEvents = {
      open: () => {
        if (!mine()) return;
        this.write(create(FrameSchema, { body: { case: "hello", value: { protocolVersion: ProtocolVersion.V1ALPHA2, publicKey: this.opts.signer.publicKey, accountId: account } } }));
      },
      pong: () => (alive = true),
      message: (data) => {
        if (!mine()) return;
        let frame: Frame;
        try {
          frame = fromBinary(FrameSchema, data);
        } catch {
          return this.retry("relay sent an undecodable frame");
        }
        const body = frame.body;
        if (phase === "ready") return this.call("onFrame", this.opts.onFrame.bind(this.opts), frame);
        if (body.case === "error") {
          const { code, message } = body.value;
          if (code === ErrorCode.VERSION_UNSUPPORTED) {
            this.teardown();
            this.stopped = true;
            return this.setState({ kind: "unsupported", reason: message });
          }
          if (code === ErrorCode.UNAUTHENTICATED || code === ErrorCode.PERMISSION_DENIED) return this.retry(message, { code });
          return this.retry(message || "login failed");
        }
        if (phase === "hello" && body.case === "challenge") {
          phase = "auth";
          const signed = framed(AUTH_CONTEXT, account, utf8(this.origin), body.value.nonce);
          void this.opts.signer.sign(signed).then(
            (signature) => {
              if (mine()) this.write(create(FrameSchema, { body: { case: "auth", value: { signature } } }));
            },
            (e) => this.retry(`signing failed: ${(e as Error).message}`),
          );
          return;
        }
        if (phase === "auth" && body.case === "welcome") {
          phase = "ready";
          clearTimeout(this.loginTimer);
          this.attempt = 0;
          const s = socket!;
          if (s.ping) {
            this.pingTimer = setInterval(() => {
              if (!alive) return this.retry("relay stopped answering");
              alive = false;
              s.ping!();
            }, this.opts.pingIntervalMs ?? 25_000);
          }
          return this.setState({ kind: "ready", welcome: body.value });
        }
        this.retry(`unexpected ${body.case ?? "empty frame"} during login`);
      },
      close: (code, reason) => {
        if (!mine()) return;
        this.retry(`connection closed (${code}${reason ? ` ${reason}` : ""})`);
      },
      error: (message) => {
        if (!mine()) return;
        this.retry(message);
      },
    };
    try {
      socket = this.opts.open(this.origin + HOSTED_PATH, events);
    } catch (e) {
      return this.retry((e as Error).message);
    }
    this.socket = socket;
    this.loginTimer = setTimeout(() => {
      if (mine() && phase !== "ready") this.retry("relay did not finish the login in time");
    }, this.opts.loginTimeoutMs ?? 15_000);
  }

  private write(frame: Frame): void {
    try {
      this.socket?.send(toBinary(FrameSchema, frame));
    } catch (e) {
      this.retry((e as Error).message);
    }
  }
}
