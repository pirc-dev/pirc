// The web app's server without a browser: the checks on every request,
// pairing and signing in with a passkey (a software one), sign-ins ending,
// the event stream and commands.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Frame } from "@pirc/protocol";

import { Client } from "../core/client.ts";
import { createApp } from "../server/app.ts";
import { Auth, AuthStore, IDLE_MS } from "../server/auth.ts";
import { Notifier } from "../server/notify.ts";
import { PushStore } from "../server/push.ts";
import { EventLog, Watchers } from "../server/stream.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { frameIn, frameOut } from "./exchange.ts";

const ORIGIN = "https://pirc.test";
const COOKIE = "__Host-pirc-session";
const HOST_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const REF = { hostKey: HOST_KEY, sessionId: "s1", instanceId: "i1" };
const VID = "0101010101010101-i1";

function setup() {
  const store = new AuthStore(join(mkdtempSync(join(tmpdir(), "pirc-web-")), "auth.json"));
  let now = Date.parse("2026-10-25T10:00:00Z");
  const auth = new Auth(store, { origin: ORIGIN, name: "PiRC" }, () => now);
  const log = new EventLog("run1");
  const sent: Frame[] = [];
  let n = 0;
  const client = new Client({ send: (f) => (sent.push(f), true), onEvent: (e) => log.push(e), newId: () => `id-${++n}`, publicKey: new Uint8Array(32).fill(2) });
  const watchers = new Watchers();
  const push = new PushStore(join(mkdtempSync(join(tmpdir(), "pirc-web-")), "push.json"));
  const notifier = new Notifier({ log, client, store: push, passkeys: () => store.passkeys().map((p) => p.id), watching: (c) => watchers.has(c), subject: ORIGIN });
  const app = createApp({ auth, client, log, heartbeatMs: 50, watchers, push: { store: push, notifier }, relay: "wss://relay.test" });
  let cookie = "";
  const req = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { host: "pirc.test", ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) };
    if (init.method === "POST") Object.assign(headers, { origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin" });
    Object.assign(headers, init.headers);
    return app.request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  };
  const keepCookie = (r: Response) => {
    const m = /__Host-pirc-session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "");
    if (m) cookie = m[1];
    return r;
  };
  const pair = async (a: SoftAuthenticator, label = "phone") => {
    const token = store.issuePairToken(label, now);
    const options = await (await req("/api/pair/options", { method: "POST", body: { token } })).json();
    const r = keepCookie(await req("/api/pair/verify", { method: "POST", body: { response: a.register(options, ORIGIN) } }));
    return { token, r };
  };
  const login = async (a: SoftAuthenticator) => {
    const options = await (await req("/api/login/options", { method: "POST", body: {} })).json();
    return keepCookie(await req("/api/login/verify", { method: "POST", body: { response: a.authenticate(options, ORIGIN) } }));
  };
  return {
    store, auth, log, sent, client, req, pair, login, push, watchers,
    advance: (ms: number) => (now += ms),
    signOut: () => (cookie = ""),
    get cookie() { return cookie; },
  };
}

