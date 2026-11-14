// The client's address behind trusted proxies (server/proxy.ts), as the
// relay finds it, and the sign-in limit counting by it.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "../core/client.ts";
import { createApp } from "../server/app.ts";
import { Auth, AuthStore } from "../server/auth.ts";
import { clientAddr, parseProxies } from "../server/proxy.ts";
import { EventLog } from "../server/stream.ts";

const ORIGIN = "https://pirc.test";

test("the header counts only from a trusted proxy, and only right of the first untrusted hop", () => {
  const p = parseProxies("172.30.88.2, 10.1.0.0/16");
  assert.equal(clientAddr("198.51.100.7", "203.0.113.9", p), "198.51.100.7", "from anyone else, the header is ignored");
  assert.equal(clientAddr("172.30.88.2", "203.0.113.9", p), "203.0.113.9");
  assert.equal(clientAddr("::ffff:172.30.88.2", "203.0.113.9", p), "203.0.113.9", "a mapped peer is its IPv4 address");
  assert.equal(clientAddr("172.30.88.2", "6.6.6.6, 203.0.113.9", p), "203.0.113.9", "what the client wrote, left of the proxy's entry, is not believed");
  assert.equal(clientAddr("172.30.88.2", "6.6.6.6, 203.0.113.9, 10.1.2.3", p), "203.0.113.9", "trusted hops are walked past");
  assert.equal(clientAddr("172.30.88.2", "203.0.113.9, nonsense", p), "172.30.88.2", "a hop that is no address stops the walk");
  assert.equal(clientAddr("172.30.88.2", undefined, p), "172.30.88.2", "no header: the proxy itself");
  assert.equal(clientAddr("172.30.88.2", "2001:db8::5", p), "2001:db8::5");
  assert.equal(clientAddr("172.30.88.2", "203.0.113.9", undefined), "172.30.88.2", "no proxies trusted");
  assert.equal(clientAddr(undefined, "203.0.113.9", p), "?");
});

test("trusted proxies are addresses and CIDR prefixes; wide ones are named", () => {
  assert.deepEqual(parseProxies("").wide, []);
  assert.deepEqual(parseProxies(" 172.30.88.2 , 10.0.0.0/8, 2001:db8::1/128 ").wide, ["10.0.0.0/8"]);
  const mapped = parseProxies("::ffff:172.30.88.2, ::ffff:10.1.0.0/112");
  assert.deepEqual(mapped.wide, ["::ffff:10.1.0.0/112"], "IPv4-mapped forms are taken as the relay takes them");
  assert.equal(clientAddr("172.30.88.2", "203.0.113.9", mapped), "203.0.113.9");
  assert.equal(clientAddr("10.1.200.3", "203.0.113.9", mapped), "203.0.113.9");
  assert.equal(clientAddr("10.2.0.1", "203.0.113.9", mapped), "10.2.0.1");
  for (const bad of ["pirc.test", "10.0.0.0/33", "10.0.0.0/8/1", "::ffff:10.0.0.0/95", "10.0.0.0/x"]) {
    assert.throws(() => parseProxies(bad), /trusted proxy/, bad);
  }
});

test("behind a trusted proxy, each client has its own sign-in limit", async () => {
  const store = new AuthStore(join(mkdtempSync(join(tmpdir(), "pirc-web-")), "auth.json"));
  const auth = new Auth(store, { origin: ORIGIN, name: "PiRC" });
  const log = new EventLog("run1");
  const client = new Client({ send: () => true, onEvent: (e) => log.push(e), newId: () => "id", publicKey: new Uint8Array(32).fill(2) });
  const options = (trusted?: string) => createApp({ auth, client, log, ...(trusted ? { trustedProxies: parseProxies(trusted) } : {}) });
  const attempt = (app: ReturnType<typeof createApp>, forwarded: string) =>
    app.request(`${ORIGIN}/api/login/options`, {
      method: "POST",
      headers: { host: "pirc.test", origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": forwarded },
      body: "{}",
    }, { incoming: { socket: { remoteAddress: "172.30.88.2", remotePort: 40000, remoteFamily: "IPv4" } } });

  const behind = options("172.30.88.2");
  for (let i = 0; i < 20; i++) assert.equal((await attempt(behind, "203.0.113.9")).status, 200);
  assert.equal((await attempt(behind, "203.0.113.9")).status, 429, "the 21st in a minute from one client");
  assert.equal((await attempt(behind, "198.51.100.7")).status, 200, "another client behind the same proxy is not locked out");

  const untrusted = options();
  for (let i = 0; i < 20; i++) await attempt(untrusted, `203.0.113.${i}`);
  assert.equal((await attempt(untrusted, "198.51.100.7")).status, 429, "with no proxy trusted, the header is ignored and the proxy is one client");
});
