// Images in prompts (docs/web.md, section 6): a picture chosen, pasted or
// dropped is shrunk here to fit IMAGE_SIDE, pi's own limit, before it is
// sent.
import { IMAGE_BYTES_MAX, IMAGE_SIDE, IMAGE_TYPES } from "../../core/api.ts";

// An image ready to send: its data in base64, and as a URL to show it.
export interface Attachment {
  mimeType: string;
  data: string;
  url: string;
}

// Kept as it is: a small PNG, GIF or WebP that fits (a screenshot, an
// animation); anything else is drawn again.
const KEEP_BYTES = 1 << 20;
// A PNG larger than this goes as a JPEG instead: a photo saved as PNG.
const PNG_BYTES = 3 << 19;

const read = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("could not be read"));
    r.readAsDataURL(b);
  });

const encode = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("could not be encoded"))), type, quality));

async function attachment(b: Blob, mimeType: string): Promise<Attachment> {
  const data = (await read(b)).split(",")[1];
  return { mimeType, data, url: `data:${mimeType};base64,${data}` };
}

// The image as it is sent, or why it cannot be.
export async function shrink(file: Blob): Promise<Attachment> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This browser cannot read that image; a PNG or JPEG will do.");
  }
  const { width, height } = bitmap;
  const scale = Math.min(1, IMAGE_SIDE / Math.max(width, height));
  const lossless = ["image/png", "image/gif", "image/webp"].includes(file.type);
  if (scale === 1 && lossless && IMAGE_TYPES.includes(file.type) && file.size <= KEEP_BYTES) {
    bitmap.close();
    return attachment(file, file.type);
  }
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width * scale));
  c.height = Math.max(1, Math.round(height * scale));
  const g = c.getContext("2d")!;
  if (lossless) {
    g.drawImage(bitmap, 0, 0, c.width, c.height);
    const png = await encode(c, "image/png");
    if (png.size <= PNG_BYTES) {
      bitmap.close();
      return attachment(png, "image/png");
    }
  }
  // A JPEG has no transparency: what was clear is white.
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close();
  for (const q of [0.85, 0.7, 0.5]) {
    const jpeg = await encode(c, "image/jpeg", q);
    if (jpeg.size <= IMAGE_BYTES_MAX) return attachment(jpeg, "image/jpeg");
  }
  throw new Error("That image is too large to send, even made smaller.");
}
