// The relay connection against relays that misbehave.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { WebSocketServer } from "ws";

import { ErrorCode, FrameSchema } from "@pirc/protocol";
import { cutUtf8, loadOrCreateKey, RelayConnection, relayURL, type ConnectionState } from "../index.ts";

const key = loadOrCreateKey(join(mkdtempSync(join(tmpdir(), "pirc-rc-")), "k"));

async function server(): Promise<{ wss: WebSocketServer; url: string }> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.on("listening", r));
  return { wss, url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` };
}

test("a relay that never answers the login is given up on", async () => {
  const { wss, url } = await server();
  const states: ConnectionState[] = [];
  let thrown = "";
  const conn = new RelayConnection({
    url,
    role: "host",
    key,
    software: "test",
    loginTimeoutMs: 200,
    minBackoffMs: 60_000,
    onFrame() {},
    // A throwing callback must not become an uncaught exception.
    onState: (s) => {
      states.push(s);
      throw new Error("callback bug");
    },
    onError: (where, e) => (thrown = `${where}: ${(e as Error).message}`),
  });
  conn.start();
  await new Promise((r) => setTimeout(r, 500));
  conn.stop();
  wss.close();
  const offline = states.find((s) => s.kind === "offline");
  assert.ok(offline && offline.kind === "offline" && /did not finish the login/.test(offline.reason), JSON.stringify(states));
  assert.equal(thrown, "onState: callback bug");
});

test("a host awaiting approval asks again, without backing off or flickering", async () => {
  const { wss, url } = await server();
  let logins = 0;
  wss.on("connection", (ws) => {
    ws.on("message", (data: Buffer) => {
      const f = fromBinary(FrameSchema, new Uint8Array(data));
      if (f.body.case === "hello") {
        logins++;
        ws.send(toBinary(FrameSchema, create(FrameSchema, { body: { case: "challenge", value: { nonce: new Uint8Array(32) } } })));
      } else if (f.body.case === "auth") {
        ws.send(toBinary(FrameSchema, create(FrameSchema, { body: { case: "error", value: { code: ErrorCode.APPROVAL_PENDING, message: "awaiting approval" } } })));
        ws.close();
      }
    });
  });
  const states: string[] = [];
  const conn = new RelayConnection({
    url,
    role: "host",
    key,
    software: "test",
    approvalRetryMs: 50,
    minBackoffMs: 60_000,
    onFrame() {},
    onState: (s) => states.push(s.kind),
  });
  conn.start();
  await new Promise((r) => setTimeout(r, 400));
  conn.stop();
  wss.close();
  assert.ok(logins >= 3, `asked ${logins} times`);
  // One "connecting" at the start, then "pending" for as long as it waits.
  assert.deepEqual([...new Set(states)], ["connecting", "pending", "stopped"], states.join(" "));
  assert.equal(states.filter((s) => s === "connecting").length, 1);
});

test("a key removed while connected stops asking; other closes retry", async () => {
  const { wss, url } = await server();
  let logins = 0;
  const closes = [[1001, "going away"], [1008, "key revoked"]];
  wss.on("connection", (ws) => {
    ws.on("message", (data: Buffer) => {
      const f = fromBinary(FrameSchema, new Uint8Array(data));
      if (f.body.case === "hello") {
        ws.send(toBinary(FrameSchema, create(FrameSchema, { body: { case: "challenge", value: { nonce: new Uint8Array(32) } } })));
      } else if (f.body.case === "auth") {
        ws.send(toBinary(FrameSchema, create(FrameSchema, { body: { case: "welcome", value: { maxFrameBytes: 1 << 20 } } })));
        const [code, reason] = closes[Math.min(logins++, closes.length - 1)];
        setTimeout(() => ws.close(code as number, reason as string), 20);
      }
    });
  });
  const states: ConnectionState[] = [];
  const conn = new RelayConnection({ url, role: "host", key, software: "test", minBackoffMs: 10, maxBackoffMs: 10, onFrame() {}, onState: (s) => states.push(s) });
  conn.start();
  await new Promise((r) => setTimeout(r, 500));
  conn.stop();
  wss.close();
  assert.equal(logins, 2);
  const refused = states.find((s) => s.kind === "refused");
  assert.ok(refused?.kind === "refused" && refused.removed, JSON.stringify(states));
  assert.equal(states.at(-1)?.kind, "stopped");
});

test("strings are cut to whole characters", () => {
  assert.equal(cutUtf8("abc", 2), "ab");
  assert.equal(cutUtf8("aé", 2), "a");
  assert.equal(cutUtf8("é".repeat(100)).length, 64);
});

test("a relay URL gets the protocol path, and a web URL is explained", () => {
  assert.equal(relayURL("ws://r.example:7400"), "ws://r.example:7400/v1alpha1");
  assert.equal(relayURL("wss://r.example/custom"), "wss://r.example/custom");
  assert.throws(() => relayURL("http://r.example:7400"), /did you mean ws:\/\/r\.example:7400\?/);
  assert.throws(() => relayURL("https://r.example"), /did you mean wss:\/\/r\.example\?/);
  assert.throws(() => relayURL("ftp://r.example"), /must start with ws:\/\/ or wss:\/\//);
  assert.throws(() => relayURL("nonsense"), /not a relay URL: nonsense/);
});
