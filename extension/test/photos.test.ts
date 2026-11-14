// The renderer of a client's images in pi's chat, with the pi-tui and the
// PNG conversion of the pi this is developed against.
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { loadPhotos, onConverted, PHOTO_ENTRY, photoRenderer, type PhotoData } from "../src/photos.ts";

const pi = realpathSync(join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent"));
// A 1x1 PNG, also given as a JPEG, which pi's conversion reads by its bytes.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const theme = { fg: (_: string, s: string) => `<${s}>` } as never;
const entry = (message: string): CustomEntry<PhotoData> => ({ type: "custom", id: "c1", parentId: "e1", timestamp: "", customType: PHOTO_ENTRY, data: { message } });
// pi gives the keybinding hints too since 1.5, which the renderer does not use.
const opts = { expanded: false, keyText: () => "", keyHint: () => "" };

interface Tui {
  setCapabilities(c: { images: "kitty" | "iterm2" | null; trueColor: boolean; hyperlinks: boolean }): void;
  resetCapabilitiesCache(): void;
  visibleWidth(s: string): number;
}

// pi-tui as pi-parts.js gives it: the module itself.
async function tui(): Promise<Tui> {
  const t = (await import(pathToFileURL(join(realpathSync(join(pi, "..", "pi-tui")), "dist", "index.js")).href)) as Tui;
  const loaded = await loadPhotos({ tui: t }, pi);
  assert.equal(loaded.problem, undefined);
  assert.match(loaded.from, /^pi-tui from pi's loader, conversion /);
  return t;
}

const message = (mimeType: string) => ({ role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType, data: PNG }] });

test("where the terminal shows no images, pi-tui's line, cut to the width; with showImages off, the same", async () => {
  const t = await tui();
  try {
    t.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const r = photoRenderer(() => message("image/png"), () => ({}));
    assert.deepEqual(r(entry("e1"), opts, theme)!.render(80), ["<[Image: [image/png] 1x1]>"]);
    t.setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
    const off = photoRenderer(() => message("image/png"), () => ({ terminal: { showImages: false } }));
    assert.deepEqual(off(entry("e1"), opts, theme)!.render(80), ["<[Image: [image/png] 1x1]>"]);
    assert.equal(t.visibleWidth(off(entry("e1"), opts, theme)!.render(10)[0]), 10);
  } finally {
    t.resetCapabilitiesCache();
  }
});

test("an image drawn; under kitty, a JPEG once pi has made it a PNG, which asks for a redraw", async () => {
  const t = await tui();
  try {
    t.setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
    const r = photoRenderer(() => message("image/png"), () => ({}));
    const e = entry("e1");
    const c = r(e, opts, theme)!;
    assert.match(c.render(80).join("\n"), /\x1b\]1337;File=/);
    assert.equal(r(e, opts, theme), c, "one component for an entry, however often pi rebuilds it");

    t.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const m = message("image/jpeg");
    const k = photoRenderer(() => m, () => ({}))(entry("e2"), opts, theme)!;
    const redrawn = new Promise<void>((resolve) => onConverted(resolve));
    assert.deepEqual(k.render(80), [], "nothing until the PNG is made");
    await redrawn;
    assert.match(k.render(80).join("\n"), /\x1b_G/);
  } finally {
    onConverted(() => {});
    t.resetCapabilitiesCache();
  }
});

test("a chat pi draws before the session is the extension's: the entry is kept, and drawn once the message is found", async () => {
  const t = await tui();
  try {
    t.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    let bound = false;
    const c = photoRenderer(() => (bound ? message("image/png") : undefined), () => ({}))(entry("e1"), opts, theme);
    assert.ok(c, "pi drops an entry it is given nothing for");
    assert.deepEqual(c.render(80), []);
    bound = true;
    assert.deepEqual(c.render(80), ["<[Image: [image/png] 1x1]>"]);
    // A message with no images draws nothing.
    const none = photoRenderer(() => ({ role: "user", content: "hi" }), () => ({}))(entry("e1"), opts, theme)!;
    assert.deepEqual(none.render(80), []);
  } finally {
    t.resetCapabilitiesCache();
  }
});
