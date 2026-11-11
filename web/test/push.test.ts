// Notifications (server/push.ts, server/notify.ts): the encryption against
// RFC 8291's example, the VAPID token, and which finished turns notify,
// through a stand-in push service (push-service.ts).
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Client } from "../core/client.ts";
import type { ChatItem, SessionView } from "../core/view.ts";
import { notice, Notifier } from "../server/notify.ts";
import { badSubscription, encrypt, PushStore, vapid } from "../server/push.ts";
import { EventLog, Watchers } from "../server/stream.ts";
import { startPushService } from "./push-service.ts";

const unb64 = (s: string) => Buffer.from(s.replace(/\s/g, ""), "base64url");

test("the payload is encrypted as RFC 8291's example", () => {
  const out = encrypt(
    unb64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"),
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    unb64("DGv6ra1nlYgDCS1FRnbzlw"),
    unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
  );
  // Its header, then its ciphertext (Appendix A).
  assert.deepEqual(out, Buffer.concat([
    unb64("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8"),
    unb64("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ"),
  ]));
});

test("the VAPID token is for the push service's origin, signed with the server's key", () => {
  const store = new PushStore(join(mkdtempSync(join(tmpdir(), "pirc-push-")), "push.json"));
  const keys = store.keys();
  assert.equal(store.keys().publicKey, keys.publicKey, "the key is kept");
  const h = vapid("https://push.example/send/abc", keys, "https://pirc.example", 1_000_000_000_000);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  assert.ok(m, h);
  assert.equal(m[4], keys.publicKey);
  assert.deepEqual(JSON.parse(unb64(m[2]).toString()), { aud: "https://push.example", exp: 1_000_000_000 + 12 * 3600, sub: "https://pirc.example" });
  const pub = unb64(keys.publicKey);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, unb64(m[3])));
});

test("a subscription needs an https endpoint and the browser's keys", () => {
  const keys = { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16).toString("base64url") };
  assert.equal(badSubscription({ endpoint: "https://push.example/x", keys }, false), undefined);
  assert.equal(badSubscription({ endpoint: "http://push.example/x", keys }, false), "the endpoint must be https");
  assert.equal(badSubscription({ endpoint: "http://localhost:1/x", keys }, true), undefined);
  assert.equal(badSubscription({ endpoint: "https://push.example/x", keys: { ...keys, auth: "" } }, false), "no authentication secret");
  assert.equal(badSubscription(undefined, false), "no endpoint");
});

const session = (working: boolean, over: Partial<SessionView> = {}): SessionView => ({
  id: "h1-p1", sessionId: "s1", hostLabel: "laptop", hostname: "lap", name: "", first: "fix the tests", cwd: "/w/app",
  working, compacting: false, piVersion: "", extensionVersion: "", ...over,
});
const user: ChatItem = { kind: "user", id: "u1", turnId: "u1", at: 1, text: "fix the tests", images: [] };
const reply = (text: string, stop = "stop", error?: string): ChatItem =>
  ({ kind: "assistant", id: "a1", turnId: "u1", at: 2, blocks: [{ kind: "thinking", text: "hmm" }, { kind: "text", text }], streaming: false, stop, ...(error ? { error } : {}) });

test("a notice: the session's title and host, and how the reply begins, or what went wrong", () => {
  const chat = (...items: ChatItem[]) => ({ items, truncated: false, loading: false });
  assert.deepEqual(notice(session(false), chat(user, reply("All   green\nnow."))), { title: "fix the tests · laptop", body: "All green now.", url: "/s/h1-p1", tag: "h1-p1" });
  assert.equal(notice(session(false), chat(user, reply("x".repeat(300))))!.body.length, 120);
  assert.equal(notice(session(false), chat(user, reply("", "error", "rate limited")))!.body, "Failed: rate limited");
  assert.equal(notice(session(false), chat(user, reply("partial", "aborted"))), undefined);
  assert.equal(notice(session(false, { name: "api" }), chat(user))!.body, "Finished");
  assert.equal(notice(session(false, { name: "api" }), chat(user))!.title, "api · laptop");
});

