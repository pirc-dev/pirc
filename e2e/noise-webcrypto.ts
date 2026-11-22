// A Noise static key held in WebCrypto (docs/e2e.md, section 2): a
// browser's X25519 channel key, whose private half cannot be exported. It
// loads no libsodium.
//
// dh() imports the peer's key raw and derives 256 bits. An engine may
// reject a low-order peer key or give zeros for it; either way dh()
// rejects, and the handshake fails with reason dh, as it does for a key
// gone for a local reason. Where it meets a low-order point:
//   - an IK or XXpsk3 initiator, and an XXpsk3 responder: never. Each DH
//     with this key (IK's ss and se; XXpsk3's se, and the responder's es)
//     follows libsodium's ephemeral DH with the same remote key, which
//     refuses a low-order one.
//   - an IK responder: es uses the initiator's e as received, and ss the
//     initiator's s as decrypted, before any ephemeral DH with them. There a
//     low-order point rests on the engine refusing it, or on the
//     handshake's own check for zeros.
// A non-canonical key, which only the relay or a listed computer could
// send, is left to the engine. The handshake zeroes the bits returned; any
// copy inside the engine is out of reach.
import type { StaticKey } from "./noise-core.ts";

const KEY_BYTES = 32;

/** A static key from a WebCrypto X25519 key pair; the public key is read once, raw. */
export async function webCryptoStaticKey(keys: CryptoKeyPair, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<StaticKey> {
  const publicKey = new Uint8Array(await subtle.exportKey("raw", keys.publicKey));
  if (publicKey.length !== KEY_BYTES) throw new TypeError(`noise: the public key is not ${KEY_BYTES} bytes`);
  const { privateKey } = keys;
  return Object.freeze({
    get publicKey() {
      return publicKey.slice();
    },
    async dh(theirPublic: Uint8Array): Promise<Uint8Array> {
      const peer = await subtle.importKey("raw", theirPublic as Uint8Array<ArrayBuffer>, { name: "X25519" }, false, []);
      const out = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peer }, privateKey, 256));
      let d = 0;
      for (const x of out) d |= x;
      if (out.length !== KEY_BYTES || d === 0) throw new Error("noise: X25519 gave no shared secret");
      return out;
    },
  });
}
