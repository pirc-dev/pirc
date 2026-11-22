// Noise, revision 34, with nothing added (docs/e2e.md, sections 4 and 6):
// the cipher state, the symmetric state and a handshake driven by a
// pattern's tokens, over libsodium, for Noise_IK_25519_ChaChaPoly_SHA512
// and Noise_XXpsk3_25519_ChaChaPoly_SHA512.
//
// This module is internal: @pirc/e2e/noise (noise.ts) is the public entry.
// The tests reach it to inject ephemeral keys, to give handshake messages
// payloads (the published vectors have them) and to set a counter.
//
// No input bytes make anything throw: a failure is a result with a reason,
// and the handshake or transport is dead after it. Only a caller's mistake
// throws, and a throw kills the state too. A handshake awaits only a static
// key's DH; a call killed while it waits, by a call made meanwhile, gives
// dead, and any transport it had built is closed.
//
// Secrets this code owns (ephemeral secret keys, the chaining key, DH
// outputs, cipher keys, the PSK's copy) are zeroed with memzero when a
// handshake finishes or dies and when a transport is closed or dies.
// Copies made inside libsodium.js's wasm heap, or by a browser engine's
// deriveBits, cannot be reached from here.
import type sodiumType from "libsodium-wrappers-sumo";

import { isBytes } from "./bytes.ts";

type Sodium = typeof sodiumType;

/** Why a call failed. */
export type Reason = "length" | "dh" | "decrypt" | "dead";
export interface Failure {
  ok: false;
  reason: Reason;
}

/**
 * An X25519 static key. dh() gives the 32-byte shared secret with a peer's
 * public key, which it is given as a copy; a rejection, or a result that is
 * not 32 bytes or is all zeros, fails the handshake with reason dh.
 */
export interface StaticKey {
  readonly publicKey: Uint8Array;
  dh(theirPublic: Uint8Array): Promise<Uint8Array>;
}

export const MAX_MESSAGE = 65_535;
export const TAG_BYTES = 16;
export const MAX_PLAINTEXT = MAX_MESSAGE - TAG_BYTES;
export const KEY_BYTES = 32;
const HASH_BYTES = 64;
/** The first counter value never used: a call that would use it throws. */
export const NONCE_CAP = (1n << 63n) - 1n;

const EMPTY = new Uint8Array(0);
const DEAD: Failure = Object.freeze({ ok: false, reason: "dead" });

type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";

export interface Pattern {
  readonly name: string;
  /** IK's pre-message: the initiator knows the responder's static key. */
  readonly responderKnown: boolean;
  /** Whether e MixKeys too (section 9.2). */
  readonly psk: boolean;
  /** The messages' tokens; the initiator writes the first. */
  readonly messages: readonly (readonly Token[])[];
}

export const IK: Pattern = Object.freeze({
  name: "Noise_IK_25519_ChaChaPoly_SHA512",
  responderKnown: true,
  psk: false,
  messages: Object.freeze([Object.freeze(["e", "es", "s", "ss"] as Token[]), Object.freeze(["e", "ee", "se"] as Token[])]),
});

export const XXPSK3: Pattern = Object.freeze({
  name: "Noise_XXpsk3_25519_ChaChaPoly_SHA512",
  responderKnown: false,
  psk: true,
  messages: Object.freeze([Object.freeze(["e"] as Token[]), Object.freeze(["e", "ee", "s", "es"] as Token[]), Object.freeze(["s", "se", "psk"] as Token[])]),
});

const failure = (reason: Reason): Failure => ({ ok: false, reason });

function isZero(b: Uint8Array): boolean {
  let d = 0;
  for (const x of b) d |= x;
  return d === 0;
}

/** The 12-byte nonce: 4 zero bytes, then the counter as 8 bytes little-endian. */
export function nonceBytes(n: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, n, true);
  return out;
}

/**
 * ChaCha20-Poly1305 IETF with a key and a counter. In IK and XXpsk3 every
 * encryption comes after a key is mixed in (in XXpsk3, by e), so a cipher
 * without a key is never used.
 */
export class CipherState {
  k: Uint8Array | null = null;
  n = 0n;

  constructor(private readonly sodium: Sodium) {}

  setKey(k: Uint8Array): void {
    this.wipe();
    this.k = k;
    this.n = 0n;
  }

  /** The key and the nonce for this use; throws at the cap. */
  private use(): [Uint8Array, Uint8Array] {
    if (this.n >= NONCE_CAP) throw new RangeError("noise: the counter is at its cap");
    return [this.k!, nonceBytes(this.n)];
  }

