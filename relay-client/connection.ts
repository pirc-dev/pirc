// A peer's connection to the relay: login (relay.proto: Hello, Challenge,
// Auth, Welcome), keepalive and reconnection. Shared by the extension and
// the web app's server.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import WebSocket from "ws";

import { ErrorCode, FrameSchema, ProtocolVersion, Role, type Frame } from "@pirc/protocol";
import { signWith, type DeviceKey } from "./keys.ts";

// Prefixes the challenge nonce in the signed bytes (relay.proto, Auth).
const AUTH_CONTEXT = new TextEncoder().encode("pirc-auth-v1alpha1\0");

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "ready"; maxFrameBytes: number }
  // Will retry; `reason` says why it is not connected.
  | { kind: "offline"; reason: string }
  // Will retry: the relay holds this host's key for its operator to
  // approve (a host that connected without a token).
  | { kind: "pending"; reason: string }
  // Will not retry: the relay refused this key, and only the person can
  // fix that (enrol again, or the relay operator adds the key). `removed`
  // when it was connected and its key was removed from the relay.
  | { kind: "refused"; code: ErrorCode; reason: string; removed?: boolean }
  | { kind: "stopped" };

export interface ConnectionOptions {
  // The relay's WebSocket URL; a bare origin gets the protocol path.
  url: string;
  role: "host" | "client";
  key: DeviceKey;
  // A one-time registration token, for a key not yet registered.
  token?: string;
  // Whether a refused token earns one retry, for a host whose other process
  // redeemed it at the same moment; true unless false.
  tokenRetry?: boolean;
  label?: string;
  software: string;
  onFrame: (frame: Frame) => void;
  onState?: (state: ConnectionState) => void;
  // Called once logged in with the token, which the relay has then either
  // redeemed or found the key already registered.
  onRegistered?: () => void;
  // Gets the errors the callbacks above throw, which are caught so that
  // they never reach the process.
  onError?: (where: string, e: unknown) => void;
  pingIntervalMs?: number;
  // How often a key awaiting approval asks again.
  approvalRetryMs?: number;
  // A relay that has not finished the login in this time is given up on.
  loginTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

// The path a bare relay URL gets.
export const PROTOCOL_PATH = "/v1alpha1";

export function relayURL(url: string): string {
  if (!URL.canParse(url)) throw new Error(`not a relay URL: ${url}`);
  const u = new URL(url);
  if (u.protocol === "http:" || u.protocol === "https:") {
    const ws = u.protocol === "http:" ? "ws" : "wss";
    throw new Error(`relay URL must start with ws:// or wss://: ${url} (did you mean ${ws}://${url.slice(u.protocol.length + 2)}?)`);
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") {
    throw new Error(`relay URL must start with ws:// or wss://: ${url}`);
  }
  if (u.pathname === "" || u.pathname === "/") u.pathname = PROTOCOL_PATH;
  return u.toString();
}

// The relay's limit on labels and software strings (relay.proto, Hello).
const MAX_STRING_BYTES = 128;

// Cuts s to at most max bytes of UTF-8, on a character boundary.
export function cutUtf8(s: string, max = MAX_STRING_BYTES): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return s;
  let end = max;
  // Back up over continuation bytes to the start of a character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

// Login failures that retrying will not fix.
const REFUSALS = new Set([
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.PERMISSION_DENIED,
  ErrorCode.TOKEN_INVALID,
  ErrorCode.VERSION_UNSUPPORTED,
  ErrorCode.INVALID,
]);

export class RelayConnection {
  private ws: WebSocket | undefined;
  private state: ConnectionState = { kind: "stopped" };
  private stopped = true;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private loginTimer: NodeJS.Timeout | undefined;
  private token: string | undefined;
  // A token refused because another process of this host redeemed it at
  // the same moment, with the same key, earns one retry. The retry keeps
  // the token: the relay lets a registered key in whatever token it brings,
  // and refuses a wrong one again, which is then the answer. Without it, a
  // host's key alone would be held for approval instead.
  private tokenRetried = false;
  private readonly url: string;

  constructor(private readonly opts: ConnectionOptions) {
    this.url = relayURL(opts.url);
    this.token = opts.token;
  }

  get current(): ConnectionState {
    return this.state;
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

  // Sends a frame if logged in; false when it could not be sent.
  send(frame: Frame): boolean {
    if (this.state.kind !== "ready" || this.ws?.readyState !== WebSocket.OPEN) return false;
    const bytes = toBinary(FrameSchema, frame);
    if (bytes.length > this.state.maxFrameBytes) return false;
    // A relay that reads nothing while we keep writing would hold it all
    // in memory: start over, and let the peers catch up from History.
    if (this.ws.bufferedAmount > 16 * this.state.maxFrameBytes) {
      this.retry("relay is not reading");
      return false;
    }
    this.ws.send(bytes);
    return true;
  }

  // Runs one of the caller's callbacks, keeping its errors from us.
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

  private setState(s: ConnectionState): void {
    this.state = s;
    this.call("onState", this.opts.onState, s);
  }

  private teardown(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.loginTimer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.removeAllListeners();
      ws.on("error", () => {});
      ws.terminate();
    }
  }

