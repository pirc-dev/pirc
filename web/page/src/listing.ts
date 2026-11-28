import type { RelayView } from "../../core/view.ts";

// Whether the sessions listed are all there are: not before the first
// snapshot, nor while the server connects to the relay, when an empty list
// or a chat's session missing from it means nothing yet. Out of reach of
// the relay (offline, refused, stopped), the banner says so, and the list
// is the last one known.
export type Listing = "loading" | "listed" | "unknown";
export function whatListed(s: { loaded: boolean; relay: RelayView }): Listing {
  if (!s.loaded || s.relay.state === "connecting") return "loading";
  return s.relay.state === "ready" ? "listed" : "unknown";
}
