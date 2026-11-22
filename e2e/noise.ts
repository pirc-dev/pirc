// @pirc/e2e/noise: Noise for a channel (docs/e2e.md, section 4) and a
// join (section 6), so that a page without channels loads none of it.
//
//   - IK, with the prologue built here from the account ID: a client
//     initiates, knowing the computer's channel key from the list; a
//     computer responds.
//   - XXpsk3, with the caller's prologue and 32-byte PSK.
//
// Handshake messages carry no payload, so each has a fixed length: IK's
// are 96 and 48 bytes, XXpsk3's 48, 96 and 64. A handshake is async, since
// a browser's static key is a WebCrypto key (noise-webcrypto.ts); a
// transport is synchronous. No input bytes make anything throw: a failure
// is a result with its reason, length, dh, decrypt or dead, and the
// handshake or transport is dead after it, both directions of a transport
// alike. A caller's mistake throws, and kills the state too: a call out of
// order or while another is pending, a key or account ID of the wrong
// length, a plaintext over 65,519 bytes, an IK responder sending before
// the initiator's first message has decrypted, a counter at its cap.
//
// An IK responder's transport is unconfirmed until a message from the
// initiator decrypts, and sends nothing before: message 1 can be replayed,
// and anyone holding the computer's channel key can write one. Checking the
// initiator's key against the list is the caller's, after that first
// message. An XXpsk3 initiator's transport is unconfirmed until a message
// from the responder decrypts, since only that shows the responder holds
// the PSK; it may send meanwhile.
import sodium from "libsodium-wrappers-sumo";

import { isBytes } from "./bytes.ts";
import { framed, framedNumber } from "./framed.ts";
import { ROLE_CLIENT, ROLE_COMPUTER } from "./list.ts";
import { Handshake as Core, IK, KEY_BYTES, once, XXPSK3, type Failure, type HandshakeInit, type Reason, type StaticKey, type Transport as CoreTransport } from "./noise-core.ts";

export type { Failure, Reason, StaticKey };
export { webCryptoStaticKey } from "./noise-webcrypto.ts";

export const CHANNEL_CONTEXT = "pirc-e2e-v2 channel";
/** The channel's own version, apart from the relay's protocol. */
export const CHANNEL_VERSION = 1n;
export const ACCOUNT_ID_BYTES = 32;

/** IK's prologue: framed(context, the channel's version, account ID, the client's role, the computer's role). */
export function channelPrologue(accountId: Uint8Array): Uint8Array {
  if (!isBytes(accountId) || accountId.length !== ACCOUNT_ID_BYTES) throw new TypeError(`noise: the account ID is not ${ACCOUNT_ID_BYTES} bytes`);
  return framed(CHANNEL_CONTEXT, framedNumber(CHANNEL_VERSION), accountId, framedNumber(BigInt(ROLE_CLIENT)), framedNumber(BigInt(ROLE_COMPUTER)));
}

export interface Transport {
  /** The other side's static key; null once the transport is dead. */
  readonly remoteStatic: Uint8Array | null;
  readonly handshakeHash: Uint8Array;
  /** False at an IK responder and an XXpsk3 initiator until a message from the other side has decrypted. */
  readonly confirmed: boolean;
  send(plaintext: Uint8Array): { ok: true; message: Uint8Array } | Failure;
  receive(message: Uint8Array): { ok: true; plaintext: Uint8Array } | Failure;
  /** Zeroes both keys; every later call gives dead. */
  close(): void;
}

export interface Handshake {
  /** The next message, this side's turn; with the transport after the last. */
  writeMessage(): Promise<{ ok: true; message: Uint8Array; transport?: Transport } | Failure>;
  /** The other side's message; with the transport after the last. */
  readMessage(message: Uint8Array): Promise<{ ok: true; transport?: Transport } | Failure>;
  /** The other side's static key once a message has carried it, at an IK responder unconfirmed; null once dead. */
  readonly remoteStatic: Uint8Array | null;
}

