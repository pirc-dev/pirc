import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { load } from "@pirc/e2e";
import { load as loadNoise } from "@pirc/e2e/noise";
import { ErrorCode, SessionMessageSchema } from "@pirc/protocol";
import { ChannelFrameSchema, FrameSchema, type Frame, type SessionFrame } from "@pirc/protocol/v1alpha2";

import { keysOf, ListFolder, listsSelf, selfDevice } from "../src/account.ts";
import { Channels, FRAME_MAX, Joiner, MAX_WAITING, PIECE_DATA_MAX, pieces, QUEUE_BYTES, WINDOW_BYTES, WINDOW_MESSAGES, type Channel, type ChannelHost } from "../src/channel.ts";
import { accountFolder, accountId, alice, bob, channelSecret, computer, computerSecrets, info, phone, v1, version } from "./account-fixture.ts";
import { ChannelClient } from "./channel-client.ts";

const e2e = await load();
const noise = await loadNoise();
const keys = keysOf(computerSecrets, (s) => noise.staticKey(s).publicKey);
const tick = () => new Promise((r) => setImmediate(r));

test("pieces: cut at 65,518 bytes of data, the last flagged, and joined again", () => {
  for (const n of [0, 1, PIECE_DATA_MAX - 1, PIECE_DATA_MAX, PIECE_DATA_MAX + 1, 3 * PIECE_DATA_MAX, FRAME_MAX]) {
    const frame = Uint8Array.from({ length: n }, (_, i) => i % 251);
    const ps = pieces(frame);
    assert.equal(ps.length, Math.max(1, Math.ceil(n / PIECE_DATA_MAX)), `${n}`);
    assert.ok(ps.every((p) => p.length <= PIECE_DATA_MAX + 1));
    assert.ok(ps.every((p, i) => p[0] === (i === ps.length - 1 ? 1 : 0)));
    const j = new Joiner();
    let out: Uint8Array | undefined | "invalid";
    for (const p of ps) out = j.push(p);
    assert.deepEqual(out, frame, `${n}`);
  }
  const j = new Joiner();
  assert.equal(j.push(Uint8Array.of(2)), "invalid");
  assert.equal(new Joiner().push(new Uint8Array(0)), "invalid");
  const big = pieces(new Uint8Array(FRAME_MAX + 1));
  const k = new Joiner();
  assert.equal(big.map((p) => k.push(p)).at(-1), "invalid", "a frame past the cap");
});

// The process side, with a list folder, and the frames it sends to the relay.
function rig(lists: { counter: bigint; bytes: Uint8Array }[]) {
  const { dir } = accountFolder(lists);
  const folder = new ListFolder(dir, e2e, info(), () => {});
  folder.scan();
  const self = selfDevice(keys);
  const sent: Frame[] = [];
  const ready: Channel[] = [];
  const sessions: SessionFrame[] = [];
  const offered: Uint8Array[] = [];
  let connected = true;
  const host: ChannelHost = {
    accountId,
    staticKey: noise.staticKey(computerSecrets.channel),
    noise,
    refreshList: () => void folder.scan(),
    newestList: () => folder.newest,
    offerList: (b) => {
      offered.push(b);
      const o = folder.offer(b);
      if (o.result === "newer") channels.dropUnlisted(o.list);
      return o;
    },
    listed: () => !!folder.newest && listsSelf(folder.newest.body, self),
    sendFrame: (f) => (sent.push(f), connected),
    ready: (ch) => ready.push(ch),
    session: (_ch, s) => sessions.push(s),
    log: () => {},
  };
  const channels = new Channels(host);
  let next = 1n;
  // A client opening a channel; its messages delivered as the process sends them.
  async function open(name: string, opts: { counts?: boolean; list?: Uint8Array; secret?: Uint8Array } = {}) {
    const id = next++;
    const client = new ChannelClient(noise, opts.secret ?? channelSecret(name), computer.channelKey, accountId, (m) => {
      channels.onFrame(create(FrameSchema, { body: { case: "channelMessage", value: { channelId: id, message: m } } }));
    }, opts.counts ?? true);
    let seen = sent.length;
    const deliver = async () => {
      for (; seen < sent.length; seen++) {
        const b = sent[seen].body;
        if (b.case === "channelMessage" && b.value.channelId === id) await client.take(b.value.message);
      }
    };
    channels.onFrame(create(FrameSchema, { body: { case: "openChannel", value: { channelId: id, message: await client.message1() } } }));
    await settle();
    await deliver();
    const closed = () => {
      const f = sent.find((f) => f.body.case === "closeChannel" && f.body.value.channelId === id);
      return f?.body.case === "closeChannel" ? f.body.value.code : undefined;
    };
    return { id, client, deliver, closed };
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await tick();
  };
  return { channels, sent, ready, sessions, offered, open, settle, folder, disconnect: () => (connected = false) };
}