test("a finished turn notifies each browser of a live passkey, unless a page shows the chat; an ended subscription is forgotten", async () => {
  const service = await startPushService();
  const got = service.got;
  try {
    const store = new PushStore(join(mkdtempSync(join(tmpdir(), "pirc-push-")), "push.json"));
    for (const [path, passkey] of [["/phone", "pk1"], ["/gone", "pk1"], ["/revoked", "pk2"]]) store.add(service.subscription(path), passkey);
    const log = new EventLog("r");
    const items: ChatItem[] = [user, reply("Done: all green.")];
    const client = { chat: () => ({ items, truncated: false, loading: false }) } as unknown as Client;
    const watchers = new Watchers();
    const n = new Notifier({ log, client, store, passkeys: () => ["pk1"], watching: (c) => watchers.has(c), subject: "https://pirc.example" });
    const stop = n.start();
    const settle = () => new Promise((r) => setTimeout(r, 100));
    // Until what the push service gets, or the store, has caught up; a
    // slow machine takes longer.
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    };

    // A session first seen idle, then a turn.
    log.push({ type: "session", session: session(false) });
    log.push({ type: "session", session: session(true) });
    log.push({ type: "session", session: session(true) });
    log.push({ type: "session", session: session(false) });
    await until(() => got.length >= 2 && store.subscriptions().length === 2);
    assert.deepEqual(got.map((g) => g.path).sort(), ["/gone", "/phone"]);
    const phone = got.find((g) => g.path === "/phone")!;
    assert.deepEqual(JSON.parse(phone.text), { title: "fix the tests · laptop", body: "Done: all green.", url: "/s/h1-p1", tag: "h1-p1" });
    assert.equal(phone.headers["content-encoding"], "aes128gcm");
    assert.equal(phone.headers.ttl, "86400");
    assert.match(String(phone.headers.authorization), /^vapid t=.+, k=/);
    assert.deepEqual(store.subscriptions().map((s) => new URL(s.endpoint).pathname), ["/phone", "/revoked"]);

    // Shown on a page: nothing.
    got.length = 0;
    const unwatch = watchers.add("h1-p1");
    log.push({ type: "session", session: session(true) });
    log.push({ type: "session", session: session(false) });
    await settle();
    assert.equal(got.length, 0);
    unwatch();

    // Stopped on purpose: nothing.
    items[1] = reply("half", "aborted");
    log.push({ type: "session", session: session(true) });
    log.push({ type: "session", session: session(false) });
    await settle();
    assert.equal(got.length, 0);

    // Gone while working: nothing, and no memory of it.
    log.push({ type: "session", session: session(true) });
    log.push({ type: "sessionGone", id: "h1-p1" });
    log.push({ type: "session", session: session(false) });
    await settle();
    assert.equal(got.length, 0);
    stop();
  } finally {
    service.close();
  }
});

