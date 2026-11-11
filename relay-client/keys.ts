// A device's Ed25519 key, kept in one PKCS #8 PEM file (docs/design.md,
// section 4: "stored at a configurable path and written once, atomically").
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DeviceKey {
  privateKey: KeyObject;
  // The raw 32-byte public key, as the relay knows it.
  publicKey: Uint8Array;
}

function fromPem(pem: string): DeviceKey {
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("not an Ed25519 key");
  }
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return { privateKey, publicKey: new Uint8Array(Buffer.from(jwk.x!, "base64url")) };
}

// Reads the key at path, or creates it if there is none. Creation is
// exclusive, so processes starting together end up with the same key.
export function loadOrCreateKey(path: string): DeviceKey {
  try {
    return fromPem(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  // Written aside, then linked into place: the link fails if another
  // process got there first, and nobody ever reads a half-written file.
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, pem, { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return fromPem(readFileSync(path, "utf8"));
  } finally {
    unlinkSync(tmp);
  }
  return fromPem(pem);
}

export function signWith(key: DeviceKey, data: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, data, key.privateKey));
}