const v2 = version(2n, [phone, computer, alice]);
const v3 = version(3n, [phone, computer, alice, bob]);

test("a listed client: its list first, then the computer's counter and newer list, then ready", async () => {
  const r = rig([{ counter: 1n, bytes: v1 }, { counter: 3n, bytes: v3 }]);
  const a = await r.open("alice");
  assert.equal(a.closed(), undefined);
  assert.equal(a.client.frames.length, 0, "nothing before the client's list");
  a.client.sendList(v2);
  await r.settle();
  await a.deliver();
  const first = a.client.frames[0];
  assert.equal(first.body.case, "listState");
  assert.equal(first.body.value.counter, 3n);
  assert.deepEqual(first.body.value.list, v3, "newer than the client's, so sent");
  assert.equal(r.ready.length, 1);
  assert.deepEqual(r.ready[0].client?.signingKey, alice.signingKey);
  // A request goes to the process with its session.
  a.client.request("s1", create(SessionMessageSchema, { body: { case: "listPastSessions", value: { requestId: "r1" } } }));
  await r.settle();
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].sessionId, "s1");
});

test("the client's newer list is stored before the client is looked for", async () => {
  const r = rig([{ counter: 1n, bytes: v1 }, { counter: 2n, bytes: version(2n, [phone, computer]) }]);
  const b = await r.open("bob");
  b.client.sendList(v3);
  await r.settle();
  await b.deliver();
  assert.equal(b.closed(), undefined);
  assert.equal(r.folder.newest?.counter, 3n);
  const s = b.client.frames[0];
  assert.equal(s.body.case, "listState");
  assert.equal(s.body.value.counter, 3n);
  assert.equal(s.body.value.list.length, 0, "not newer than the client's");
});

test("refused: a client not listed, a forged list, anything before the list, a stranger's key", async () => {
  const cases: [string, (c: ChannelClient) => void, string?][] = [
    ["bob", (c) => c.sendList(v2)],
    ["alice", (c) => c.sendList(version(4n, [phone, computer, alice], new Uint8Array(32).fill(3)))],
    ["alice", (c) => c.request("s1", create(SessionMessageSchema, {}))],
    ["alice", (c) => c.send(create(ChannelFrameSchema, { body: { case: "received", value: 0n } }))],
    ["mallory", (c) => c.sendList(v2)],
  ];
  for (const [name, act] of cases) {
    const r = rig([{ counter: 2n, bytes: v2 }]);
    const c = await r.open(name);
    act(c.client);
    await r.settle();
    await c.deliver();
    assert.equal(c.closed(), ErrorCode.PERMISSION_DENIED, name);
    assert.equal(c.client.frames.length, 0, `${name}: nothing sent`);
    assert.equal(r.ready.length, 0);
  }
});

test("a list that drops this computer: the channel is refused", async () => {
  const r = rig([{ counter: 2n, bytes: v2 }]);
  const a = await r.open("alice");
  a.client.sendList(version(3n, [phone, alice]));
  await r.settle();
  assert.equal(a.closed(), ErrorCode.PERMISSION_DENIED);
  assert.equal(a.client.frames.length, 0);
});

