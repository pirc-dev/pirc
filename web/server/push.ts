// Web push (docs/web.md, section 6): the server's own key (VAPID, RFC
// 8292), the browsers' subscriptions, and a message to one of them,
// encrypted for that browser alone (RFC 8291) and sent through its
// vendor's push service (RFC 8030), which sees only ciphertext.
//
// The key and the subscriptions are in push.json, in the data directory.
// A subscription belongs to the passkey that signed in when it was made:
// revoking the passkey stops its devices' notifications.
import { createCipheriv, createECDH, createHash, createPrivateKey, hkdfSync, randomBytes, sign } from "node:crypto";

import { readJson, writeJson } from "@pirc/relay-client/service";

// A browser's subscription, as PushSubscription.toJSON() gives it.
export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredSubscription extends Subscription {
  passkeyId: string;
  createdAt: string;
}

interface PushFile {
  // P-256, base64url: the public key uncompressed, the private one raw.
  publicKey: string;
  privateKey: string;
  subscriptions: StoredSubscription[];
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

// Why a subscription cannot be taken, if so. Push services are https;
// plain http is for a server that is itself on plain http (testing).
export function badSubscription(v: unknown, plainHttp: boolean): string | undefined {
  const s = v as Partial<Subscription> | undefined;
  if (typeof s?.endpoint !== "string" || !URL.canParse(s.endpoint)) return "no endpoint";
  const proto = new URL(s.endpoint).protocol;
  if (proto !== "https:" && !(plainHttp && proto === "http:")) return "the endpoint must be https";
  if (typeof s.keys?.p256dh !== "string" || unb64(s.keys.p256dh).length !== 65) return "no browser key";
  if (typeof s.keys.auth !== "string" || unb64(s.keys.auth).length !== 16) return "no authentication secret";
  return undefined;
}

// push.json, made with a new key the first time.
export class PushStore {
  constructor(readonly path: string) {}

  private load(): PushFile {
    const f = readJson<PushFile>(this.path);
    if (f) return f;
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const made = { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()), subscriptions: [] };
    writeJson(this.path, made);
    return made;
  }

  // What the page subscribes with (applicationServerKey).
  publicKey(): string {
    return this.load().publicKey;
  }

  keys(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = this.load();
    return { publicKey, privateKey };
  }

  subscriptions(): StoredSubscription[] {
    return this.load().subscriptions;
  }

  // Added, or renewed for its endpoint.
  add(s: Subscription, passkeyId: string, now = new Date()): void {
    const f = this.load();
    const kept = f.subscriptions.filter((x) => x.endpoint !== s.endpoint);
    kept.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, passkeyId, createdAt: now.toISOString() });
    writeJson(this.path, { ...f, subscriptions: kept });
  }

  remove(endpoint: string): boolean {
    const f = this.load();
    const kept = f.subscriptions.filter((x) => x.endpoint !== endpoint);
    if (kept.length === f.subscriptions.length) return false;
    writeJson(this.path, { ...f, subscriptions: kept });
    return true;
  }
}

// The message for one browser (RFC 8291, aes128gcm of RFC 8188): a header
// with a fresh salt and key of the server's, then the payload in one
// record. The salt and the server's key are given only by tests.
export function encrypt(payload: Uint8Array, to: Subscription["keys"], salt = randomBytes(16), asPrivate?: Buffer): Buffer {
  const uaPublic = unb64(to.p256dh);
  const from = createECDH("prime256v1");
  if (asPrivate) from.setPrivateKey(asPrivate);
  else from.generateKeys();
  const asPublic = from.getPublicKey();
  const secret = from.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, unb64(to.auth), keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The last record's delimiter, and no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// The Authorization header for a push service (RFC 8292): a token for
// its origin, valid for 12 hours, signed with the server's key. subject is
// how the push service can reach whoever runs the server: the app's
// address.
export function vapid(endpoint: string, keys: { publicKey: string; privateKey: string }, subject: string, now = Date.now()): string {
  const pub = unb64(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) },
    format: "jwk",
  });
  const part = (o: object) => b64(Buffer.from(JSON.stringify(o)));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

export interface PushOptions {
  // How long the push service keeps it for a browser that is offline.
  ttlSeconds: number;
  // A later message with the same topic replaces one not yet delivered.
  topic?: string;
}

// A topic as push services take it: at most 32 base64url characters.
export function topicOf(s: string): string {
  return b64(createHash("sha256").update(s).digest()).slice(0, 32);
}

// Sends one message; the push service's status, which is 201 when taken,
// and 404 or 410 when the subscription is gone for good, and what it said.
export async function send(s: Subscription, payload: object, keys: { publicKey: string; privateKey: string }, subject: string, o: PushOptions): Promise<{ status: number; said: string }> {
  const res = await fetch(s.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapid(s.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(o.ttlSeconds),
      Urgency: "normal",
      ...(o.topic ? { Topic: o.topic } : {}),
    },
    body: new Uint8Array(encrypt(Buffer.from(JSON.stringify(payload)), s.keys)),
    signal: AbortSignal.timeout(15_000),
  });
  const said = await res.text().catch(() => "");
  return { status: res.status, said: said.replace(/\s+/g, " ").trim().slice(0, 200) };
}