test("requests for another host, from another site or without an origin are refused", async () => {
  const t = setup();
  assert.equal((await t.req("/api/auth", { headers: { host: "evil.test" } })).status, 421);
  assert.equal((await t.req("/api/auth", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  // Opening the page from a link on another site is fine; the API is not.
  const opening = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  assert.notEqual((await t.req("/", { headers: opening })).status, 403);
  assert.notEqual((await t.req("/pair", { headers: opening })).status, 403);
  assert.equal((await t.req("/api/auth", { headers: opening })).status, 403);
  assert.equal((await t.req("/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" } })).status, 403);
  assert.equal((await t.req("/api/auth", { headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await t.req("/api/logout", { method: "POST", headers: { origin: "" } })).status, 403);
  assert.equal((await t.req("/api/auth")).status, 200);
});

test("nothing is served but signing in without a session", async () => {
  const t = setup();
  for (const path of ["/api/snapshot", "/api/events"]) assert.equal((await t.req(path)).status, 401, path);
  assert.equal((await t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { text: "hi" } })).status, 401);
  assert.deepEqual(await (await t.req("/api/auth")).json(), { signedIn: false });
});

test("a pairing link makes a passkey once, which then signs in", async () => {
  const t = setup();
  const phone = new SoftAuthenticator();
  const { token, r } = await t.pair(phone);
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(r.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(r.headers.get("set-cookie") ?? "", /Secure/);
  assert.match(r.headers.get("set-cookie") ?? "", /SameSite=Strict/);
  assert.equal((await t.req("/api/snapshot")).status, 200);
  assert.deepEqual(t.store.passkeys().map((p) => p.label), ["phone"]);

  // The link is used up.
  const again = await t.req("/api/pair/options", { method: "POST", body: { token } });
  assert.equal(again.status, 403);

  t.signOut();
  assert.equal((await t.req("/api/snapshot")).status, 401);
  assert.equal((await t.login(phone)).status, 200);
  assert.equal((await t.req("/api/snapshot")).status, 200);

  // An unknown passkey does not.
  t.signOut();
  assert.equal((await t.login(new SoftAuthenticator())).status, 403);
});

test("a sign-in ends 30 minutes after the person last did anything", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  t.advance(IDLE_MS - 1000);
  // The page loading a snapshot by itself does not count as use...
  assert.equal((await t.req("/api/snapshot")).status, 200);
  t.advance(1000);
  assert.equal((await t.req("/api/alive", { method: "POST", body: {} })).status, 401);

  const t2 = setup();
  await t2.pair(new SoftAuthenticator());
  t2.advance(IDLE_MS - 1000);
  // ...but anything the person does does.
  assert.equal((await t2.req("/api/alive", { method: "POST", body: {} })).status, 200);
  t2.advance(IDLE_MS - 1000);
  assert.equal((await t2.req("/api/snapshot")).status, 200);
});

test("revoking a passkey ends its sign-ins", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator(), "old phone");
  assert.equal((await t.req("/api/snapshot")).status, 200);
  t.store.revoke("old phone");
  assert.equal((await t.req("/api/snapshot")).status, 401);
});

// Reads an event stream until it has n events (or the stream ends).
async function events(r: Response, n: number): Promise<{ id?: string; event?: string; data: string }[]> {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: { id?: string; event?: string; data: string }[] = [];
  const deadline = Date.now() + 2000;
  while (out.length < n && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const e: { id?: string; event?: string; data: string } = { data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith("id: ")) e.id = line.slice(4);
        else if (line.startsWith("event: ")) e.event = line.slice(7);
        else if (line.startsWith("data: ")) e.data += line.slice(6);
      }
      if (e.data || e.event) out.push(e);
    }
  }
  await reader.cancel();
  return out;
}

async function announce(t: ReturnType<typeof setup>) {
  t.client.onState({ state: "ready" });
  t.client.onFrame(frameIn({ sessionList: { sessions: [{ session: REF, hostLabel: "laptop", announcement: { cwd: "/src/app", hostname: "laptop.local" } }] } }));
  t.client.onFrame(frameIn({ routed: { session: REF, message: { history: { requestId: "id-1", seq: "0", items: [] } } } }));
  // The history's reply lands on the microtask queue.
  await new Promise((r) => setImmediate(r));
}

