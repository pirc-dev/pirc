// A tool's images for clients: shrunk by pi's resizing to their share of
// a frame, kept for History, and a placeholder when they cannot be.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { ConversationItemSchema } from "@pirc/protocol";

import { fitItem, messageItems, atMs } from "../src/convert.ts";
import { shareOf, shrinkImages, shrinkingDone, toolImages, TOOL_IMAGE_BYTES, TOOL_IMAGE_SIDE, type ImageBlock } from "../src/toolimages.ts";
import type { ResizeImage } from "../src/photos.ts";

const block = (data = "AQID"): ImageBlock => ({ type: "image", mimeType: "image/png", data });

test("each image is shrunk once, within 2000 px and its share, and given as pi's copy", async () => {
  const asked: { maxWidth: number; maxHeight: number; maxBytes: number }[] = [];
  const resize: ResizeImage = async (data, _mime, o) => {
    asked.push(o);
    return { data: Buffer.from([...data].slice(0, 1)).toString("base64"), mimeType: "image/jpeg" };
  };
  const blocks = [block(), block("BAUG")];
  await shrinkImages(blocks, shareOf(1 << 20, 2), resize);
  await shrinkImages(blocks, shareOf(1 << 20, 2), resize);
  assert.equal(asked.length, 2, "not shrunk twice");
  assert.deepEqual(asked[0], { maxWidth: TOOL_IMAGE_SIDE, maxHeight: TOOL_IMAGE_SIDE, maxBytes: Math.floor((shareOf(1 << 20, 2) * 4) / 3) });
  assert.ok(shrinkingDone(blocks));
  const images = toolImages([{ type: "text", text: "x" }, ...blocks]);
  assert.deepEqual(images.map((i) => [i.mimeType, [...i.data]]), [["image/jpeg", [1]], ["image/jpeg", [4]]]);
});

test("an image's share: 2 MiB at most, a frame's share among several", () => {
  assert.equal(shareOf(16 << 20, 1), TOOL_IMAGE_BYTES);
  assert.equal(shareOf(1 << 20, 2), Math.floor(((1 << 20) * 0.9) / 2));
});

test("one that cannot be shrunk, or with no resizing, or not tried, is a placeholder", async () => {
  const failed = block();
  await shrinkImages([failed], 1000, async () => null);
  const thrown = block();
  await shrinkImages([thrown], 1000, async () => { throw new Error("photon"); });
  const none = block();
  await shrinkImages([none], 1000, undefined);
  const untried = block();
  assert.deepEqual(toolImages([failed, thrown, none, untried]).map((i) => [i.mimeType, i.data.length]), Array(4).fill(["image/png", 0]));
  assert.equal(shrinkingDone([untried]), false);
});

test("a tool result carries its images; one too big for the frame loses them, not the copy kept", async () => {
  const b = block();
  await shrinkImages([b], 1 << 20, async () => ({ data: Buffer.alloc(4000, 7).toString("base64"), mimeType: "image/png" }));
  const m = { role: "toolResult", toolCallId: "t1", toolName: "screenshot", content: [{ type: "text", text: "shot" }, b], isError: false, timestamp: 0 };
  const [item] = messageItems(m as never, { entryId: "e1", turnId: "t", at: atMs(0) });
  assert.ok(item?.body.case === "toolResult");
  assert.equal(item.body.value.images[0]!.data.length, 4000);
  const fitted = fitItem(create(ConversationItemSchema, item), 1000);
  assert.ok(fitted.body.case === "toolResult" && fitted.body.value.images[0]!.data.length === 0);
  assert.equal(toolImages([b])[0]!.data.length, 4000);
});
