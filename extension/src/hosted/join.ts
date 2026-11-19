// /pirc join, the host's side (docs/e2e.md, section 5): a code shown at the
// terminal, typed into a client of the account; CPace through the relay;
// then the chain fetched and checked to end at the version that adds this
// host, signed by the client that approved it, before the anchor is
// written. The code is good for one try and ten minutes.
import { create } from "@bufbuild/protobuf";
import { DeviceRole, FrameSchema, type Frame, type VersionRef } from "@pirc/protocol/v1alpha2";
import { HostedConnection } from "@pirc/relay-client/hosted";
import { wsSocket } from "@pirc/relay-client/hosted-ws";

import { equal, hex } from "@pirc/crypto/bytes";
import { Chain } from "@pirc/crypto/chain";
import type { Signer } from "@pirc/crypto/ed25519";
import { DeviceJoin, JoinFailed, newCode } from "@pirc/crypto/join";
import { hash, open } from "@pirc/crypto/objects";

import { Anchor } from "./anchor.ts";

export const JOIN_MS = 10 * 60_000;

export interface JoinOptions {
  origin: string;
  signer: Signer;
  /** What this machine would like to be shown as. */
  name: string;
  /** The code to show, as K7QM-2XRP9, and until when it is good. */
  onCode(shown: string, until: Date): void;
  log(msg: string): void;
  timeoutMs?: number;
  /** For tests: where the anchor is written. */
  anchorDir?: string;
}

export type Joined = { anchor: Anchor; approverName: string };