test("the event stream replays from a snapshot's position and then follows", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  await announce(t);
  const snap = await (await t.req(`/api/snapshot?chat=${VID}`)).json() as { id: string; sessions: { id: string }[]; chat: unknown };
  assert.deepEqual(snap.sessions.map((s) => s.id), [VID]);
  assert.deepEqual(snap.chat, { items: [], truncated: false, loading: false });

  // Without a position, or with one from another run, the page loads a
  // snapshot first.
  assert.deepEqual((await events(await t.req("/api/events"), 1)).map((e) => e.event), ["reset"]);
  assert.deepEqual((await events(await t.req("/api/events?after=other.3"), 1)).map((e) => e.event), ["reset"]);

  const stream = t.req(`/api/events?chat=${VID}&after=${snap.id}`);
  t.client.onFrame(frameIn({ routed: { session: REF, message: { event: { seq: "1", at: "2026-10-25T10:00:00Z", item: { entryId: "u1", turnId: "u1", userMessage: { text: "hello" } } } } } }));
  // The message, then the session list's latest line.
  const got = await events(await stream, 2);
  assert.deepEqual(got.map((e) => e.id), [`run1.${t.log.seq - 1}`, `run1.${t.log.seq}`]);
  assert.deepEqual(JSON.parse(got[0].data), { type: "chatItem", id: VID, item: { kind: "user", id: "e-u1", turnId: "u1", at: 0, entryId: "u1", text: "hello", images: [] } });
  assert.deepEqual(JSON.parse(got[1].data).session.last, { who: "user", text: "hello", at: 0 });

  // Another chat's events are left out; the session list's are not.
  const all = await events(await t.req(`/api/events?chat=other&after=${snap.id}`), 5);
  assert.deepEqual(all.map((e) => JSON.parse(e.data).type), ["session"]);
});

test("a stream whose sign-in lapses says so and ends", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  const snap = await (await t.req("/api/snapshot")).json() as { id: string };
  const r = await t.req(`/api/events?after=${snap.id}`);
  t.advance(IDLE_MS);
  assert.deepEqual((await events(r, 1)).map((e) => e.event), ["signedOut"]);
});

test("a command goes to the session and answers with its outcome and position", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  await announce(t);
  t.sent.splice(0);
  const pending = t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { text: "hi", delivery: "steer" } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [
    { routed: { session: REF, message: { requestId: "id-2", prompt: { requestId: "id-2", text: "hi", delivery: "DELIVERY_STEER" } } } },
  ]);
  t.client.onFrame(frameIn({ routed: { session: REF, message: { accepted: { requestId: "id-2" } } } }));
  assert.deepEqual(await (await pending).json(), { ok: true, result: { kind: "accepted" }, id: `run1.${t.log.seq}` });

  const bad = await t.req(`/api/sessions/${VID}/thinking`, { method: "POST", body: { level: "lots" } });
  assert.equal(bad.status, 400);
  const gone = await t.req("/api/sessions/nobody/abort", { method: "POST", body: {} });
  assert.deepEqual(await gone.json(), { ok: false, code: "SESSION_GONE", message: "the session has ended", id: `run1.${t.log.seq}` });
});

test("a retry with the page's request ID reaches the session once; a malformed ID or a wrong answer is refused", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  await announce(t);
  t.sent.splice(0);
  const requestId = "3f0c2a9e-5b1d-4e7a-9c3b-2d8e6f1a4b70";
  const first = t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { requestId, text: "hi" } });
  await new Promise((r) => setImmediate(r));
  const retry = t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { requestId, text: "hi" } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [
    { routed: { session: REF, message: { requestId, prompt: { requestId, text: "hi" } } } },
  ], "sent once");
  t.client.onFrame(frameIn({ routed: { session: REF, message: { accepted: { requestId } } } }));
  for (const r of [first, retry]) assert.deepEqual((await (await r).json()).result, { kind: "accepted" });

  const bad = await t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { requestId: "x", text: "hi" } });
  assert.equal(bad.status, 400);

  // stats answered with Accepted: the session's mistake.
  const stats = t.req(`/api/sessions/${VID}/stats`, { method: "POST", body: {} });
  await new Promise((r) => setImmediate(r));
  const asked = frameOut(t.sent.splice(0)[0]) as { routed: { message: { statsRequest: { requestId: string } } } };
  t.client.onFrame(frameIn({ routed: { session: REF, message: { accepted: { requestId: asked.routed.message.statsRequest.requestId } } } }));
  const wrong = await (await stats).json();
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "PI_FAILED");
});

