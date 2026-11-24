// The account's shared pieces (docs/e2e.md, sections 2, 3 and 5) over
// libsodium, with no I/O: the device list's check, sealing and opening a
// session's announcement, and opening the devices' names. libsodium starts asynchronously, so its checks
// are reached through load(), which resolves once it has started.
//
// framed has a module of its own, @pirc/e2e/framed, that loads no
// libsodium.
import sodium from "libsodium-wrappers-sumo";

import { checkOffer, type OfferResult } from "./join.ts";
import { checkList, type ListInput, type ListResult } from "./list.ts";
import { openNames, type NamesInput, type NamesResult } from "./names.ts";
import { openAnnouncement, seal, type AnnouncementText, type OpenInput, type OpenResult, type SealInput, type Sealed } from "./sealed.ts";

export { framed, framedNumber } from "./framed.ts";
export {
  base32,
  fromBase32,
  JOIN_CONTEXT,
  JOIN_TEXT_CHARS,
  JOIN_TEXT_PREFIX,
  JOIN_VERSION,
  joinPrologue,
  joinText,
  makeOffer,
  newLookup,
  offerSigned,
  readJoinText,
  SECRET_BYTES,
  type OfferRefusedReason,
  type OfferResult,
} from "./join.ts";
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
export { NAME_MAX_BYTES, NAMES_CONTEXT, NAMES_MAX_BYTES, type DeviceName, type NamesInput, type NamesRefusedReason, type NamesResult } from "./names.ts";
export {
  ANNOUNCEMENT_CONTEXT,
  CAPS,
  FUTURE_MS,
  NOTICE_CONTEXT,
  SEALED_MAX_BYTES,
  SESSION_ID_MAX_BYTES,
  type AnnouncementText,
  type Kind,
  type ListView,
  type NoticeText,
  type OpenInput,
  type OpenResult,
  type SealInput,
  type Sealed,
  type SealedCopy,
  type SealedRefusedReason,
  type Slot,
} from "./sealed.ts";

export interface E2e {
  /** A version of the device list, checked as docs/e2e.md section 3 says. */
  checkList(input: ListInput): ListResult;
  /** A computer's copies of a session's announcement or notice, one per recipient, each with a random nonce. */
  seal(input: SealInput): Sealed;
  /** A copy of an announcement, opened with this client's box secret key. */
  openAnnouncement(input: OpenInput): OpenResult<AnnouncementText>;
  /** The devices' names, sealed by the account's phone, opened with this client's box secret key. */
  openNames(input: NamesInput): NamesResult;
  /** The other side's offer at a join, checked (join.ts). */
  checkOffer(input: Parameters<typeof checkOffer>[1]): OfferResult;
}

let loaded: Promise<E2e> | undefined;

/**
 * The checks, once libsodium has started. Every call gives the same object;
 * if the start fails, the next call tries again.
 */
export function load(): Promise<E2e> {
  loaded ??= sodium.ready.then(
    () => ({
      checkList: (input: ListInput) => checkList(sodium, input),
      seal: (input: SealInput) => seal(sodium, input),
      openAnnouncement: (input: OpenInput) => openAnnouncement(sodium, input),
      openNames: (input: NamesInput) => openNames(sodium, input),
      checkOffer: (input: Parameters<typeof checkOffer>[1]) => checkOffer(sodium, input),
    }),
    (e: unknown) => {
      loaded = undefined;
      throw e;
    },
  );
  return loaded;
}