  encrypt(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    const [k, nonce] = this.use();
    const out = this.sodium.crypto_aead_chacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, k);
    this.n++;
    return out;
  }

  /** The plaintext, or null when the tag does not verify. */
  decrypt(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array | null {
    const [k, nonce] = this.use();
    let out: Uint8Array;
    try {
      out = this.sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, ciphertext, ad, nonce, k);
    } catch {
      return null;
    }
    this.n++;
    return out;
  }

  wipe(): void {
    if (this.k) this.sodium.memzero(this.k);
  }
}

/** The chaining key, the hash and the cipher state of a handshake. */
export class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  readonly cipher: CipherState;

  constructor(private readonly sodium: Sodium, protocolName: string) {
    // Both names are under 64 bytes: h starts as the name, zero-padded.
    const name = new TextEncoder().encode(protocolName);
    this.h = new Uint8Array(HASH_BYTES);
    this.h.set(name);
    this.ck = this.h.slice();
    this.cipher = new CipherState(sodium);
  }

  private hmac(key: Uint8Array, ...data: Uint8Array[]): Uint8Array {
    // The 64-byte key whole: crypto_auth_hmacsha512 would truncate it.
    const state = this.sodium.crypto_auth_hmacsha512_init(key);
    for (const d of data) this.sodium.crypto_auth_hmacsha512_update(state, d);
    return this.sodium.crypto_auth_hmacsha512_final(state);
  }

  /** HKDF as the specification's, with two or three outputs. */
  hkdf(ikm: Uint8Array, outputs: 2 | 3): Uint8Array[] {
    const temp = this.hmac(this.ck, ikm);
    const out = [this.hmac(temp, Uint8Array.of(1))];
    out.push(this.hmac(temp, out[0], Uint8Array.of(2)));
    if (outputs === 3) out.push(this.hmac(temp, out[1], Uint8Array.of(3)));
    this.sodium.memzero(temp);
    return out;
  }

  private takeCk(next: Uint8Array): void {
    this.sodium.memzero(this.ck);
    this.ck = next;
  }

  /** The first 32 bytes of a 64-byte output, the output zeroed. */
  private cut(full: Uint8Array): Uint8Array {
    const k = full.slice(0, KEY_BYTES);
    this.sodium.memzero(full);
    return k;
  }

  mixHash(data: Uint8Array): void {
    const both = new Uint8Array(HASH_BYTES + data.length);
    both.set(this.h);
    both.set(data, HASH_BYTES);
    this.h = this.sodium.crypto_hash_sha512(both);
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = this.hkdf(ikm, 2);
    this.takeCk(ck);
    this.cipher.setKey(this.cut(tempK));
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = this.hkdf(ikm, 3);
    this.takeCk(ck);
    this.mixHash(tempH);
    this.sodium.memzero(tempH);
    this.cipher.setKey(this.cut(tempK));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const c = this.cipher.encrypt(this.h, plaintext);
    this.mixHash(c);
    return c;
  }

  /** The plaintext, or null; a failure kills the handshake, so h after one is never used. */
  decryptAndHash(ciphertext: Uint8Array): Uint8Array | null {
    const p = this.cipher.decrypt(this.h, ciphertext);
    this.mixHash(ciphertext);
    return p;
  }

  /** The two cipher keys: the initiator's sending key first. */
  split(): [Uint8Array, Uint8Array] {
    const [a, b] = this.hkdf(EMPTY, 2);
    return [this.cut(a), this.cut(b)];
  }

  wipe(): void {
    this.sodium.memzero(this.ck);
    this.cipher.wipe();
  }
}

/** Both directions of a channel after its handshake. Synchronous. */
export class Transport {
  dead = false;
  readonly sendCipher: CipherState;
  readonly receiveCipher: CipherState;
  private confirmed_: boolean;
  private readonly gated: boolean;
  private readonly remote: Uint8Array;
  private readonly hash: Uint8Array;

  /**
   * confirmed: whether the other side has already shown it holds its keys.
   * gated: whether sending waits for that (an IK responder's).
   */
  constructor(sodium: Sodium, sendKey: Uint8Array, receiveKey: Uint8Array, remoteStatic: Uint8Array, handshakeHash: Uint8Array, confirmed: boolean, gated: boolean) {
    this.sendCipher = new CipherState(sodium);
    this.sendCipher.setKey(sendKey);
    this.receiveCipher = new CipherState(sodium);
    this.receiveCipher.setKey(receiveKey);
    this.remote = remoteStatic;
    this.hash = handshakeHash;
    this.confirmed_ = confirmed;
    this.gated = gated;
  }