test("a request the session does not list is refused at once, and nothing is sent", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  t.client.onState({ state: "ready" });
  t.client.onFrame(frameIn({ sessionList: { sessions: [{ session: REF, hostLabel: "laptop", announcement: { cwd: "/src/app", hostname: "laptop.local", extensionVersion: "0.1.10", requests: ["prompt", "history_request"] } }] } }));
  t.client.onFrame(frameIn({ routed: { session: REF, message: { history: { requestId: "id-1", seq: "0", items: [] } } } }));
  await new Promise((r) => setImmediate(r));
  t.sent.splice(0);
  const r = await (await t.req(`/api/sessions/${VID}/reload`, { method: "POST", body: {} })).json();
  assert.equal(r.code, "INVALID");
  assert.match(r.message, /0\.1\.10\) does not take reload; update it/);
  assert.equal(t.sent.length, 0);
});

test("a busy stream stops at once when its sign-in lapses or is revoked", async () => {
  for (const how of ["idle", "revoke"] as const) {
    const t = setup();
    await t.pair(new SoftAuthenticator(), "phone");
    const snap = await (await t.req("/api/snapshot")).json() as { id: string };
    const r = await t.req(`/api/events?after=${snap.id}`);
    t.log.push({ type: "relay", relay: { state: "ready" } });
    if (how === "idle") t.advance(IDLE_MS);
    else t.store.revoke("phone");
    // Events keep coming, faster than any heartbeat: none gets through.
    for (let i = 0; i < 5; i++) t.log.push({ type: "relay", relay: { state: "ready" } });
    const got = await events(r, 3);
    assert.deepEqual(got.map((e) => e.event ?? "data"), ["data", "signedOut"], how);
  }
});

test("request bodies are limited, before signing in and after", async () => {
  const t = setup();
  const big = (n: number) => ({ token: "x".repeat(n) });
  assert.equal((await t.req("/api/pair/options", { method: "POST", body: big(100 << 10) })).status, 413);
  await t.pair(new SoftAuthenticator());
  // A prompt may carry its images; nothing else that much.
  assert.equal((await t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { text: "x".repeat(2 << 20) } })).status, 200);
  assert.equal((await t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { text: "x".repeat(13 << 20) } })).status, 413);
  assert.equal((await t.req(`/api/sessions/${VID}/rename`, { method: "POST", body: { name: "x".repeat(2 << 20) } })).status, 413);
});

