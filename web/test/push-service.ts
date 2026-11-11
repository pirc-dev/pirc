// A stand-in for a browser vendor's push service, holding one browser's
// keys: it takes what the server sends, decrypts it as the browser would
// (RFC 8291), and keeps it. Over https with a certificate given, else http.
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";

import type { Subscription } from "../server/push.ts";

export interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  // The payload, decrypted.
  text: string;
}

export interface PushService {
  // A subscription for this browser at path; the service answers 410 at
  // /gone, as for a subscription that has ended.
  subscription(path: string): Subscription;
  got: Received[];
  close(): void;
}

export function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const secret = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const data = body.subarray(21 + idlen);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain.at(-1), 2, "one record, its delimiter last");
  return plain.subarray(0, -1).toString();
}

export async function startPushService(tls?: { cert: Buffer; key: Buffer }): Promise<PushService> {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  const got: Received[] = [];
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => {
      got.push({ path: req.url!, headers: req.headers, text: decrypt(Buffer.concat(parts), ua, auth) });
      res.writeHead(req.url === "/gone" ? 410 : 201).end();
    });
  };
  const server = tls ? createTlsServer(tls, handle) : createServer(handle);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `${tls ? "https" : "http"}://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    subscription: (path) => ({ endpoint: `${base}${path}`, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } }),
    got,
    close: () => server.close(),
  };
}
