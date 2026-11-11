// The images of user messages, kept by the server for the page to show
// (docs/web.md, section 6): they come with the messages, and the chat
// names each by a key made from its content, so that the same image seen
// again (history fetched anew) is kept once. Bounded: past the limit the
// least recently used go, and the page shows a placeholder for them.

export interface StoredImage {
  mimeType: string;
  data: Uint8Array;
}

// 64 bits of FNV-1a, in two 32-bit halves, with the length and type: a
// name, not a defence, since only images the sessions sent are kept.
export function imageKey(mimeType: string, data: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < data.length; i++) {
    a = Math.imul(a ^ data[i], 0x01000193);
    b = Math.imul(b ^ data[i], 0x01000193) ^ (a >>> 15);
  }
  for (let i = 0; i < mimeType.length; i++) a = Math.imul(a ^ mimeType.charCodeAt(i), 0x01000193);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(a)}${hex(b)}${data.length.toString(16)}`;
}

export class ImageStore {
  // In order of use, the least recent first.
  private images = new Map<string, StoredImage>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  // Keeps an image; its key.
  put(mimeType: string, data: Uint8Array): string {
    const key = imageKey(mimeType, data);
    const had = this.images.get(key);
    if (had) {
      this.images.delete(key);
      this.images.set(key, had);
      return key;
    }
    if (data.length > this.maxBytes) return key;
    this.images.set(key, { mimeType, data });
    this.bytes += data.length;
    for (const [k, v] of this.images) {
      if (this.bytes <= this.maxBytes) break;
      this.images.delete(k);
      this.bytes -= v.data.length;
    }
    return key;
  }

  get(key: string): StoredImage | undefined {
    const it = this.images.get(key);
    if (it) {
      this.images.delete(key);
      this.images.set(key, it);
    }
    return it;
  }
}