  /** The other side's static key; null once the transport is dead. */
  get remoteStatic(): Uint8Array | null {
    return this.dead ? null : this.remote.slice();
  }

  get handshakeHash(): Uint8Array {
    return this.hash.slice();
  }

  /**
   * Whether the other side has shown it holds its keys: at an IK responder
   * (the initiator's static key) and an XXpsk3 initiator (the PSK) only once
   * a message from the other side has decrypted; at once otherwise.
   */
  get confirmed(): boolean {
    return this.confirmed_;
  }

  private mistake(what: string): never {
    this.die();
    throw new TypeError(`noise: ${what}`);
  }

  send(plaintext: Uint8Array): { ok: true; message: Uint8Array } | Failure {
    if (this.dead) return DEAD;
    if (!isBytes(plaintext)) this.mistake("plaintext is not bytes");
    if (this.gated && !this.confirmed_) this.mistake("sending before the initiator's first message");
    if (plaintext.length > MAX_PLAINTEXT) this.mistake(`plaintext of ${plaintext.length} bytes, over ${MAX_PLAINTEXT}`);
    try {
      return { ok: true, message: this.sendCipher.encrypt(EMPTY, new Uint8Array(plaintext)) };
    } catch (e) {
      this.die();
      throw e;
    }
  }

  receive(message: Uint8Array): { ok: true; plaintext: Uint8Array } | Failure {
    if (this.dead) return DEAD;
    if (!isBytes(message)) this.mistake("message is not bytes");
    if (message.length < TAG_BYTES || message.length > MAX_MESSAGE) {
      this.die();
      return failure("length");
    }
    let plaintext: Uint8Array | null;
    try {
      plaintext = this.receiveCipher.decrypt(EMPTY, new Uint8Array(message));
    } catch (e) {
      this.die();
      throw e;
    }
    if (plaintext === null) {
      this.die();
      return failure("decrypt");
    }
    this.confirmed_ = true;
    return { ok: true, plaintext };
  }

  /** Zeroes both keys; every later call gives dead. */
  close(): void {
    this.die();
  }

  private die(): void {
    this.dead = true;
    this.sendCipher.wipe();
    this.receiveCipher.wipe();
  }
}

export interface HandshakeInit {
  pattern: Pattern;
  initiator: boolean;
  staticKey: StaticKey;
  /** The responder's static key, which an IK initiator knows. */
  remoteStatic?: Uint8Array;
  prologue: Uint8Array;
  /** XXpsk3's 32-byte pre-shared key. */
  psk?: Uint8Array;
  /** The ephemeral secret key; random when absent. Tests only. */
  ephemeral?: Uint8Array;
  /**
   * Whether handshake messages may carry payloads. PiRC's never do, so each
   * message has a fixed length; the published vectors' do.
   */
  payloads: boolean;
}

export type WriteResult = { ok: true; message: Uint8Array; transport?: Transport } | Failure;
export type ReadResult = { ok: true; payload: Uint8Array; transport?: Transport } | Failure;

function checkKey(k: unknown, what: string): Uint8Array {
  if (!isBytes(k) || k.length !== KEY_BYTES) throw new TypeError(`noise: ${what} is not ${KEY_BYTES} bytes`);
  // A copy made here: of this realm, whatever the caller's array's realm or slice().
  return new Uint8Array(k);
}

export class Handshake {
  dead = false;
  private pending = false;
  private index = 0;
  readonly symmetric: SymmetricState;
  readonly pattern: Pattern;
  readonly initiator: boolean;
  private readonly sodium: Sodium;
  private readonly staticKey: StaticKey;
  private readonly staticPublic: Uint8Array;
  private readonly payloads: boolean;
  readonly psk: Uint8Array | null;
  /** The ephemeral secret key, until the handshake ends. */
  eSecret: Uint8Array | null = null;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null;

