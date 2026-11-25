// The computer's hosted link (hosted.ts) against the Go relay's hosted
// mode: logged in with the account's keys, its session sealed to the
// clients and opened by one, a channel through the relay with the list
// first and requests answered, and a newer list from the relay closing a
// removed client's channel and sealing again. A pi process's whole use of
// it, across apps, is the end to end test (design.md step 14, part 9).
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { load as loadE2e } from "@pirc/e2e";
import { load as loadNoise } from "@pirc/e2e/noise";
import { ErrorCode, SessionAnnouncementSchema, SessionMessageSchema, type SessionMessage } from "@pirc/protocol";
import { DeviceRole, FrameSchema, type Frame } from "@pirc/protocol/v1alpha2";
import { HostedConnection, type Signer } from "@pirc/relay-client/hosted";
import { wsSocket } from "@pirc/relay-client/hosted-ws";
import { boxSecrets, notificationSecret, openNotice, readOnlyPair, signingPair } from "../../e2e/test/make.ts";

import { Harness, startHostedRelay } from "../../test/harness.ts";
import { Hosted, type HostedStatus } from "../src/hosted.ts";
import type { Live } from "../src/live.ts";
import { removeAccount } from "../src/account.ts";
import { accountFolder, accountId, alice, bob, channelSecret, computer, phone, v1, version } from "./account-fixture.ts";
import { ChannelClient } from "./channel-client.ts";

const h = new Harness();
// Stopped even when a test fails, or their retries keep the process alive.
const running: { stop(): void }[] = [];
after(() => {
  for (const r of running) r.stop();
  return h.close();
});
const relay = await startHostedRelay(h);
const e2e = await loadE2e();
const noise = await loadNoise();

function signer(name: string): Signer {
  const p = signingPair(name);
  return { publicKey: p.publicKey, sign: async (m) => p.sign(m) };
}

