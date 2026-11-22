// The account's device list (docs/e2e.md, sections 2 and 3), checked over
// libsodium, with no I/O. libsodium starts asynchronously, so its checks
// are reached through load(), which resolves once it has started.
//
// framed has a module of its own, @pirc/e2e/framed, that loads no
// libsodium.
import sodium from "libsodium-wrappers-sumo";

import { checkList, type ListInput, type ListResult } from "./list.ts";

export { framed, framedNumber } from "./framed.ts";
export {
  LIST_CONTEXT,
  LIST_MAX_BYTES,
  MAX_CLIENTS,
  MAX_COMPUTERS,
  ROLE_CLIENT,
  ROLE_COMPUTER,
  type DeviceKeys,
  type ListInput,
  type ListRefusedReason,
  type ListResult,
  type ListUnsupportedReason,
} from "./list.ts";

export interface E2e {
  /** A version of the device list, checked as docs/e2e.md section 3 says. */
  checkList(input: ListInput): ListResult;
}

let loaded: Promise<E2e> | undefined;

/**
 * The checks, once libsodium has started. Every call gives the same object;
 * if the start fails, the next call tries again.
 */
export function load(): Promise<E2e> {
  loaded ??= sodium.ready.then(
    () => ({ checkList: (input: ListInput) => checkList(sodium, input) }),
    (e: unknown) => {
      loaded = undefined;
      throw e;
    },
  );
  return loaded;
}
