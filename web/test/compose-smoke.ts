// The Docker Compose setup checked from outside, through Caddy, as a
// browser and a host reach it (.github/workflows/compose.yml): the page
// over HTTPS and HTTP/2, a passkey made and signed in with, the event
// stream open, and a host connecting over a WebSocket without a token,
// which the stream announces, the web app approves, and the host is then
// let in.
//
//   node --experimental-transform-types --no-warnings web/test/compose-smoke.ts <origin> <pair-link>
//
// Trusts Caddy's certificate through NODE_EXTRA_CA_CERTS.
import assert from "node:assert/strict";
import { connect } from "node:http2";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOrCreateKey, RelayConnection, type ConnectionState } from "@pirc/relay-client";

import { SoftAuthenticator } from "./authenticator.ts";

const [origin, link] = process.argv.slice(2);
if (!origin || !link) {
  console.error("usage: compose-smoke.ts <origin> <pair-link>");
  process.exit(2);
}
const step = (s: string) => console.log(`· ${s}`);
const within = <T>(ms: number, what: string, p: Promise<T>) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: nothing after ${ms} ms`)), ms))]);

const h2 = connect(origin);
h2.on("error", (e) => {
  console.error(`HTTP/2 to ${origin}: ${e.message}`);
  process.exit(1);
});
// The name alone, as a browser sends it for port 443, which the web app
// checks; Node's client would otherwise add the port.
const authority = new URL(origin).host;
let cookie = "";
const request = (path: string, body?: unknown) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = h2.request({
      ":method": body === undefined ? "GET" : "POST",
      ":path": path,
      ":authority": authority,
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    });
    let status = 0;
    let text = "";
    req.on("response", (h) => {
      status = Number(h[":status"]);
      const set = /(__Host-pirc-session)=([^;]*)/.exec(String(h["set-cookie"] ?? ""));
      if (set) cookie = `${set[1]}=${set[2]}`;
    });
    req.setEncoding("utf8");
    req.on("data", (d: string) => (text += d));
    req.on("end", () => resolve({ status, text }));
    req.on("error", reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
const post = async <T>(path: string, body: unknown = {}) => {
  const r = await request(path, body);
  assert.equal(r.status, 200, `${path}: ${r.status} ${r.text}`);
  return JSON.parse(r.text) as T;
};

step("the page, over HTTPS and HTTP/2");
const page = await request("/");
assert.equal(page.status, 200);
assert.match(page.text, /<html/i);

step("a passkey made with the pairing link, and signed in with");
const phone = new SoftAuthenticator();
const options = await post<{ challenge: string; rp: { id: string }; user: { id: string } }>("/api/pair/options", { token: link.slice(link.indexOf("#") + 1) });
await post("/api/pair/verify", { response: phone.register(options, origin) });
cookie = "";
const login = await post<{ challenge: string; rpId: string }>("/api/login/options");
await post("/api/login/verify", { response: phone.authenticate(login, origin) });
const snap = await request("/api/snapshot");
assert.equal(snap.status, 200, snap.text);
const after = (JSON.parse(snap.text) as { id: string }).id;

step("the event stream, open through the proxy");
const events = h2.request({ ":path": `/api/events?after=${encodeURIComponent(after)}`, ":authority": authority, cookie });
let streamed = "";
const pending = new Promise<string>((resolve) => {
  events.setEncoding("utf8");
  events.on("data", (d: string) => {
    streamed += d;
    for (const block of streamed.split("\n\n")) {
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      const e = JSON.parse(data) as { type: string; hosts?: { key: string }[] };
      if (e.type === "pendingHosts" && e.hosts?.length) resolve(e.hosts[0].key);
    }
  });
});

step("a host over a WebSocket, with no token: the stream says it waits");
const states: ConnectionState["kind"][] = [];
let readyNow: () => void = () => {};
let refusedNow: (e: Error) => void = () => {};
const ready = new Promise<void>((resolve, reject) => ((readyNow = resolve), (refusedNow = reject)));
const host = new RelayConnection({
  url: origin.replace(/^https:/, "wss:"),
  role: "host",
  key: loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "pirc-smoke-")), "host.key")),
  label: "smoke",
  software: "compose-smoke",
  approvalRetryMs: 1000,
  onFrame: () => {},
  onState: (s) => {
    states.push(s.kind);
    if (s.kind === "ready") readyNow();
    if (s.kind === "refused") refusedNow(new Error(`refused: ${s.reason}`));
  },
});
host.start();
const key = await within(15_000, "the pending host on the event stream", pending);
assert.ok(states.includes("pending"), `the host's states: ${states.join(", ")}`);

step("approved from the web app, the host is let in");
assert.equal((await post<{ ok: boolean }>("/api/hosts/approve", { key, label: "smoke" })).ok, true);
await within(15_000, "the approved host's login", ready);

host.stop();
events.close();
h2.close();
console.log("ok: the Compose setup, through Caddy");