  constructor(sodium: Sodium, init: HandshakeInit) {
    const { pattern } = init;
    this.sodium = sodium;
    this.pattern = pattern;
    this.initiator = init.initiator;
    this.payloads = init.payloads;
    const sk = init.staticKey;
    if (typeof sk !== "object" || sk === null || typeof sk.dh !== "function") throw new TypeError("noise: staticKey has no dh()");
    this.staticKey = sk;
    this.staticPublic = checkKey(sk.publicKey, "the static public key");
    if (!isBytes(init.prologue)) throw new TypeError("noise: prologue is not bytes");
    const knowsRemote = pattern.responderKnown && this.initiator;
    if (knowsRemote) this.rs = checkKey(init.remoteStatic, "the responder's static key");
    else if (init.remoteStatic !== undefined) throw new TypeError("noise: a remote static key this side cannot know");
    else this.rs = null;
    if (pattern.psk) this.psk = checkKey(init.psk, "the PSK");
    else if (init.psk !== undefined) throw new TypeError("noise: a PSK for a pattern without one");
    else this.psk = null;
    if (init.ephemeral !== undefined) this.eSecret = checkKey(init.ephemeral, "the ephemeral secret key");

    this.symmetric = new SymmetricState(sodium, pattern.name);
    // mixHash copies the prologue in with set(), whatever its realm.
    this.symmetric.mixHash(init.prologue);
    if (pattern.responderKnown) this.symmetric.mixHash(this.initiator ? this.rs! : this.staticPublic);
  }

  /**
   * The other side's static key once a message has carried it (at an IK
   * responder, not yet confirmed); null while unknown and once dead.
   */
  get remoteStatic(): Uint8Array | null {
    return this.rs && !this.dead ? this.rs.slice() : null;
  }

  writeMessage(payload: Uint8Array = EMPTY): Promise<WriteResult> {
    return this.call(true, () => this.write(payload));
  }

  readMessage(message: Uint8Array): Promise<ReadResult> {
    return this.call(false, () => this.read(message));
  }

  private async call<T extends { ok: boolean }>(writing: boolean, body: () => Promise<T | Failure>): Promise<T | Failure> {
    if (this.dead) return DEAD;
    if (this.pending) this.mistake("a call while another is pending");
    if (this.index >= this.pattern.messages.length) this.mistake("the handshake is over");
    const mine = (this.index % 2 === 0) === this.initiator;
    if (mine !== writing) this.mistake(writing ? "writing out of turn" : "reading out of turn");
    this.pending = true;
    try {
      const r = await body();
      if (this.dead) {
        // Killed while this call waited: what it built is not handed out.
        if (r.ok) (r as { transport?: Transport }).transport?.close();
        return DEAD;
      }
      if (!r.ok) this.die();
      return r;
    } catch (e) {
      this.die();
      throw e;
    } finally {
      this.pending = false;
    }
  }

  private mistake(what: string): never {
    this.die();
    throw new TypeError(`noise: ${what}`);
  }

  /**
   * A message's length without its payload: 32 bytes for e, 48 for s (its
   * tag: a key is always mixed in before it), and the payload's tag.
   */
  private fixedLength(tokens: readonly Token[]): number {
    let n = TAG_BYTES;
    for (const t of tokens) n += t === "e" ? KEY_BYTES : t === "s" ? KEY_BYTES + TAG_BYTES : 0;
    return n;
  }

  /** The keys a DH token uses: whether the local one is the static key, and the remote one. */
  private dhKeys(token: Token): { local: "e" | "s"; remote: Uint8Array } {
    const i = this.initiator;
    const local = token === "ee" || (token === "es" && i) || (token === "se" && !i) ? "e" : "s";
    const remote = token === "ee" || (token === "es" && !i) || (token === "se" && i) ? this.re! : this.rs!;
    return { local, remote };
  }

  /** A DH with the ephemeral key, synchronous: the shared secret mixed into the key, or a failure. */
  private dhEphemeral(remote: Uint8Array): Failure | null {
    let out: Uint8Array;
    try {
      out = this.sodium.crypto_scalarmult(this.eSecret!, remote);
    } catch {
      return failure("dh");
    }
    if (isZero(out)) return failure("dh");
    this.symmetric.mixKey(out);
    this.sodium.memzero(out);
    return null;
  }

  /**
   * A DH with the static key, awaited; its output zeroed on every path. If
   * the handshake died meanwhile, nothing more is done, and call() gives
   * dead whatever this returns.
   */
  private async dhStatic(remote: Uint8Array): Promise<Failure | null> {
    let got: unknown;
    try {
      got = await this.staticKey.dh(remote.slice());
    } catch {
      return failure("dh");
    }
    // A copy of this realm, which libsodium takes; the key's own array zeroed.
    const out = isBytes(got) ? new Uint8Array(got) : null;
    if (isBytes(got)) got.fill(0);
    if (this.dead || out === null || out.length !== KEY_BYTES || isZero(out)) {
      if (out !== null) this.sodium.memzero(out);
      return failure("dh");
    }
    this.symmetric.mixKey(out);
    this.sodium.memzero(out);
    return null;
  }