test("a newer list closes the channels of clients it no longer has", async () => {
  const r = rig([{ counter: 3n, bytes: v3 }]);
  const a = await r.open("alice");
  a.client.sendList(v3);
  const b = await r.open("bob");
  b.client.sendList(v3);
  await r.settle();
  assert.equal(r.ready.length, 2);
  const a2 = await r.open("alice");
  a2.client.sendList(version(4n, [phone, computer, alice]));
  await r.settle();
  assert.equal(b.closed(), ErrorCode.PERMISSION_DENIED);
  assert.equal(a.closed(), undefined);
  assert.equal(a2.closed(), undefined);
});

test("a bad message 1, a bad message, a bad piece: the channel ends", async () => {
  const r = rig([{ counter: 2n, bytes: v2 }]);
  r.channels.onFrame(create(FrameSchema, { body: { case: "openChannel", value: { channelId: 50n, message: new Uint8Array(95) } } }));
  r.channels.onFrame(create(FrameSchema, { body: { case: "openChannel", value: { channelId: 51n, message: new Uint8Array(96) } } }));
  await r.settle();
  const code = (id: bigint) => r.sent.find((f) => f.body.case === "closeChannel" && f.body.value.channelId === id)?.body.value;
  assert.equal((code(50n) as { code: ErrorCode }).code, ErrorCode.INVALID);
  assert.equal((code(51n) as { code: ErrorCode }).code, ErrorCode.PERMISSION_DENIED);
  const a = await r.open("alice");
  a.client.raw(Uint8Array.of(7, 1, 2));
  await r.settle();
  assert.equal(a.closed(), ErrorCode.INVALID);
  const b = await r.open("alice");
  r.channels.onFrame(create(FrameSchema, { body: { case: "channelMessage", value: { channelId: b.id, message: new Uint8Array(40) } } }));
  await r.settle();
  assert.equal(b.closed(), ErrorCode.PERMISSION_DENIED);
  assert.equal(r.channels.size, 0);
});

test("responder states: at most 16 waiting for a list; the 17th is refused", async () => {
  const r = rig([{ counter: 2n, bytes: v2 }]);
  const waiting = [];
  for (let i = 0; i < MAX_WAITING; i++) waiting.push(await r.open("alice"));
  const late = await r.open("alice");
  assert.equal(late.closed(), ErrorCode.RATE_LIMITED);
  assert.ok(waiting.every((w) => w.closed() === undefined));
  // One becomes ready, and makes room.
  waiting[0].client.sendList(v2);
  await r.settle();
  const now = await r.open("alice");
  assert.equal(now.closed(), undefined);
});

test("a channel waiting for its list ends after 30 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const r = rig([{ counter: 2n, bytes: v2 }]);
  const a = await r.open("alice");
  t.mock.timers.tick(29_999);
  assert.equal(a.closed(), undefined);
  t.mock.timers.tick(1);
  assert.equal(a.closed(), ErrorCode.TIMEOUT);
});

test("flow: at most 32 messages in flight; received lets more go; the queue's cap ends the channel", async () => {
  const r = rig([{ counter: 2n, bytes: v2 }]);
  const a = await r.open("alice", { counts: false });
  a.client.sendList(v2);
  await r.settle();
  const ch = r.ready[0];
  const out = () => r.sent.filter((f) => f.body.case === "channelMessage" && f.body.value.channelId === a.id).length;
  const base = out();
  for (let i = 0; i < 100; i++) ch.sendSession({ $typeName: "pirc.v1alpha2.SessionFrame", sessionId: "s", body: { case: "message", value: new Uint8Array(10) } });
  // listState was one of the 32.
  assert.equal(out() - base, WINDOW_MESSAGES - 1);
  await a.deliver();
  a.client.send(create(ChannelFrameSchema, { body: { case: "received", value: a.client.received } }));
  await r.settle();
  assert.equal(out() - base, 2 * WINDOW_MESSAGES - 1);
  // A count beyond what was sent is refused.
  a.client.send(create(ChannelFrameSchema, { body: { case: "received", value: 10_000n } }));
  await r.settle();
  assert.equal(a.closed(), ErrorCode.INVALID);

  const b = await r.open("alice", { counts: false });
  b.client.sendList(v2);
  await r.settle();
  const chb = r.ready[1];
  const piece = new Uint8Array(PIECE_DATA_MAX - 100);
  let sent = 0;
  while (chb.sendSession({ $typeName: "pirc.v1alpha2.SessionFrame", sessionId: "s", body: { case: "message", value: piece } })) sent += piece.length;
  assert.ok(sent > QUEUE_BYTES - 2 * piece.length && sent < QUEUE_BYTES + WINDOW_BYTES + piece.length, `${sent}`);
  assert.equal(b.closed(), ErrorCode.RATE_LIMITED);
});

