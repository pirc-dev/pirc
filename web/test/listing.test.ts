// Whether the session list is all there is (page/src/listing.ts): an empty
// list, or a chat's session missing from it, means none only once it is.
import assert from "node:assert/strict";
import { test } from "node:test";

import { whatListed } from "../page/src/listing.ts";

test("not before the first snapshot, nor while the server connects to the relay", () => {
  assert.equal(whatListed({ loaded: false, relay: { state: "ready" } }), "loading");
  assert.equal(whatListed({ loaded: true, relay: { state: "connecting" } }), "loading");
});

test("listed once loaded with the relay ready; the last known while it is out of reach", () => {
  assert.equal(whatListed({ loaded: true, relay: { state: "ready" } }), "listed");
  for (const state of ["offline", "refused", "stopped"] as const) assert.equal(whatListed({ loaded: true, relay: { state } }), "unknown");
});