  private retry(reason: string, delayMs?: number): void {
    this.teardown();
    if (this.stopped) return;
    this.setState({ kind: "offline", reason });
    // Its callback may have stopped it.
    if (this.stopped) return;
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    const backoff = Math.min(max, min * 2 ** this.attempt++);
    // Jitter, so a relay restart does not bring every host back at once.
    const wait = delayMs ?? backoff / 2 + Math.random() * (backoff / 2);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  // Asks again in a while, without backing off: approval comes from a
  // person, who expects it to work soon after.
  private await(reason: string): void {
    this.teardown();
    if (this.stopped) return;
    this.attempt = 0;
    this.setState({ kind: "pending", reason });
    this.retryTimer = setTimeout(() => this.connect(), this.opts.approvalRetryMs ?? 10_000);
  }

  private refuse(code: ErrorCode, reason: string, removed?: boolean): void {
    this.teardown();
    this.stopped = true;
    this.setState({ kind: "refused", code, reason, ...(removed && { removed }) });
  }

  private connect(): void {
    if (this.stopped) return;
    // Asking again while awaiting approval is not news.
    if (this.state.kind !== "pending") this.setState({ kind: "connecting" });
    const ws = new WebSocket(this.url, { handshakeTimeout: 10_000, perMessageDeflate: false });
    ws.binaryType = "nodebuffer";
    this.ws = ws;
    let phase: "hello" | "auth" | "ready" = "hello";
    let alive = true;
    // Covers the WebSocket handshake too, which has its own shorter limit.
    this.loginTimer = setTimeout(() => {
      if (this.ws === ws && phase !== "ready") this.retry("relay did not finish the login in time");
    }, this.opts.loginTimeoutMs ?? 15_000);

    ws.on("open", () => {
      const role = this.opts.role === "host" ? Role.HOST : Role.CLIENT;
      this.write(ws, create(FrameSchema, {
        body: {
          case: "hello",
          value: {
            protocolVersion: ProtocolVersion.V1ALPHA1,
            role,
            publicKey: this.opts.key.publicKey,
            registrationToken: this.token ?? "",
            label: cutUtf8(this.opts.label ?? ""),
            software: cutUtf8(this.opts.software),
          },
        },
      }));
    });
    ws.on("pong", () => (alive = true));
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return this.retry("relay sent a text frame");
      let frame: Frame;
      try {
        frame = fromBinary(FrameSchema, new Uint8Array(data));
      } catch {
        return this.retry("relay sent an undecodable frame");
      }
      const body = frame.body;
      if (phase !== "ready") {
        if (body.case === "error") {
          const { code, message } = body.value;
          if (code === ErrorCode.TOKEN_INVALID && this.token && !this.tokenRetried && this.opts.tokenRetry !== false) {
            this.tokenRetried = true;
            return this.retry("registration token refused; trying once more, in case this host's other process used it", 1000);
          }
          if (code === ErrorCode.APPROVAL_PENDING) return this.await(message);
          if (REFUSALS.has(code)) return this.refuse(code, message);
          return this.retry(message || "login failed");
        }
        if (phase === "hello" && body.case === "challenge") {
          phase = "auth";
          const signed = new Uint8Array(AUTH_CONTEXT.length + body.value.nonce.length);
          signed.set(AUTH_CONTEXT);
          signed.set(body.value.nonce, AUTH_CONTEXT.length);
          this.write(ws, create(FrameSchema, { body: { case: "auth", value: { signature: signWith(this.opts.key, signed) } } }));
          return;
        }
        if (phase === "auth" && body.case === "welcome") {
          phase = "ready";
          clearTimeout(this.loginTimer);
          this.attempt = 0;
          if (this.token) {
            this.token = undefined;
            this.call("onRegistered", this.opts.onRegistered);
          }
          // The relay pings us; we ping it, to notice a dead connection on
          // an idle host, where nothing else would be written.
          const every = this.opts.pingIntervalMs ?? 25_000;
          this.pingTimer = setInterval(() => {
            if (!alive) return this.retry("relay stopped answering");
            alive = false;
            ws.ping();
          }, every);
          this.setState({ kind: "ready", maxFrameBytes: body.value.maxFrameBytes });
          return;
        }
        return this.retry(`unexpected ${body.case ?? "empty frame"} during login`);
      }
      this.call("onFrame", this.opts.onFrame, frame);
    });
    ws.on("close", (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      // Asking again would only ask to join (relay.proto, Frame.error).
      if (phase === "ready" && code === 1008 && reason.toString() === "key revoked") {
        return this.refuse(ErrorCode.UNAUTHENTICATED, "this key was removed from the relay", true);
      }
      this.retry(`connection closed (${code}${reason.length ? ` ${reason}` : ""})`);
    });
    ws.on("error", (err: Error) => {
      if (this.ws !== ws) return;
      this.retry(err.message);
    });
  }

  private write(ws: WebSocket, frame: Frame): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(toBinary(FrameSchema, frame));
  }
}
