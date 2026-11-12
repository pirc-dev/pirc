// The relay connection against relays that misbehave.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { WebSocketServer } from "ws";

import { ErrorCode, FrameSchema, Role } from "@pirc/protocol";
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

// A relay as the real one answers a key it does not know: a token it
// cannot redeem is refused, unless redeemOnRetry says another process of
// the host redeemed it meanwhile, which the second login then finds; the
// key alone is held for approval as a host's, or refused as a client's.
async function refusingTokens(redeemOnRetry = false): Promise<{ wss: WebSocketServer; url: string; hellos: string[] }> {
  const { wss, url } = await server();
  const hellos: string[] = [];
  const send = (ws: import("ws").WebSocket, body: Parameters<typeof create<typeof FrameSchema>>[1]) =>
    ws.send(toBinary(FrameSchema, create(FrameSchema, body)));
  wss.on("connection", (ws) => {
    ws.on("message", (data: Buffer) => {
      const f = fromBinary(FrameSchema, new Uint8Array(data));
      if (f.body.case === "auth") return send(ws, { body: { case: "welcome", value: { maxFrameBytes: 1 << 20 } } });
      if (f.body.case !== "hello") return;
      const { registrationToken: token, role } = f.body.value;
      hellos.push(token);
      if (redeemOnRetry && hellos.length > 1) {
        return send(ws, { body: { case: "challenge", value: { nonce: new Uint8Array(32) } } });
      }
      const [code, message] = token
        ? [ErrorCode.TOKEN_INVALID, "token not found or expired"]
        : role === Role.HOST
          ? [ErrorCode.APPROVAL_PENDING, "awaiting approval"]
          : [ErrorCode.UNAUTHENTICATED, "key not registered"];
      send(ws, { body: { case: "error", value: { code, message } } });
    });
  });
  return { wss, url, hellos };
}

test("a wrong token is reported as the token's refusal, never held for approval", { timeout: 10_000 }, async () => {
  for (const role of ["host", "client"] as const) {
    for (const tokenRetry of [undefined, false]) {
      const { wss, url, hellos } = await refusingTokens();
      const states: ConnectionState[] = [];
      const refused = await new Promise<ConnectionState>((resolve) => {
        const conn = new RelayConnection({
          url, role, key, token: "wrong", tokenRetry, software: "test", minBackoffMs: 10, maxBackoffMs: 10, onFrame() {},
          onState: (s) => (states.push(s), s.kind === "refused" && resolve(s)),
        });
        conn.start();
      });
      wss.close();
      assert.deepEqual(refused, { kind: "refused", code: ErrorCode.TOKEN_INVALID, reason: "token not found or expired" });
      assert.ok(!states.some((s) => s.kind === "pending"), JSON.stringify(states));
      // The retry brings the token again; without it, the token is the only try.
      assert.deepEqual(hellos, tokenRetry === false ? ["wrong"] : ["wrong", "wrong"]);
    }
  }
});

test("a token another process of the host redeemed meanwhile lets the retry in", { timeout: 10_000 }, async () => {
  const { wss, url, hellos } = await refusingTokens(true);
  let registered = 0;
  let ready = () => {};
  const conn = new RelayConnection({
    url, role: "host", key, token: "shared", software: "test", minBackoffMs: 10, maxBackoffMs: 10, onFrame() {},
    onState: (s) => s.kind === "ready" && ready(),
    onRegistered: () => registered++,
  });
  await new Promise<void>((resolve) => {
    ready = resolve;
    conn.start();
  });
  conn.stop();
  wss.close();
  assert.deepEqual(hellos, ["shared", "shared"]);
  assert.equal(registered, 1);
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