async function until<T>(what: string, find: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = find();
    if (got !== undefined) return got;
    if (Date.now() > deadline) throw new Error(`waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The phone's read-only key, which fetches the notices sealed to it.
function readOnly(): Signer {
  const p = readOnlyPair("phone");
  return { publicKey: p.publicKey, sign: async (m) => p.sign(m) };
}

function device(name: string, account: Uint8Array, as: Signer = signer(name)) {
  const frames: Frame[] = [];
  const conn = new HostedConnection({ origin: relay.origin, accountId: account, signer: as, open: wsSocket, onFrame: (f) => frames.push(f), minBackoffMs: 50 });
  conn.start();
  running.push(conn);
  const taken = new Set<Frame>();
  const next = <T>(what: string, pick: (f: Frame) => T | undefined) =>
    until(what, () => {
      for (const f of frames) {
        if (taken.has(f)) continue;
        const v = pick(f);
        if (v !== undefined) {
          taken.add(f);
          return v;
        }
      }
      return undefined;
    });
  return { conn, frames, next, ready: () => until(`${name} ready`, () => (conn.current.kind === "ready" ? conn.current.welcome : undefined)) };
}

const v2 = version(2n, [phone, computer, alice, bob]);
// Bob removed, given to the computer by alice before the relay has it.
const v3 = version(3n, [phone, computer, alice], undefined, v2);
// Version 4 drops the computer; version 5 puts it back.
const v4 = version(4n, [phone, alice], undefined, v3);
const v5 = version(5n, [phone, computer, alice], undefined, v4);
const SESSION = "0194f3e2-7c1a-7000-8000-000000000002";

test("a computer in an account: sealed announcements, a channel, a removal", async () => {
  // The phone signs up and puts the computer and alice on the list.
  const p = device("phone", new Uint8Array(0));
  await p.ready();
  p.conn.send(create(FrameSchema, { body: { case: "signUp", value: { requestId: "s", attestation: { kind: { case: "test", value: new Uint8Array([1]) } }, list: v1 } } }));
  await p.next("SignedUp", (f) => (f.body.case === "signedUp" ? f : undefined));
  p.conn.switchAccount(accountId);
  assert.equal((await p.ready()).role, DeviceRole.CLIENT);
  p.conn.send(create(FrameSchema, { body: { case: "publishList", value: { requestId: "p2", list: v2 } } }));
  await p.next("Done", (f) => (f.body.case === "done" ? f : undefined));

  // The computer, from its account folder holding versions 1 and 2.
  const { dir } = accountFolder([{ counter: 1n, bytes: v1 }, { counter: 2n, bytes: v2 }], relay.origin);
  const statuses: HostedStatus[] = [];
  const requests: SessionMessage[] = [];
  const announcement = create(SessionAnnouncementSchema, { name: "fix the build", cwd: "/work", model: { provider: "p", id: "m1", name: "Model One" }, notice: { number: BigInt(Date.now()), text: "May I run the tests?" } });
  const live = { sessionId: SESSION, announcement: () => announcement } as unknown as Live;
  let hosted: Hosted | undefined;
  hosted = await Hosted.open(dir, {
    instanceId: "i1",
    computerName: "build box",
    lives: () => [live],
    announce: (l) => void hosted!.announce(l),
    request: (sessionId, clientKey, m, deliver) => {
      requests.push(m);
      assert.equal(sessionId, SESSION);
      assert.deepEqual(clientKey, alice.signingKey);
      deliver(create(SessionMessageSchema, { body: { case: "error", value: { requestId: "r1", message: "echo" } } }));
    },
    onStatus: (s) => {
      statuses.push(s);
      if (s.kind === "ready") hosted!.announce(live);
    },
    log: () => {},
    fail: (where, e) => assert.fail(`${where}: ${e}`),
  });
  hosted.start();
  running.push(hosted);
  await until("computer ready", () => (hosted!.current.kind === "ready" ? true : undefined));

  // Alice sees the session, sealed to her, and opens it.
  const a = device("alice", accountId);
  await a.ready();
  a.conn.send(create(FrameSchema, { body: { case: "subscribeSessions", value: {} } }));
  const entry = await a.next("the session", (f) => {
    if (f.body.case === "sessionList") return f.body.value.sessions.find((s) => s.sealed.length > 0);
    if (f.body.case === "sessionUpdated" && f.body.value.entry?.sealed.length) return f.body.value.entry;
    return undefined;
  });
  const slot = { accountId, computerKey: computer.signingKey, sessionId: new TextEncoder().encode(SESSION) };
  const opened = e2e.openAnnouncement({ sealed: entry.sealed, slot, recipientSecretKey: boxSecrets("alice").box, list: { counter: 2n, devices: [phone, computer, alice, bob] }, highest: null, now: BigInt(Date.now()) });
  assert.equal(opened.result, "accepted");
  assert.deepEqual(opened.result === "accepted" && opened.body, { sessionName: "fix the build", folder: "/work", model: "Model One", computerName: "build box", notice: "May I run the tests?" });

  // The phone's notice, by its read-only key.
  const notification = notificationSecret("phone");
  const notice = async (list: { counter: bigint; devices: (typeof phone)[] }, n: number): Promise<bigint> => {
    const ro = device("phone read-only", accountId, readOnly());
    await ro.ready();
    ro.conn.send(create(FrameSchema, { body: { case: "fetchNotices", value: { requestId: `n${n}` } } }));
    const got = await ro.next("Notices", (f) => (f.body.case === "notices" ? f.body.value.notices : undefined));
    ro.conn.stop();
    assert.equal(got.length, 1);
    const o = openNotice({ sealed: got[0].sealed, slot, recipientSecretKey: notification, list, highest: null, now: BigInt(Date.now()) });
    assert.equal(o.result, "accepted");
    return o.result === "accepted" ? o.ordering : -1n;
  };
  const noticeOrdering = await notice({ counter: 2n, devices: [phone, computer, alice, bob] }, 1);
  assert.equal(noticeOrdering, announcement.notice!.number);

  // A channel: IK through the relay, the list first, then the session.
  let opens = 0;
  async function channel(d: typeof a, name: string) {
    let channelId = 0n;
    const client = new ChannelClient(noise, channelSecret(name), computer.channelKey, accountId, (m) =>
      d.conn.send(create(FrameSchema, { body: { case: "channelMessage", value: { channelId, message: m } } })),
    );
    const id = `o${++opens}`;
    d.conn.send(create(FrameSchema, { body: { case: "openChannel", value: { requestId: id, hostKey: computer.signingKey, instanceId: "i1", message: await client.message1() } } }));
    channelId = await d.next("ChannelOpened", (f) => (f.body.case === "channelOpened" && f.body.value.requestId === id ? f.body.value.channelId : undefined));
    let delivered = 0;
    const deliverAll = async () => {
      const msgs = d.frames.filter((f) => f.body.case === "channelMessage" && f.body.value.channelId === channelId);
      for (; delivered < msgs.length; delivered++) await client.take((msgs[delivered].body.value as { message: Uint8Array }).message);
    };
    const wait = async (what: string, ok: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!ok()) {
        if (Date.now() > deadline) throw new Error(`waiting for ${what}`);
        await deliverAll();
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await wait("message 2", () => delivered > 0);
    const closed = () => d.frames.find((f) => f.body.case === "closeChannel" && f.body.value.channelId === channelId)?.body.value as { code: ErrorCode } | undefined;
    return { client, wait, closed };
  }
  const { client, wait } = await channel(a, "alice");
  client.sendList(v2);
  await wait("the announcement", () => client.sessions().some((s) => "announcement" in s));
  assert.equal(client.frames[0].body.case, "listState");
  const ann = client.sessions().find((s) => "announcement" in s);
  assert.ok(ann && "announcement" in ann && ann.announcement.name === "fix the build" && ann.sessionId === SESSION);
  client.request(SESSION, create(SessionMessageSchema, { body: { case: "listPastSessions", value: { requestId: "r1" } } }));
  await wait("the reply", () => client.sessions().some((s) => "message" in s));
  assert.equal(requests.length, 1);

  // Bob has a channel; alice brings version 3, without bob, before the
  // relay has it. The computer stores it, closes bob's channel itself,
  // gives the version to the relay, and seals again for the new list.
  const b = device("bob", accountId);
  await b.ready();
  const bc = await channel(b, "bob");
  bc.client.sendList(v2);
  await bc.wait("bob's announcement", () => bc.client.sessions().some((s) => "announcement" in s));
  const a2 = await channel(a, "alice");
  a2.client.sendList(v3);
  await a2.wait("alice's second channel", () => a2.client.frames.length > 0);
  assert.equal(hosted!.listCounter, 3n);
  await until("bob's channel closed by the computer", () => bc.closed());
  assert.equal(bc.closed()!.code, ErrorCode.PERMISSION_DENIED);
  const late = device("alice", accountId);
  await until("the relay has version 3", () => (late.conn.current.kind === "ready" && late.conn.current.welcome.listCounter === 3n ? true : undefined));
  late.conn.stop();
  // Sealed again for the new list, the notice keeps its value: it is not a new one.
  assert.equal(await notice({ counter: 3n, devices: [phone, computer, alice] }, 2), noticeOrdering);

  // Version 4 drops the computer: it stops, removed.
  p.conn.send(create(FrameSchema, { body: { case: "publishList", value: { requestId: "p4", list: v4 } } }));
  await until("removed", () => (hosted!.current.kind === "removed" ? true : undefined));
  assert.ok(statuses.some((s) => s.kind === "removed"));
  hosted.stop();
  for (const d of [p, a, b]) d.conn.stop();
});

test("another process leaves the account: this one stops, left", async () => {
  // The account from the test before, with the computer back on the list.
  const p = device("phone", accountId);
  await p.ready();
  p.conn.send(create(FrameSchema, { body: { case: "publishList", value: { requestId: "p5", list: v5 } } }));
  await p.next("Done", (f) => (f.body.case === "done" ? f : undefined));
  const { dir } = accountFolder([{ counter: 1n, bytes: v1 }, { counter: 5n, bytes: v5 }], relay.origin);
  const statuses: string[] = [];
  const sink = (n: string) => ({ instanceId: n, computerName: "c", lives: () => [], announce: () => {}, request: () => {}, onStatus: (s: HostedStatus) => statuses.push(`${n} ${s.kind}`), log: () => {}, fail: () => {} });
  const one = await Hosted.open(dir, sink("one"), { rescanMs: 100 });
  const two = await Hosted.open(dir, sink("two"), { rescanMs: 100 });
  running.push(one, two);
  one.start();
  two.start();
  await until("both ready", () => (one.current.kind === "ready" && two.current.kind === "ready" ? true : undefined));
  // One leaves (host.ts: stop, then remove the folder); the other notices.
  one.stop();
  removeAccount(dir);
  await until("two left", () => (two.current.kind === "left" ? true : undefined));
  p.conn.stop();
});
