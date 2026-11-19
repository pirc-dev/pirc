// The account's device list (docs/e2e.md, section 3): checking a version
// against the one before it, a withdrawal against the version it
// withdraws, and a pre-key against the list. Pure, so that the relay, the
// hosts and the clients decide alike; cases/e2e holds what they must
// decide.

import type { SignedObject } from "@pirc/protocol/v1alpha2";
import { DeviceRole, type ListVersionBody, type PreKeyBody, type WithdrawalBody } from "@pirc/protocol/v1alpha2";
import { compare, equal } from "./bytes.ts";
import { hash, open } from "./objects.ts";

export type Version = { body: ListVersionBody; hash: Uint8Array; object: SignedObject };

/** Why a version, a withdrawal or a pre-key is refused. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

const ROLES = new Set([DeviceRole.HOST, DeviceRole.CLIENT, DeviceRole.READ_ONLY]);
/**
 * An account's caps (docs/e2e.md, section 3): 256 hosts, and 32 clients,
 * each with at most its read-only key. A client costs every host a wrap in
 * each bundle, and its pre-key's renewal a new bundle; a host costs one
 * entry on the list.
 */
export const MAX_HOSTS = 256;
export const MAX_CLIENTS = 32;

/** Whether `devices` holds no more of `role` than the caps allow. */
export function withinCaps(devices: readonly { role: DeviceRole }[]): string | undefined {
  const n = (r: DeviceRole) => devices.filter((d) => d.role === r).length;
  if (n(DeviceRole.HOST) > MAX_HOSTS) return "more than 256 hosts";
  if (n(DeviceRole.CLIENT) > MAX_CLIENTS || n(DeviceRole.READ_ONLY) > MAX_CLIENTS) return "more than 32 clients";
  return undefined;
}

const time = (t: { seconds: bigint; nanos: number } | undefined): bigint =>
  t ? t.seconds * 1000n + BigInt(Math.floor(t.nanos / 1e6)) : -1n;

export function device(v: ListVersionBody, key: Uint8Array) {
  return v.devices.find((d) => equal(d.publicKey, key));
}

export const isClient = (v: ListVersionBody, key: Uint8Array): boolean => device(v, key)?.role === DeviceRole.CLIENT;

/** What every version must be on its own. */
function checkShape(v: ListVersionBody): void {
  if (v.devices.length === 0 || v.devices.length > MAX_HOSTS + 2 * MAX_CLIENTS) throw new Refused("wrong number of devices");
  const over = withinCaps(v.devices);
  if (over) throw new Refused(over);
  for (let i = 0; i < v.devices.length; i++) {
    const d = v.devices[i];
    if (d.publicKey.length !== 32) throw new Refused("a device key is not 32 bytes");
    if (!ROLES.has(d.role)) throw new Refused("a device has no role");
    if (i > 0 && compare(v.devices[i - 1].publicKey, d.publicKey) >= 0) throw new Refused("devices not in order, or repeated");
    if (!d.addedAt) throw new Refused("a device has no time added");
    if (d.role === DeviceRole.READ_ONLY) {
      if (!isClient(v, d.owner)) throw new Refused("a read-only key whose client is not on the list");
    } else if (d.owner.length) throw new Refused("an owner on a device that is not a read-only key");
  }
  if (!v.devices.some((d) => d.role === DeviceRole.CLIENT)) throw new Refused("no client left");
  if (v.withdrawn.some((h) => h.length !== 32)) throw new Refused("a withdrawn hash is not 32 bytes");
}

/** Version 1: its body's hash is the account ID; one client, which signs it. */
export async function checkFirst(obj: SignedObject): Promise<Version> {
  const body = await open("list", new Uint8Array(0), obj);
  if (!body) throw new Refused("the signature does not check, or the body names another signer");
  if (body.number !== 1n || body.previous.length) throw new Refused("not version 1");
  checkShape(body);
  const [d] = body.devices;
  if (body.devices.length !== 1 || d.role !== DeviceRole.CLIENT) throw new Refused("version 1 holds one client");
  if (!equal(d.publicKey, body.signer) || d.addedBy.length) throw new Refused("version 1 is signed by its one device");
  if (body.withdrawn.length) throw new Refused("version 1 withdraws nothing");
  return { body, hash: await hash(obj), object: obj };
}

/** A version after `prev`: chained, signed by a client in `prev`, changing devices only as a client may. */
export async function checkNext(accountId: Uint8Array, prev: Version, obj: SignedObject): Promise<Version> {
  const body = await open("list", accountId, obj);
  if (!body) throw new Refused("the signature does not check, or the body names another signer");
  if (body.number !== prev.body.number + 1n) throw new Refused("not the next number");
  if (!equal(body.previous, prev.hash)) throw new Refused("does not chain from the version before");
  if (!isClient(prev.body, body.signer)) throw new Refused("not signed by a client in the version before");
  checkShape(body);
  for (const d of body.devices) {
    const before = device(prev.body, d.publicKey);
    if (before) {
      if (before.role !== d.role || !equal(before.addedBy, d.addedBy) || !equal(before.owner, d.owner) || time(before.addedAt) !== time(d.addedAt))
        throw new Refused("a device kept but changed");
    } else {
      if (!equal(d.addedBy, body.signer)) throw new Refused("a new device not added by the signer");
      if (d.role === DeviceRole.READ_ONLY && !equal(d.owner, body.signer)) throw new Refused("a read-only key added by another client than its own");
    }
  }
  for (const h of prev.body.withdrawn) if (!body.withdrawn.some((w) => equal(w, h))) throw new Refused("a withdrawal dropped");
  return { body, hash: await hash(obj), object: obj };
}

/** A withdrawal of `withdrawn`, by its own signer, in favour of another version with its number. */
export async function checkWithdrawal(accountId: Uint8Array, withdrawn: Version, obj: SignedObject): Promise<WithdrawalBody> {
  const body = await open("withdrawal", accountId, obj);
  if (!body) throw new Refused("the signature does not check, or the body names another signer");
  if (!equal(body.signer, withdrawn.body.signer)) throw new Refused("not withdrawn by its own signer");
  const w = body.withdrawn, win = body.winner;
  if (!w || !win || w.number !== withdrawn.body.number || !equal(w.hash, withdrawn.hash)) throw new Refused("names another version");
  if (win.number !== w.number || win.hash.length !== 32 || equal(win.hash, w.hash)) throw new Refused("the winner is not another version with its number");
  return body;
}

export const PRE_KEY_MAX_MS = 14n * 24n * 3600n * 1000n;

/** A pre-key of a client or a read-only key on `list`, current at `nowMs`. */
export async function checkPreKey(accountId: Uint8Array, list: ListVersionBody, obj: SignedObject, nowMs: bigint): Promise<PreKeyBody> {
  const body = await open("pre-key", accountId, obj);
  if (!body) throw new Refused("the signature does not check, or the body names another signer");
  const role = device(list, body.signer)?.role;
  if (role !== DeviceRole.CLIENT && role !== DeviceRole.READ_ONLY) throw new Refused("not a client's or a read-only key's");
  if (body.preKey.length !== 32) throw new Refused("the pre-key is not 32 bytes");
  const made = time(body.madeAt), expires = time(body.expiresAt);
  if (made < 0n || expires <= made || expires - made > PRE_KEY_MAX_MS) throw new Refused("lives longer than 14 days");
  if (nowMs >= expires) throw new Refused("expired");
  return body;
}
