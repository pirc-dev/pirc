// Files sent with a prompt: the server takes them from the page in base64,
// sends their bytes to the session in pieces before the prompt, only to a
// session that takes them, and shows the files history names.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { JsonObject } from "@bufbuild/protobuf";
import type { Frame } from "@pirc/protocol";

import { FILE_CHUNK, FILES_BYTES_MAX } from "../core/api.ts";
import { Client } from "../core/client.ts";
import { lastOf, type ChatItem } from "../core/view.ts";
import { createApp } from "../server/app.ts";
import { Auth, AuthStore } from "../server/auth.ts";
import { EventLog } from "../server/stream.ts";
import { SoftAuthenticator } from "./authenticator.ts";
import { frameIn, frameOut } from "./exchange.ts";

const ORIGIN = "https://pirc.test";
const HOST_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const REF = { hostKey: HOST_KEY, sessionId: "s1", instanceId: "i1" };
const VID = "0101010101010101-i1";
const TAKES = ["prompt", "history_request", "attachment_chunk"];

async function setup(requests: string[] = TAKES) {
  const store = new AuthStore(join(mkdtempSync(join(tmpdir(), "pirc-web-")), "auth.json"));
  const auth = new Auth(store, { origin: ORIGIN, name: "PiRC" }, () => Date.parse("2026-10-25T10:00:00Z"));
  const log = new EventLog("run1");
  const sent: Frame[] = [];
  let n = 0;
  const client = new Client({ send: (f) => (sent.push(f), true), onEvent: (e, replaced) => log.push(e, replaced), newId: () => `id-${++n}` });
  const app = createApp({ auth, client, log });
  let cookie = "";
  const req = (path: string, body: unknown) =>
    app.request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { host: "pirc.test", origin: ORIGIN, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(cookie ? { cookie: `__Host-pirc-session=${cookie}` } : {}) },
      body: JSON.stringify(body),
    });
  const a = new SoftAuthenticator();
  const token = store.issuePairToken("phone", Date.now());
  const options = await (await req("/api/pair/options", { token })).json();
  const r = await req("/api/pair/verify", { response: a.register(options, ORIGIN) });
  cookie = /__Host-pirc-session=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")![1];
  client.onState({ state: "ready" });
  client.onFrame(frameIn({ sessionList: { sessions: [{ session: REF, hostLabel: "laptop", announcement: { cwd: "/src/app", hostname: "laptop.local", extensionVersion: "0.9.0", requests } }] } }));
  client.onFrame(frameIn({ routed: { session: REF, message: { history: { requestId: "id-1", seq: "0", items: [] } } } }));
  await new Promise((r) => setImmediate(r));
  sent.splice(0);
  const prompt = (body: unknown) => req(`/api/sessions/${VID}/prompt`, body);
  // The session's messages, in the order the server sent them.
  const out = () => sent.splice(0).map((f) => {
    assert.equal(f.body.case, "routed");
    return (frameOut(f) as { routed: { message: Record<string, Record<string, unknown>> } }).routed.message;
  });
  const answer = (requestId: string, m: JsonObject = { accepted: { requestId } }) =>
    client.onFrame(frameIn({ routed: { session: REF, message: m } }));
  return { client, prompt, out, answer };
}

const tick = () => new Promise((r) => setImmediate(r));
const b64 = (n: number, fill: number) => Buffer.alloc(n, fill).toString("base64");

test("a prompt's files go first, each in order from offset 0 in pieces of 512 KiB, then the prompt naming them", async () => {
  const t = await setup();
  const big = 2 * FILE_CHUNK + 10;
  const pending = t.prompt({
    requestId: "page-request-0001",
    text: "",
    images: [{ mimeType: "image/png", data: "iVBORw==" }],
    files: [{ name: "log.txt", mimeType: "text/plain", data: b64(big, 7) }, { name: "empty", mimeType: "", data: "" }],
  });
  await tick();
  const m = t.out();
  const pieces = m.filter((x) => x.attachmentChunk).map((x) => x.attachmentChunk as { id: string; offset?: string; data?: string });
  assert.deepEqual(pieces.map((p) => [p.id, Number(p.offset ?? 0), Buffer.from(p.data ?? "", "base64").length]), [
    ["page-request-0001.0", 0, FILE_CHUNK],
    ["page-request-0001.0", FILE_CHUNK, FILE_CHUNK],
    ["page-request-0001.0", 2 * FILE_CHUNK, 10],
    // An empty file still has its one piece, which starts it.
    ["page-request-0001.1", 0, 0],
  ]);
  assert.ok(Buffer.from(pieces[1].data!, "base64").every((x) => x === 7));
  // Pieces are never answered: they carry no request ID.
  assert.ok(m.slice(0, 4).every((x) => x.requestId === undefined));
  assert.equal(m.length, 5);
  assert.deepEqual(m[4].prompt, {
    requestId: "page-request-0001",
    images: [{ mimeType: "image/png", data: "iVBORw==" }],
    attachments: [
      { id: "page-request-0001.0", name: "log.txt", mimeType: "text/plain", size: String(big) },
      { id: "page-request-0001.1", name: "empty", mimeType: "application/octet-stream" },
    ],
  });
  t.answer("page-request-0001");
  assert.equal((await (await pending).json() as { ok: boolean }).ok, true);

  // A retry of one the session took is answered from what it kept: the
  // files are not sent again.
  const again = t.prompt({ requestId: "page-request-0001", text: "", files: [{ name: "log.txt", mimeType: "text/plain", data: b64(big, 7) }] });
  await tick();
  assert.deepEqual(t.out().map((x) => Object.keys(x).filter((k) => k !== "requestId")), [["prompt"]]);
  t.answer("page-request-0001");
  assert.equal((await (await again).json() as { ok: boolean }).ok, true);
});

