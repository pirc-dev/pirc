// A passkey authenticator in software, for tests: makes the registration
// and sign-in responses a browser would, with an ES256 key, "none"
// attestation and user verification, as Face ID or Touch ID gives.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// Just enough CBOR for an attestation object and a COSE key.
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    throw new Error("too long");
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: ${typeof v}`);
}

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly cose: Buffer;
  private counter = 0;
  userHandle = "";

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.cose = cbor(new Map<number, unknown>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]));
  }

  private authData(rpId: string, attested: boolean): Buffer {
    // User present, user verified, and with the credential when made.
    const flags = 0x01 | 0x04 | (attested ? 0x40 : 0);
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha256(rpId), Buffer.from([flags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, this.cose);
    }
    return Buffer.concat(parts);
  }

  // What navigator.credentials.create gives, from the server's options.
  register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string) {
    this.userHandle = options.user.id;
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const attestation = cbor(new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", this.authData(options.rp.id!, true)],
    ]));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestation), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  // What navigator.credentials.get gives, from the server's options.
  authenticate(options: { challenge: string; rpId?: string }, origin: string) {
    this.counter++;
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const auth = this.authData(options.rpId!, false);
    const signature = sign("sha256", Buffer.concat([auth, sha256(clientData)]), this.key);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(auth), signature: b64url(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
    };
  }
}
