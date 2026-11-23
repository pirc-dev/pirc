// A bottom sheet dragged down by a finger (page/src/drag.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { SheetDrag, dragCloses } from "../page/src/drag.ts";

test("the rule: a third of its height, or a flick, and never upwards", () => {
  assert.equal(dragCloses(299, 0, 900), false);
  assert.equal(dragCloses(301, 0, 900), true);
  assert.equal(dragCloses(301, -500, 900), false, "thrown back up");
  assert.equal(dragCloses(20, 800, 900), true);
  assert.equal(dragCloses(0, 800, 900), false);
});

// Moves a finger from [y0] by [steps] of [by] px, 16 ms apart.
function slide(d: SheetDrag, y0: number, t0: number, by: number, steps: number, scrollTop = 0): { y: number; t: number; at: number | undefined } {
  let y = y0;
  let t = t0;
  let at: number | undefined;
  for (let i = 0; i < steps; i++) {
    y += by;
    t += 16;
    at = d.move(y, t, scrollTop);
  }
  return { y, t, at };
}

test("down past a third, slowly: it follows the finger, then closes", () => {
  const d = new SheetDrag();
  d.start(100, 0, 0);
  const { t, at } = slide(d, 100, 0, 5, 80);
  assert.ok(at !== undefined && at > 380, `follows: ${at}`);
  assert.equal(d.end(t + 200, 900), "close");
});

test("a little, then stopped: it goes back", () => {
  const d = new SheetDrag();
  d.start(100, 0, 0);
  const { t } = slide(d, 100, 0, 5, 12);
  assert.equal(d.end(t + 300, 900), "back");
});

test("a short flick: it closes", () => {
  const d = new SheetDrag();
  d.start(100, 0, 0);
  const { t } = slide(d, 100, 0, 20, 5);
  assert.equal(d.end(t + 10, 900), "close");
});

test("up first: the rows scroll, the sheet stays", () => {
  const d = new SheetDrag();
  d.start(500, 0, 0);
  const { t, at } = slide(d, 500, 0, -10, 5);
  assert.equal(at, undefined);
  assert.equal(d.end(t, 900), undefined);
});

test("rows scrolled down: a pull scrolls them; once at the top, the sheet comes down", () => {
  const d = new SheetDrag();
  d.start(100, 0, 200);
  assert.equal(slide(d, 100, 0, 10, 5, 150).at, undefined, "the rows'");
  const { y, t } = slide(d, 150, 80, 10, 1, 0);
  const after = slide(d, y, t, 10, 10, 0);
  assert.ok(after.at !== undefined && after.at > 50, `the sheet's: ${after.at}`);
});

test("a tap is not a drag", () => {
  const d = new SheetDrag();
  d.start(100, 0, 0);
  d.move(102, 16, 0);
  assert.equal(d.end(40, 900), undefined);
});

test("the sheet's only once dragging: a jitter down, then a swipe up, scrolls the rows", () => {
  const d = new SheetDrag();
  d.start(100, 0, 0);
  d.move(103, 16, 0);
  assert.equal(d.pulling(), false, "deciding");
  assert.equal(slide(d, 103, 16, -10, 3).at, undefined);
  assert.equal(d.pulling(), false, "the rows'");
  d.start(100, 0, 0);
  slide(d, 100, 0, 10, 3);
  assert.equal(d.pulling(), true, "dragging");
});