test("a frame of the largest size crosses in pieces", async () => {
  const r = rig([{ counter: 2n, bytes: v2 }]);
  const a = await r.open("alice");
  a.client.sendList(v2);
  await r.settle();
  const big = Uint8Array.from({ length: 1 << 20 }, (_, i) => i % 13);
  r.ready[0].sendSession({ $typeName: "pirc.v1alpha2.SessionFrame", sessionId: "s", body: { case: "message", value: big } });
  for (let i = 0; i < 5; i++) {
    await a.deliver();
    await r.settle();
  }
  const last = a.client.frames.at(-1)!;
  assert.equal(last.body.case, "session");
  assert.deepEqual(last.body.value.body.value, big);
  assert.equal(a.closed(), undefined);
});

test("the relay's CloseChannel ends it without an answer; a lost connection ends them all", async () => {
  const r = rig([{ counter: 2n, bytes: v2 }]);
  const a = await r.open("alice");
  r.channels.onFrame(create(FrameSchema, { body: { case: "closeChannel", value: { channelId: a.id, code: ErrorCode.SESSION_GONE } } }));
  assert.equal(a.closed(), undefined, "not echoed");
  assert.equal(r.channels.size, 0);
  const b = await r.open("alice");
  r.channels.closeAll(ErrorCode.SESSION_GONE, false);
  assert.equal(b.closed(), undefined);
  assert.equal(r.channels.size, 0);
});

test("the computer counts the client's messages, 8 at a time, and not the client's counts", async () => {
  const r = rig([{ counter: 2n, bytes: v2 }]);
  const a = await r.open("alice", { counts: false });
  a.client.sendList(v2);
  await r.settle();
  for (let i = 0; i < 7; i++) a.client.request("s", create(SessionMessageSchema, {}));
  await r.settle();
  await a.deliver();
  assert.deepEqual(a.client.counted, [8n], "the list and 7 requests");
  // Counts of the client's own are taken but not counted back.
  for (let i = 0; i < 20; i++) a.client.send(create(ChannelFrameSchema, { body: { case: "received", value: 1n } }));
  await r.settle();
  await a.deliver();
  assert.deepEqual(a.client.counted, [8n]);
  a.client.request("s", create(SessionMessageSchema, {}));
  for (let i = 0; i < 7; i++) a.client.request("s", create(SessionMessageSchema, {}));
  await r.settle();
  await a.deliver();
  assert.deepEqual(a.client.counted, [8n, 36n]);
});

test("a reply goes to the client's newest channel when the one it came on has closed", async () => {
  const r = rig([{ counter: 2n, bytes: v2 }]);
  const a = await r.open("alice");
  a.client.sendList(v2);
  await r.settle();
  const first = r.ready[0];
  const b = await r.open("alice");
  b.client.sendList(v2);
  await r.settle();
  assert.equal(r.channels.newestFor(alice.signingKey), r.ready[1], "the newer of two");
  first.close(ErrorCode.SESSION_GONE, false);
  assert.equal(r.channels.newestFor(alice.signingKey), r.ready[1]);
  assert.equal(r.channels.newestFor(bob.signingKey), undefined);
});