test("a prompt refused sends its files again from offset 0 when retried, and the session's why is the outcome", async () => {
  const t = await setup();
  const body = { requestId: "page-request-0002", text: "see", files: [{ name: "a.bin", mimeType: "application/octet-stream", data: b64(FILE_CHUNK + 1, 1) }] };
  for (let i = 0; i < 2; i++) {
    const r = t.prompt(body);
    await tick();
    const m = t.out();
    assert.deepEqual(m.map((x) => (x.attachmentChunk ? `piece ${Number(x.attachmentChunk.offset ?? 0)}` : "prompt")), ["piece 0", `piece ${FILE_CHUNK}`, "prompt"]);
    t.answer("page-request-0002", { error: { requestId: "page-request-0002", code: "ERROR_CODE_INVALID", message: "its file's pieces came out of order" } });
    const a = await (await r).json() as { ok: boolean; code: string; message: string };
    assert.deepEqual([a.ok, a.code, a.message], [false, "INVALID", "its file's pieces came out of order"]);
  }
});

test("files go only to a session that lists attachment_chunk; too many, too large or malformed are refused, and nothing is sent", async () => {
  const t = await setup(["prompt", "history_request"]);
  const r = await (await t.prompt({ text: "hi", files: [{ name: "a.txt", mimeType: "text/plain", data: "aGk=" }] })).json() as { ok: boolean; code: string; message: string };
  assert.deepEqual([r.ok, r.code], [false, "INVALID"]);
  assert.match(r.message, /0\.9\.0\) does not take files; update it/);
  assert.deepEqual(t.out(), []);
  // Text alone still goes.
  const p = t.prompt({ requestId: "page-request-0003", text: "hi" });
  await tick();
  assert.deepEqual(t.out().map((x) => Object.keys(x).filter((k) => k !== "requestId")), [["prompt"]]);
  t.answer("page-request-0003");
  await p;

  const u = await setup();
  for (const [files, why] of [
    [[{ name: "a", mimeType: "text/plain", data: b64(FILES_BYTES_MAX - 1, 0) }, { name: "b", mimeType: "text/plain", data: b64(2, 0) }], /at most 10 MiB/],
    [Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, mimeType: "text/plain", data: "" })), /at most 20 files/],
    [[{ name: "", mimeType: "text/plain", data: "" }], /a name/],
    [[{ name: "a", mimeType: "not a type", data: "" }], /media type/],
    [[{ name: "a", mimeType: "text/plain", data: "not base64!" }], /base64/],
    [{ name: "a" }, /a list/],
  ] as const) {
    const res = await u.prompt({ text: "", files });
    assert.equal(res.status, 400);
    assert.match((await res.json() as { message: string }).message, why);
  }
  assert.deepEqual(u.out(), []);
  // A prompt of files alone, with no text, is a prompt.
  const alone = u.prompt({ requestId: "page-request-0004", text: "", files: [{ name: "a", mimeType: "text/plain", data: "aGk=" }] });
  await tick();
  assert.equal(u.out().length, 2);
  u.answer("page-request-0004");
  assert.equal((await (await alone).json() as { ok: boolean }).ok, true);
});

test("history's files come into the chat by name, type and size; a message with none has no attachments", async () => {
  const t = await setup();
  const item = (entryId: string, userMessage: JsonObject) => ({ entryId, turnId: entryId, userMessage });
  t.client.onFrame(frameIn({ routed: { session: REF, message: { event: { seq: "1", at: "2026-10-25T10:00:00Z", item: item("u1", { text: "read these", attachments: [{ name: "notes.md", mimeType: "text/markdown", size: "1234" }, { name: "data.csv", mimeType: "text/csv", size: "0" }] }) } } } }));
  t.client.onFrame(frameIn({ routed: { session: REF, message: { event: { seq: "2", at: "2026-10-25T10:00:01Z", item: item("u2", { text: "plain" }) } } } }));
  const [withFiles, plain] = t.client.chat(VID)!.items;
  assert.deepEqual(withFiles, {
    kind: "user", id: "e-u1", turnId: "u1", at: 0, entryId: "u1", text: "read these", images: [],
    attachments: [{ name: "notes.md", mimeType: "text/markdown", size: 1234 }, { name: "data.csv", mimeType: "text/csv", size: 0 }],
  });
  assert.ok(plain.kind === "user" && !("attachments" in plain));
});

test("the session list names a message of files alone by its file, or how many; images come first", () => {
  const user = (text: string, images: number, files: string[]): ChatItem => ({
    kind: "user", id: "u", turnId: "t", at: 1, text,
    images: Array.from({ length: images }, () => ({ mimeType: "image/png" })),
    ...(files.length ? { attachments: files.map((name) => ({ name, mimeType: "text/plain", size: 1 })) } : {}),
  });
  assert.equal(lastOf([user("", 0, ["notes.md"])])?.text, "notes.md");
  assert.equal(lastOf([user("", 0, ["a", "b", "c"])])?.text, "3 files");
  assert.equal(lastOf([user("", 1, ["a"])])?.text, "An image");
  assert.equal(lastOf([user("", 2, ["a"])])?.text, "2 images");
  assert.equal(lastOf([user("look", 0, ["a"])])?.text, "look");
  assert.equal(lastOf([user("", 0, [])])?.text, "");
});
