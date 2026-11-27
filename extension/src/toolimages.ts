// A tool's images for clients (ToolResult.images): each shrunk by pi's own
// resizing to at most 2000 px a side and 2 MiB, and to its share of a
// frame, so that it is sent rather than left out. Shrinking takes a
// moment, so a tool result waits for it (Live's pending messages); an image
// not shrunk in time, or that cannot be, goes as a placeholder (empty
// data), as does one in History that was never shrunk here.
import { create } from "@bufbuild/protobuf";
import { ImageSchema, type Image } from "@pirc/protocol";

import { resizer, type ResizeImage } from "./photos.ts";

export const TOOL_IMAGE_SIDE = 2000;
export const TOOL_IMAGE_BYTES = 2 * 1024 * 1024;
// How long a tool result waits for its images.
export const SHRINK_WAIT_MS = 5000;

// An image block of a message's content, as pi holds it.
export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

// The shrunk copy of each image block pi holds, or null when it could not
// be shrunk; absent while it has not been tried.
const shrunk = new WeakMap<ImageBlock, Image | null>();

export function imageBlocks(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((c): c is ImageBlock => c?.type === "image" && typeof c.data === "string" && c.data !== "" && typeof c.mimeType === "string");
}

// What one image may take in bytes, when `count` share a frame of
// `budget` bytes, or the most of any.
export function shareOf(budget: number, count: number): number {
  return Math.max(1024, Math.min(TOOL_IMAGE_BYTES, Math.floor((budget * 0.9) / Math.max(1, count))));
}

// Shrinks the blocks not tried yet; resolves when all are done. pi's
// resizing counts an image's size as base64, a third over its bytes.
export function shrinkImages(blocks: readonly ImageBlock[], maxBytes: number, resize: ResizeImage | undefined = resizer()): Promise<void> {
  const todo = blocks.filter((b) => !shrunk.has(b));
  if (todo.length === 0) return Promise.resolve();
  if (!resize) {
    for (const b of todo) shrunk.set(b, null);
    return Promise.resolve();
  }
  return Promise.all(todo.map(async (b) => {
    try {
      const r = await resize(new Uint8Array(Buffer.from(b.data, "base64")), b.mimeType, { maxWidth: TOOL_IMAGE_SIDE, maxHeight: TOOL_IMAGE_SIDE, maxBytes: Math.floor((maxBytes * 4) / 3) });
      shrunk.set(b, r ? create(ImageSchema, { mimeType: r.mimeType, data: new Uint8Array(Buffer.from(r.data, "base64")) }) : null);
    } catch {
      shrunk.set(b, null);
    }
  })).then(() => undefined);
}

// Whether every block has been tried.
export function shrinkingDone(blocks: readonly ImageBlock[]): boolean {
  return blocks.every((b) => shrunk.has(b));
}

// The images clients get for these blocks: each shrunk copy, or a
// placeholder with its type.
export function toolImages(content: unknown): Image[] {
  // A copy each time: fitItem empties the images of an item too big.
  return imageBlocks(content).map((b) => {
    const s = shrunk.get(b);
    return create(ImageSchema, { mimeType: s?.mimeType ?? b.mimeType, data: s?.data ?? new Uint8Array() });
  });
}
