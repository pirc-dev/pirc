// A test account: a phone, this computer, two clients, and the lists the
// phone signs for them, from e2e/test/make.ts's fixed seeds.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROLE_CLIENT, ROLE_COMPUTER } from "@pirc/e2e";
import { body, boxSecrets, device, makeList, seed, sha256, type Dev } from "../../e2e/test/make.ts";

import { writeAccount, type AccountInfo, type Secrets } from "../src/account.ts";

export const phone = device("phone", ROLE_CLIENT, true);
export const computer = device("computer", ROLE_COMPUTER, false);
export const alice = device("alice", ROLE_CLIENT, false);
export const bob = device("bob", ROLE_CLIENT, false);
export const other = device("other computer", ROLE_COMPUTER, false);

const EMPTY = new Uint8Array(0);
const phoneSeed = seed("phone signing");
const v1Body = body({ accountId: EMPTY, counter: 1n, previousHash: EMPTY, devices: [phone] });
export const accountId = sha256(v1Body);
export const v1 = makeList({ seed: phoneSeed, accountId: EMPTY, counter: 1n, previousBody: null, devices: [phone] });

/** Version n of the list, holding `devices`, built on `previous` (a signed
 * version; version 1 if not given). The relay takes only a version built
 * on the one it holds. */
export function version(counter: bigint, devices: Dev[], signer = phoneSeed, previous?: Uint8Array): Uint8Array {
  return makeList({ seed: signer, accountId, counter, previousBody: previous ? previous.subarray(64) : v1Body, devices });
}

export const computerSecrets: Secrets = {
  signing: seed("computer signing"),
  channel: boxSecrets("computer").channel,
  box: boxSecrets("computer").box,
};

export function channelSecret(name: string): Uint8Array {
  return boxSecrets(name).channel;
}

export const info = (origin = "ws://127.0.0.1:1"): AccountInfo => ({ accountId, phoneKey: phone.signingKey, origin });

/** An account folder in a fresh temporary config folder, with these lists. */
export function accountFolder(lists: { counter: bigint; bytes: Uint8Array }[], origin?: string): { config: string; dir: string } {
  const config = mkdtempSync(join(tmpdir(), "pirc-account-"));
  const dir = join(config, "account");
  writeAccount(dir, computerSecrets, info(origin), lists);
  return { config, dir };
}