  private ephemeral(): Uint8Array {
    this.eSecret ??= this.sodium.randombytes_buf(KEY_BYTES);
    return this.sodium.crypto_scalarmult_base(this.eSecret);
  }

  private async write(given: Uint8Array): Promise<WriteResult> {
    if (!isBytes(given)) this.mistake("payload is not bytes");
    const payload = new Uint8Array(given);
    if (payload.length > 0 && !this.payloads) this.mistake("a handshake payload");
    const tokens = this.pattern.messages[this.index];
    if (this.fixedLength(tokens) + payload.length > MAX_MESSAGE) this.mistake("payload too long");
    const s = this.symmetric;
    const out: Uint8Array[] = [];
    for (const t of tokens) {
      if (t === "e") {
        const e = this.ephemeral();
        out.push(e.slice());
        s.mixHash(e);
        if (this.pattern.psk) s.mixKey(e);
      } else if (t === "s") out.push(s.encryptAndHash(this.staticPublic));
      else if (t === "psk") s.mixKeyAndHash(this.psk!);
      else {
        const { local, remote } = this.dhKeys(t);
        const f = local === "e" ? this.dhEphemeral(remote) : await this.dhStatic(remote);
        if (f) return f;
      }
    }
    out.push(s.encryptAndHash(payload));
    const message = new Uint8Array(out.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of out) {
      message.set(p, at);
      at += p.length;
    }
    this.index++;
    return { ok: true, message, ...this.finish() };
  }

  private async read(given: Uint8Array): Promise<ReadResult> {
    if (!isBytes(given)) this.mistake("message is not bytes");
    // A copy of this realm, so that libsodium takes it and a caller's buffer
    // changed during an await is not read.
    const message = new Uint8Array(given);
    const tokens = this.pattern.messages[this.index];
    const fixed = this.fixedLength(tokens);
    if (message.length > MAX_MESSAGE || (this.payloads ? message.length < fixed : message.length !== fixed)) return failure("length");
    const s = this.symmetric;
    let at = 0;
    for (const t of tokens) {
      if (t === "e") {
        this.re = message.slice(at, at + KEY_BYTES);
        at += KEY_BYTES;
        s.mixHash(this.re);
        if (this.pattern.psk) s.mixKey(this.re);
      } else if (t === "s") {
        const rs = s.decryptAndHash(message.subarray(at, at + KEY_BYTES + TAG_BYTES));
        if (rs === null) return failure("decrypt");
        this.rs = rs;
        at += KEY_BYTES + TAG_BYTES;
      } else if (t === "psk") s.mixKeyAndHash(this.psk!);
      else {
        const { local, remote } = this.dhKeys(t);
        const f = local === "e" ? this.dhEphemeral(remote) : await this.dhStatic(remote);
        if (f) return f;
      }
    }
    const payload = s.decryptAndHash(message.subarray(at));
    if (payload === null) return failure("decrypt");
    this.index++;
    return { ok: true, payload, ...this.finish() };
  }

  /** After the last message: the transport, and every secret of the handshake zeroed. */
  private finish(): { transport?: Transport } {
    if (this.index < this.pattern.messages.length) return {};
    const [first, second] = this.symmetric.split();
    const hash = this.symmetric.h.slice();
    // IK's responder waits for the initiator's static key to be shown, and
    // XXpsk3's initiator for the PSK; only the first may not send meanwhile.
    const ikResponder = this.pattern.responderKnown && !this.initiator;
    const xxInitiator = this.pattern.psk && this.initiator;
    const confirmed = !ikResponder && !xxInitiator;
    // rs is never written after it is set, and both hand out only copies.
    const transport = this.initiator
      ? new Transport(this.sodium, first, second, this.rs!, hash, confirmed, ikResponder)
      : new Transport(this.sodium, second, first, this.rs!, hash, confirmed, ikResponder);
    this.wipe();
    return { transport };
  }

  private die(): void {
    this.dead = true;
    this.wipe();
  }

  private wipe(): void {
    this.symmetric.wipe();
    if (this.eSecret) this.sodium.memzero(this.eSecret);
    if (this.psk) this.sodium.memzero(this.psk);
  }
}

/**
 * A start that runs once: every call gives the same promise, and after a
 * failure the next call starts again.
 */
export function once<T>(start: () => Promise<T>): () => Promise<T> {
  let started: Promise<T> | undefined;
  return () => {
    started ??= start().catch((e: unknown) => {
      started = undefined;
      throw e;
    });
    return started;
  };
}