/** A static key held in libsodium; dispose() zeroes its secret, and every DH after it fails. */
export interface SodiumStaticKey extends StaticKey {
  dispose(): void;
}

export interface Noise {
  /** A static key held in libsodium, from a copy of its 32-byte X25519 secret key. */
  staticKey(secretKey: Uint8Array): SodiumStaticKey;
  ikInitiator(o: { staticKey: StaticKey; responderKey: Uint8Array; accountId: Uint8Array }): Handshake;
  ikResponder(o: { staticKey: StaticKey; accountId: Uint8Array }): Handshake;
  xxpsk3Initiator(o: { staticKey: StaticKey; prologue: Uint8Array; psk: Uint8Array }): Handshake;
  xxpsk3Responder(o: { staticKey: StaticKey; prologue: Uint8Array; psk: Uint8Array }): Handshake;
}

/** The core's transport behind a frozen object: none of its state is reachable. */
function transportFacade(t: CoreTransport): Transport {
  return Object.freeze({
    get remoteStatic() {
      return t.remoteStatic;
    },
    get handshakeHash() {
      return t.handshakeHash;
    },
    get confirmed() {
      return t.confirmed;
    },
    send: (plaintext: Uint8Array) => t.send(plaintext),
    receive: (message: Uint8Array) => t.receive(message),
    close: () => t.close(),
  });
}

function facade(core: Core): Handshake {
  return Object.freeze({
    writeMessage: async () => {
      const r = await core.writeMessage();
      return r.ok ? { ok: true as const, message: r.message, ...(r.transport ? { transport: transportFacade(r.transport) } : {}) } : r;
    },
    readMessage: async (message: Uint8Array) => {
      const r = await core.readMessage(message);
      return r.ok ? { ok: true as const, ...(r.transport ? { transport: transportFacade(r.transport) } : {}) } : r;
    },
    get remoteStatic() {
      return core.remoteStatic;
    },
  });
}

function sodiumStaticKey(secretKey: Uint8Array): SodiumStaticKey {
  if (!isBytes(secretKey) || secretKey.length !== KEY_BYTES) throw new TypeError(`noise: the secret key is not ${KEY_BYTES} bytes`);
  const secret = new Uint8Array(secretKey);
  const publicKey = sodium.crypto_scalarmult_base(secret);
  let disposed = false;
  return Object.freeze({
    get publicKey() {
      return publicKey.slice();
    },
    // libsodium refuses a result of all zeros, and the handshake checks again.
    dh: async (theirPublic: Uint8Array) => {
      if (disposed) throw new Error("noise: the static key is disposed");
      return sodium.crypto_scalarmult(secret, theirPublic);
    },
    dispose: () => {
      disposed = true;
      sodium.memzero(secret);
    },
  });
}

/** The core's handshake for a side, with no payloads and a random ephemeral key. */
function handshakeFor(init: Omit<HandshakeInit, "payloads" | "ephemeral">): Core {
  // ephemeral set, so that one on Object.prototype is never read.
  return new Core(sodium, { ...init, ephemeral: undefined, payloads: false });
}

const noise: Noise = {
  staticKey: sodiumStaticKey,
  ikInitiator: ({ staticKey, responderKey, accountId }) => facade(handshakeFor({ pattern: IK, initiator: true, staticKey, remoteStatic: responderKey, prologue: channelPrologue(accountId) })),
  ikResponder: ({ staticKey, accountId }) => facade(handshakeFor({ pattern: IK, initiator: false, staticKey, prologue: channelPrologue(accountId) })),
  xxpsk3Initiator: ({ staticKey, prologue, psk }) => facade(handshakeFor({ pattern: XXPSK3, initiator: true, staticKey, prologue, psk })),
  xxpsk3Responder: ({ staticKey, prologue, psk }) => facade(handshakeFor({ pattern: XXPSK3, initiator: false, staticKey, prologue, psk })),
};
Object.freeze(noise);

/** Noise, once libsodium has started. If the start fails, the next call tries again. */
export const load: () => Promise<Noise> = once(() => sodium.ready.then(() => noise));
