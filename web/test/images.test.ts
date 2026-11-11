// The images kept for the page: by content, the least recently used going
// first past the limit.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ImageStore, imageKey } from "../core/images.ts";

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

test("an image is named by its content and type", () => {
  assert.equal(imageKey("image/png", bytes(10, 1)), imageKey("image/png", bytes(10, 1)));
  assert.notEqual(imageKey("image/png", bytes(10, 1)), imageKey("image/jpeg", bytes(10, 1)));
  assert.notEqual(imageKey("image/png", bytes(10, 1)), imageKey("image/png", bytes(10, 2)));
  assert.notEqual(imageKey("image/png", bytes(10, 0)), imageKey("image/png", bytes(11, 0)));
});

test("past the limit the least recently used go; one seen again is kept once", () => {
  const s = new ImageStore(30);
  const a = s.put("image/png", bytes(10, 1));
  const b = s.put("image/png", bytes(10, 2));
  assert.equal(s.put("image/png", bytes(10, 1)), a);
  const c = s.put("image/png", bytes(10, 3));
  s.get(a);
  const d = s.put("image/png", bytes(10, 4));
  assert.equal(s.get(b), undefined);
  for (const k of [a, c, d]) assert.ok(s.get(k), k);
  // One larger than the whole store is named but not kept.
  assert.equal(s.get(s.put("image/png", bytes(31, 5))), undefined);
  assert.ok(s.get(a));
});
