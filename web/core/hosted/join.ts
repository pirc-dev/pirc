// Joining an account as a client (docs/e2e.md, section 5; docs/design.md,
// step 14, stage 5, decision D2): a second phone or a browser shows a code,
// a client of the account types it; CPace through the relay; then the
// chain is fetched and checked to reach the version that adds this device,
// signed by the client named as the approver, before anything is kept. A
// phone sends its attestation with the wait. The code is good for one try
// and ten minutes; a device whose join was cut off after its version was
// taken keeps its key and shows a new code, and is approved again (D7).
import { create } from "@bufbuild/protobuf";
import { DeviceRole, FrameSchema, type Attestation, type Frame, type LabelKeyRef } from "@pirc/protocol/v1alpha2";
import { HostedConnection } from "@pirc/relay-client/hosted";

import { equal } from "@pirc/crypto/bytes";
import { Chain } from "@pirc/crypto/chain";
import { DeviceJoin, JoinFailed, newCode } from "@pirc/crypto/join";
import { hash, open } from "@pirc/crypto/objects";

import { HostedClient, type ClientOptions } from "./account.ts";

export const JOIN_MS = 10 * 60_000;

export interface JoinAccountOptions extends ClientOptions {
  /** A phone's (docs/e2e.md, section 6); none for a browser. */
  attestation?: Attestation;
  /** The code to show, as K7QM-2XRP9, and until when it is good. */
  onCode(shown: string, until: Date): void;
  timeoutMs?: number;
}

export type JoinedAccount = { client: HostedClient; approverName: string };

/** Shows a code until a client of an account types it and approves this device, then keeps the account. */
export function joinAccount(o: JoinAccountOptions): { done: Promise<JoinedAccount>; cancel(): void } {
  let cancel = () => {};
  const done = new Promise<JoinedAccount>((resolve, reject) => {
    const code = newCode();
    const now = o.now ?? Date.now;
    let joinId = "";
    let device: DeviceJoin | undefined;
    let confirmed = false;
    let finished = false;
    let shown = false;
    let phase: "waiting" | "joining" | "fetching" = "waiting";
    let approval: { accountId: Uint8Array; versionHash: Uint8Array; number: bigint; approver: Uint8Array; approverName: string; labelKey?: { ref: LabelKeyRef; key: Uint8Array } } | undefined;
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

    // One frame at a time, as the host's side (extension/src/hosted/join.ts).
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
          if (joinId) return;
          joinId = b.value.joinId;
          phase = "joining";
          const s = await DeviceJoin.start(conn.origin, code, { role: DeviceRole.CLIENT, signer: o.signer, name: o.name });
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
          if (result.case !== "approval") return fail("the client refused this device");
          const a = result.value;
          const v = a.version && (await open("list", a.accountId, a.version));
          if (a.accountId.length !== 32 || !a.version || !v) throw new JoinFailed("the approval's version does not check");
          if (!equal(v.signer, a.approver)) throw new JoinFailed("the approval's version is not signed by the client named as approving it");
          if (!v.devices.some((d) => d.role === DeviceRole.CLIENT && equal(d.publicKey, o.signer.publicKey))) throw new JoinFailed("the approval's version does not add this device");
          approval = {
            accountId: a.accountId,
            versionHash: await hash(a.version),
            number: v.number,
            approver: a.approver,
            approverName: a.approverName,
            labelKey: a.labelKeyRef && a.labelKey.length === 32 ? { ref: a.labelKeyRef, key: a.labelKey } : undefined,
          };
          conn.send(create(FrameSchema, { body: { case: "joinEnded", value: { joinId } } }));
          joinId = "";
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
          if (!chain.onBranch(approval.number, approval.versionHash)) throw new JoinFailed("the relay's chain does not reach the approved version");
          const before = chain.at(approval.number - 1n);
          if (!before?.body.devices.some((d) => d.role === DeviceRole.CLIENT && equal(d.publicKey, approval!.approver))) throw new JoinFailed("the approver was not a client of the account");
          if (!chain.latest.body.devices.some((d) => equal(d.publicKey, o.signer.publicKey))) throw new JoinFailed("this device is not on the account's latest version");
          end();
          const client = await HostedClient.joined(o, approval.accountId, chain, approval.labelKey);
          resolve({ client, approverName: approval.approverName });
          return;
        }
      }
    };

    const conn = new HostedConnection({
      origin: o.origin,
      accountId: new Uint8Array(0),
      signer: o.signer,
      open: o.open,
      onFrame,
      onState: (s) => {
        if (finished) return;
        if (s.kind === "ready" && phase === "waiting") {
          conn.send(create(FrameSchema, { body: { case: "joinWait", value: { lookup: code.lookup, attestation: o.attestation } } }));
          if (!shown) o.onCode(code.shown, new Date(now() + (o.timeoutMs ?? JOIN_MS)));
          shown = true;
        } else if (s.kind === "ready" && phase === "fetching") {
          conn.send(create(FrameSchema, { body: { case: "getVersions", value: { requestId: "join", from: 1n } } }));
        } else if (s.kind === "offline" && phase === "joining") {
          fail(`the connection to the relay was lost: ${s.reason}`);
        } else if (s.kind === "unsupported" || (s.kind === "refused" && phase !== "fetching")) {
          fail(s.reason);
        }
      },
      onError: (where, e) => o.log?.(`join ${where}: ${(e as Error).message}`),
    });
    conn.start();
  });
  return { done, cancel: () => cancel() };
}
