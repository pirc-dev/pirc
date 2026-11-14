// The pi versions /pirc status calls outside the range PiRC is tested
// with (src/pi.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { piRangeNote } from "../src/pi.ts";

test("pi 1.x is in range; other majors are named, and an unknown version says nothing", () => {
  for (const v of ["1.0.0", "1.5.2", "1.12.0", "1.0.0-beta.1"]) assert.equal(piRangeNote(v), undefined, v);
  assert.equal(piRangeNote("0.9.4"), "pi 0.9.4 is outside the range PiRC is tested with (1.0.0 to 1.x); something may not work");
  assert.match(piRangeNote("2.0.0") ?? "", /^pi 2\.0\.0 is outside/);
  for (const v of ["unknown", "", "dev"]) assert.equal(piRangeNote(v), undefined, v);
});