test("a prompt's images reach the session; a message's images are kept for the page, by key", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  await announce(t);
  t.sent.splice(0);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const pending = t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { text: "", images: [{ mimeType: "image/png", data: png.toString("base64") }] } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [
    { routed: { session: REF, message: { requestId: "id-2", prompt: { requestId: "id-2", images: [{ mimeType: "image/png", data: png.toString("base64") }] } } } },
  ]);
  t.client.onFrame(frameIn({ routed: { session: REF, message: { accepted: { requestId: "id-2" } } } }));
  assert.equal((await (await pending).json() as { ok: boolean }).ok, true);

  for (const [images, why] of [
    [[{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }], /one of image\/png/],
    [[{ mimeType: "image/png", data: "not base64!" }], /base64/],
    [Array.from({ length: 5 }, () => ({ mimeType: "image/png", data: "AQID" })), /at most 4/],
    [[{ mimeType: "image/png", data: Buffer.alloc((2 << 20) + 1).toString("base64") }], /at most 2 MiB/],
  ] as const) {
    const r = await t.req(`/api/sessions/${VID}/prompt`, { method: "POST", body: { text: "hi", images } });
    assert.equal(r.status, 400);
    assert.match((await r.json() as { message: string }).message, why);
  }

  // pi's copy: the image by its key, and one left out for size by none.
  t.client.onFrame(frameIn({ routed: { session: REF, message: { event: { seq: "1", at: "2026-10-25T10:00:00Z", item: { entryId: "u1", turnId: "u1", userMessage: { text: "", requestId: "id-2", images: [{ mimeType: "image/png", data: png.toString("base64") }, { mimeType: "image/jpeg" }] } } } } } }));
  const item = t.client.chat(VID)!.items[0];
  assert.ok(item.kind === "user");
  assert.equal(item.images.length, 2);
  assert.equal(item.images[1].key, undefined);
  const r = await t.req(`/api/images/${item.images[0].key}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("cache-control") ?? "", /immutable/);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  assert.equal((await t.req("/api/images/0000")).status, 404);
  t.signOut();
  assert.equal((await t.req(`/api/images/${item.images[0].key}`)).status, 401);
});

test("an HTTPS app tells browsers to keep to HTTPS", async () => {
  const t = setup();
  assert.match((await t.req("/api/auth")).headers.get("strict-transport-security") ?? "", /max-age=/);
});

test("a page that stops reading has its stream ended", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  const snap = await (await t.req("/api/snapshot")).json() as { id: string };
  const r = await t.req(`/api/events?after=${snap.id}`);
  for (let i = 0; i < 2100; i++) t.log.push({ type: "relay", relay: { state: "ready" } });
  const reader = r.body!.getReader();
  let chunks = 0;
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
    chunks++;
  }
  assert.ok(chunks > 1900 && chunks < 2100, `${chunks} chunks before the end`);
});

test("the event log keeps what fits, by count and by size", () => {
  const log = new EventLog("r", 3, 1000);
  for (let i = 0; i < 5; i++) log.push({ type: "sessionGone", id: String(i) });
  assert.equal(log.since(1), undefined);
  assert.deepEqual(log.since(2)?.map((n) => n.seq), [3, 4, 5]);
  const big = new EventLog("r", 100, 200);
  for (let i = 0; i < 5; i++) big.push({ type: "sessionGone", id: "x".repeat(60) });
  // Each is about 90 bytes: two fit.
  assert.deepEqual(big.since(3)?.map((n) => n.seq), [4, 5]);
  assert.equal(big.since(2), undefined);
});

test("hosts asking to join are listed, and approved or rejected through the relay", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  t.client.onState({ state: "ready" });
  assert.deepEqual(t.sent.splice(0).map(frameOut), [{ subscribeSessions: {} }, { watchPendingHosts: {} }, { watchKeys: {} }]);
  const key = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
  t.client.onFrame(frameIn({ pendingHosts: { hosts: [{ publicKey: HOST_KEY, label: "build-box", software: "pirc-extension/0.1.9", remote: "203.0.113.24:1", firstSeen: "2026-10-29T10:00:00Z" }] } }));
  const snap = await (await t.req("/api/snapshot")).json();
  assert.deepEqual(snap.pendingHosts, [{ key, label: "build-box", software: "pirc-extension/0.1.9", remote: "203.0.113.24:1", firstSeen: Date.parse("2026-10-29T10:00:00Z") }]);

  const approving = t.req("/api/hosts/approve", { method: "POST", body: { key, label: " laptop " } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [{ approveHost: { requestId: "id-1", publicKey: HOST_KEY, label: "laptop" } }]);
  t.client.onFrame(frameIn({ pendingHosts: {} }));
  t.client.onFrame(frameIn({ hostDecided: { requestId: "id-1" } }));
  assert.deepEqual(await (await approving).json(), { ok: true, id: `run1.${t.log.seq}` });
  assert.deepEqual(t.log.since(t.log.seq - 1)!.map((n) => n.event), [{ type: "pendingHosts", hosts: [] }]);

  // The relay's refusal names the request.
  const rejecting = t.req("/api/hosts/reject", { method: "POST", body: { key } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [{ rejectHost: { requestId: "id-2", publicKey: HOST_KEY } }]);
  t.client.onFrame(frameIn({ error: { code: "ERROR_CODE_INVALID", message: "no host awaiting approval has that key", requestId: "id-2" } }));
  assert.deepEqual(await (await rejecting).json(), { ok: false, code: "INVALID", message: "no host awaiting approval has that key", id: `run1.${t.log.seq}` });

  // Not a key: refused here.
  const bad = await (await t.req("/api/hosts/approve", { method: "POST", body: { key: "short" } })).json();
  assert.equal(bad.code, "INVALID");
  assert.equal((await t.req("/api/hosts/reject", { method: "POST", body: {} })).status, 400);
  assert.equal(t.sent.length, 0);

  // Lost with the connection, and listed again by the relay after it.
  t.client.onFrame(frameIn({ pendingHosts: { hosts: [{ publicKey: HOST_KEY, label: "build-box" }] } }));
  const lost = t.req("/api/hosts/approve", { method: "POST", body: { key } });
  await new Promise((r) => setImmediate(r));
  t.client.onState({ state: "offline", reason: "gone" });
  assert.equal((await (await lost).json()).code, "SESSION_GONE");
  assert.deepEqual((await (await t.req("/api/snapshot")).json()).pendingHosts, []);
});

test("the registered devices are listed, this server's own marked, renamed and removed, and tokens made, through the relay", async () => {
  const t = setup();
  await t.pair(new SoftAuthenticator());
  t.client.onState({ state: "ready" });
  t.sent.splice(0);
  const key = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
  const own = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
  t.client.onFrame(frameIn({ keys: { keys: [
    { publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=", role: "ROLE_CLIENT", label: "web", addedAt: "2026-10-20T10:00:00Z", online: true },
    { publicKey: HOST_KEY, role: "ROLE_HOST", label: "build-box", addedAt: "2026-10-29T10:00:00Z" },
  ] } }));
  assert.deepEqual((await (await t.req("/api/snapshot")).json()).devices, [
    { key: own, role: "client", label: "web", addedAt: Date.parse("2026-10-20T10:00:00Z"), online: true, self: true, push: false },
    { key, role: "host", label: "build-box", addedAt: Date.parse("2026-10-29T10:00:00Z"), online: false, self: false, push: false },
  ]);

  const renaming = t.req("/api/devices/rename", { method: "POST", body: { key, label: " attic " } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [{ renameKey: { requestId: "id-1", publicKey: HOST_KEY, label: "attic" } }]);
  t.client.onFrame(frameIn({ keys: { keys: [{ publicKey: HOST_KEY, role: "ROLE_HOST", label: "attic" }] } }));
  t.client.onFrame(frameIn({ keyChanged: { requestId: "id-1" } }));
  assert.deepEqual(await (await renaming).json(), { ok: true, id: `run1.${t.log.seq}` });
  assert.equal(t.log.since(t.log.seq - 1)![0].event.type, "devices");

  // Refused by the relay, and here without a key or a name.
  const refused = t.req("/api/devices/rename", { method: "POST", body: { key, label: "x" } });
  await new Promise((r) => setImmediate(r));
  t.client.onFrame(frameIn({ error: { code: "ERROR_CODE_INVALID", message: "no such key", requestId: "id-2" } }));
  assert.equal((await (await refused).json()).message, "no such key");
  assert.equal((await t.req("/api/devices/rename", { method: "POST", body: { key, label: "  " } })).status, 400);
  assert.equal((await t.req("/api/devices/rename", { method: "POST", body: { label: "x" } })).status, 400);
  t.sent.splice(0);

  // Removed, and the server's own refused by the relay.
  const removing = t.req("/api/devices/remove", { method: "POST", body: { key } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [{ removeKey: { requestId: "id-3", publicKey: HOST_KEY } }]);
  t.client.onFrame(frameIn({ keys: { keys: [] } }));
  t.client.onFrame(frameIn({ keyChanged: { requestId: "id-3" } }));
  assert.equal((await (await removing).json()).ok, true);
  const self = t.req("/api/devices/remove", { method: "POST", body: { key: own } });
  await new Promise((r) => setImmediate(r));
  t.client.onFrame(frameIn({ error: { code: "ERROR_CODE_PERMISSION_DENIED", message: "a client cannot remove its own key", requestId: "id-4" } }));
  assert.deepEqual(await (await self).json(), { ok: false, code: "PERMISSION_DENIED", message: "a client cannot remove its own key", id: `run1.${t.log.seq}` });
  assert.equal((await t.req("/api/devices/remove", { method: "POST", body: {} })).status, 400);
  t.sent.splice(0);

  // A token, passed on with the relay's URL; refused by the relay, or here
  // without a role.
  const inviting = t.req("/api/devices/invite", { method: "POST", body: { role: "client", label: " phone " } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [{ issueToken: { requestId: "id-5", role: "ROLE_CLIENT", label: "phone" } }]);
  t.client.onFrame(frameIn({ tokenIssued: { requestId: "id-5", token: "tok", expiresAt: "2026-10-31T10:15:00Z" } }));
  assert.deepEqual(await (await inviting).json(), { ok: true, token: "tok", expiresAt: Date.parse("2026-10-31T10:15:00Z"), relay: "wss://relay.test", id: `run1.${t.log.seq}` });
  const refusedToken = t.req("/api/devices/invite", { method: "POST", body: { role: "host" } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.sent.splice(0).map(frameOut), [{ issueToken: { requestId: "id-6", role: "ROLE_HOST" } }]);
  t.client.onFrame(frameIn({ error: { code: "ERROR_CODE_INVALID", message: "label is too long", requestId: "id-6" } }));
  assert.equal((await (await refusedToken).json()).message, "label is too long");
  assert.equal((await t.req("/api/devices/invite", { method: "POST", body: { role: "admin" } })).status, 400);
  t.sent.splice(0);

  // Not listed while the relay is out of reach.
  t.client.onState({ state: "offline", reason: "gone" });
  assert.deepEqual((await (await t.req("/api/snapshot")).json()).devices, []);
});

test("a browser subscribes for the passkey signed in, and unsubscribes; a page's stream counts its chat as shown", async () => {
  const t = setup();
  const sub = { endpoint: "https://push.example/send/1", keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
  assert.equal((await t.req("/api/push/subscribe", { method: "POST", body: { subscription: sub } })).status, 401);
  await t.pair(new SoftAuthenticator());
  const { publicKey } = await (await t.req("/api/push")).json() as { publicKey: string };
  assert.equal(Buffer.from(publicKey, "base64url").length, 65);
  const bad = await t.req("/api/push/subscribe", { method: "POST", body: { subscription: { ...sub, endpoint: "http://push.example/1" } } });
  assert.equal(bad.status, 400);
  assert.equal((await t.req("/api/push/subscribe", { method: "POST", body: { subscription: sub } })).status, 200);
  assert.deepEqual(t.push.subscriptions().map((x) => [x.endpoint, x.passkeyId]), [[sub.endpoint, t.store.passkeys()[0].id]]);
  // A test needs a subscription the server has.
  const test = await (await t.req("/api/push/test", { method: "POST", body: { endpoint: "https://push.example/other" } })).json() as { ok: boolean };
  assert.equal(test.ok, false);
  assert.equal((await t.req("/api/push/unsubscribe", { method: "POST", body: { endpoint: sub.endpoint } })).status, 200);
  assert.deepEqual(t.push.subscriptions(), []);

  const snap = await (await t.req("/api/snapshot")).json() as { id: string };
  const r = await t.req(`/api/events?chat=c1&after=${snap.id}`);
  assert.ok(t.watchers.has("c1"));
  await r.body!.cancel();
  assert.ok(!t.watchers.has("c1"));
});