export function join(o: JoinOptions): { done: Promise<Joined>; cancel(): void } {
  let cancel = () => {};
  const done = new Promise<Joined>((resolve, reject) => {
    const code = newCode();
    let joinId = "";
    let device: DeviceJoin | undefined;
    let confirmed = false;
    let finished = false;
    let shown = false;
    let phase: "waiting" | "joining" | "fetching" = "waiting";
    let approval: { accountId: Uint8Array; versionHash: Uint8Array; number: bigint; latest: VersionRef; approver: Uint8Array; approverName: string } | undefined;
    const timer = setTimeout(() => fail("the code expired"), o.timeoutMs ?? JOIN_MS);
    const end = () => {
      finished = true;
      clearTimeout(timer);
      conn.stop();
    };
    const fail = (why: string) => {
      if (finished) return;
      if (joinId) conn.send(create(FrameSchema, { body: { case: "joinEnded", value: { joinId } } }));
      end();
      reject(new JoinFailed(why));
    };
    cancel = () => fail("cancelled");
    const send = (step: Uint8Array) => conn.send(create(FrameSchema, { body: { case: "joinMessage", value: { joinId, step } } }));

    // One frame at a time: a step's handling waits on the cryptography,
    // and the client's JoinEnded may follow its result at once.
    let inbox: Promise<void> = Promise.resolve();
    const onFrame = (f: Frame) => {
      inbox = inbox.then(() => handle(f)).catch((e) => fail(e instanceof JoinFailed ? e.message : `${(e as Error).message}`));
    };
    const handle = async (f: Frame) => {
      if (finished) return;
      const b = f.body;
      switch (b.case) {
        case "error":
          if (phase === "fetching") return fail(`the relay: ${b.value.message}`);
          return fail(b.value.message || "the relay refused the join");
        case "joinPaired": {
          if (joinId || phase !== "waiting") return;
          joinId = b.value.joinId;
          phase = "joining";
          const s = await DeviceJoin.start(conn.origin, code, { role: DeviceRole.HOST, signer: o.signer, name: o.name });
          device = s.join;
          send(s.offer);
          return;
        }
        case "joinMessage": {
          if (b.value.joinId !== joinId || !device) return;
          if (!confirmed) {
            confirmed = true;
            send(await device.onAnswer(b.value.step));
            return;
          }
          const result = await device.onResult(b.value.step);
          if (result.case !== "approval") return fail("the client refused this computer");
          const a = result.value;
          const v = a.version && (await open("list", a.accountId, a.version));
          if (a.accountId.length !== 32 || !a.version || !v) throw new JoinFailed("the approval's version does not check");
          if (!equal(v.signer, a.approver)) throw new JoinFailed("the approval's version is not signed by the client that approved it");
          if (!v.devices.some((d) => d.role === DeviceRole.HOST && equal(d.publicKey, o.signer.publicKey))) throw new JoinFailed("the approval's version does not add this computer");
          if (!a.latest || a.latest.number < v.number) throw new JoinFailed("the approval names no latest version of the client's");
          approval = { accountId: a.accountId, versionHash: await hash(a.version), number: v.number, latest: a.latest, approver: a.approver, approverName: a.approverName };
          conn.send(create(FrameSchema, { body: { case: "joinEnded", value: { joinId } } }));
          joinId = "";
          // The chain, from the account: this host is on its list now.
          phase = "fetching";
          conn.switchAccount(a.accountId);
          return;
        }
        case "joinEnded":
          if (b.value.joinId === joinId) return fail("the client ended the join");
          return;
        case "versions": {
          if (phase !== "fetching" || b.value.requestId !== "join" || !approval) return;
          const [v1, ...rest] = b.value.versions;
          if (!v1) throw new JoinFailed("the relay sent no version 1");
          const chain = await Chain.start(v1, approval.accountId);
          await chain.add(rest, b.value.withdrawals);
          // It hashes to the account, chains, and has the approval's
          // version on its branch, signed by that client.
          if (!chain.onBranch(approval.number, approval.versionHash)) throw new JoinFailed("the relay's chain does not reach the approved version");
          // As far as the approver's latest: a relay cannot hand a host
          // approved again a list from before a later removal.
          if (!chain.onBranch(approval.latest.number, approval.latest.hash)) throw new JoinFailed("the relay's chain does not reach the approving client's latest version");
          const before = chain.at(approval.number - 1n);
          if (!before?.body.devices.some((d) => d.role === DeviceRole.CLIENT && equal(d.publicKey, approval!.approver))) throw new JoinFailed("the approver was not a client of the account");
          if (!chain.latest.body.devices.some((d) => equal(d.publicKey, o.signer.publicKey))) throw new JoinFailed("this computer is not on the account's latest version");
          const anchor = await Anchor.create({
            origin: conn.origin,
            accountId: hex(approval.accountId),
            joined: { number: String(approval.number), hash: hex(approval.versionHash) },
            joinedAt: new Date().toISOString(),
            approver: hex(approval.approver),
            approverName: approval.approverName,
          }, chain, o.anchorDir);
          end();
          resolve({ anchor, approverName: approval.approverName });
          return;
        }
      }
    };

    const conn = new HostedConnection({
      origin: o.origin,
      accountId: new Uint8Array(0),
      signer: o.signer,
      open: wsSocket,
      onFrame,
      onState: (s) => {
        if (finished) return;
        if (s.kind === "ready" && phase === "waiting") {
          // Again after a reconnect, which the relay forgets the wait with;
          // shown once.
          conn.send(create(FrameSchema, { body: { case: "joinWait", value: { lookup: code.lookup } } }));
          if (!shown) o.onCode(code.shown, new Date(Date.now() + (o.timeoutMs ?? JOIN_MS)));
          shown = true;
        } else if (s.kind === "ready" && phase === "fetching") {
          conn.send(create(FrameSchema, { body: { case: "getVersions", value: { requestId: "join", from: 1n } } }));
        } else if (s.kind === "offline" && phase === "joining") {
          // The relay forgot the join with the connection.
          fail(`the connection to the relay was lost: ${s.reason}`);
        } else if (s.kind === "unsupported" || (s.kind === "refused" && phase !== "fetching")) {
          fail(s.reason);
        }
      },
      onError: (where, e) => o.log(`join ${where}: ${(e as Error).message}`),
    });
    conn.start();
  });
  return { done, cancel: () => cancel() };
}