test("from a host that writes notices: each new one notifies once, unless a page shows the chat; one there when first seen does not, nor a turn's end with no new one; one raised while its host was away does", async () => {
  const service = await startPushService();
  try {
    const store = new PushStore(join(mkdtempSync(join(tmpdir(), "pirc-push-")), "push.json"));
    store.add(service.subscription("/phone"), "pk1");
    const log = new EventLog("r");
    // The chat would say otherwise: the host's notice is what counts.
    const client = { chat: () => ({ items: [user, reply("from the chat")], truncated: false, loading: false }) } as unknown as Client;
    const watchers = new Watchers();
    const n = new Notifier({ log, client, store, passkeys: () => ["pk1"], watching: (c) => watchers.has(c), subject: "https://pirc.example" });
    const stop = n.start();
    const settle = () => new Promise((r) => setTimeout(r, 100));
    const bodies = () => service.got.map((g) => JSON.parse(g.text).body);
    const notice = (number: number, kind: "finished" | "failed" | "question", text: string) => ({ notice: { number, kind, text } });
    log.push({ type: "session", session: session(false, notice(10, "finished", "old news")) });
    log.push({ type: "session", session: session(true, notice(10, "finished", "old news")) });
    log.push({ type: "session", session: session(false, notice(20, "finished", "All green.")) });
    log.push({ type: "session", session: session(false, notice(20, "finished", "All green.")) });
    log.push({ type: "session", session: session(true, notice(30, "question", "Delete it?")) });
    log.push({ type: "session", session: session(false, notice(40, "failed", "")) });
    for (let i = 0; i < 200 && service.got.length < 3; i++) await new Promise((r) => setTimeout(r, 25));
    await settle();
    assert.deepEqual(bodies(), ["All green.", "Asks: Delete it?", "Failed: pi gave no reason"]);
    assert.deepEqual(JSON.parse(service.got[0].text), { title: "fix the tests · laptop", body: "All green.", url: "/s/h1-p1", tag: "h1-p1" });
    // A turn stopped on purpose raises none: its end says nothing.
    log.push({ type: "session", session: session(true, notice(40, "failed", "")) });
    log.push({ type: "session", session: session(false, notice(40, "failed", "")) });
    const unwatch = watchers.add("h1-p1");
    log.push({ type: "session", session: session(false, notice(50, "finished", "seen")) });
    await settle();
    assert.equal(service.got.length, 3);
    unwatch();
    // The first notice of a session seen before it had one is news.
    log.push({ type: "session", session: session(false, { id: "h1-p2" }) });
    log.push({ type: "session", session: session(false, { id: "h1-p2", ...notice(60, "finished", "first") }) });
    for (let i = 0; i < 200 && service.got.length < 4; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(bodies().slice(3), ["first"]);
    // Gone with its host's drop, back with one raised meanwhile: news.
    log.push({ type: "sessionGone", id: "h1-p2" });
    log.push({ type: "session", session: session(false, { id: "h1-p2", ...notice(70, "finished", "while away") }) });
    for (let i = 0; i < 200 && service.got.length < 5; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(bodies().slice(4), ["while away"]);
    stop();
  } finally {
    service.close();
  }
});

test("a chat counts as shown while any of its streams is open", () => {
  const w = new Watchers();
  const a = w.add("c");
  const b = w.add("c");
  a();
  a();
  assert.ok(w.has("c"));
  b();
  assert.ok(!w.has("c"));
});

test("a question asked notifies once, unless a page shows the chat; one there when the session was first seen does not", async () => {
  const service = await startPushService();
  try {
    const store = new PushStore(join(mkdtempSync(join(tmpdir(), "pirc-push-")), "push.json"));
    store.add(service.subscription("/phone"), "pk1");
    const log = new EventLog("r");
    const client = { chat: () => undefined } as unknown as Client;
    const watchers = new Watchers();
    const n = new Notifier({ log, client, store, passkeys: () => ["pk1"], watching: (c) => watchers.has(c), subject: "https://pirc.example" });
    const stop = n.start();
    const q = (id: string, title: string) => ({ id, kind: "confirm" as const, title, message: "build/ goes", answerable: true, askedAt: 1 });
    const settle = () => new Promise((r) => setTimeout(r, 100));
    log.push({ type: "session", session: session(true, { questions: [q("old", "Old?")] }) });
    log.push({ type: "session", session: session(true, { questions: [q("old", "Old?"), q("q1", "Delete it?")] }) });
    log.push({ type: "session", session: session(true, { questions: [q("q1", "Delete it?")] }) });
    for (let i = 0; i < 200 && service.got.length < 1; i++) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(service.got.map((g) => JSON.parse(g.text).body), ["Asks: Delete it? build/ goes"]);
    const unwatch = watchers.add("h1-p1");
    log.push({ type: "session", session: session(true, { questions: [q("q2", "Again?")] }) });
    await settle();
    assert.equal(service.got.length, 1);
    unwatch();
    stop();
  } finally {
    service.close();
  }
});
