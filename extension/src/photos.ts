// A client's images in pi's own chat (docs/design.md, section 8). pi's
// terminal draws only the text of a user message, so a prompt's images get
// an entry right after its message, which the renderer here draws with
// pi-tui's Image, as pi draws a tool's images. The entry names the message
// and the images are read from it, so nothing is stored twice. pi keeps
// custom entries out of the model's context.
import type { CustomEntry, EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { piPackageDir } from "./pi.ts";

export const PHOTO_ENTRY = "pirc:photos";

export interface PhotoData {
  // The ID of the user message's entry.
  message: string;
}

export interface Photo {
  mimeType: string;
  data: string;
}

interface Component {
  render(width: number): string[];
  invalidate(): void;
}

// What the renderer uses of pi-tui.
interface Tui {
  Image: new (data: string, mimeType: string, theme: { fallbackColor: (s: string) => string }, options?: { maxWidthCells?: number }) => Component;
  getCapabilities(): { images: "kitty" | "iterm2" | null };
  imageFallback(mimeType: string, dimensions?: unknown): string;
  getImageDimensions(data: string, mimeType: string): unknown;
  truncateToWidth?(text: string, width: number): string;
}
type Settings = ReturnType<ExtensionAPI["getSettings"]>;
type ConvertToPng = (data: string, mimeType: string) => Promise<Photo | null>;

// What the published package's pi-parts.js leaves the bundle: pi-tui and
// pi's conversion to PNG as pi's loader gives them to extensions, the
// very modules pi draws with. The bundle cannot import them by name.
export interface PiParts {
  tui?: unknown;
  convertToPng?: unknown;
}

const isTui = (m: unknown): m is Tui =>
  typeof (m as Tui)?.Image === "function" && typeof (m as Tui).getCapabilities === "function" && typeof (m as Tui).imageFallback === "function" && typeof (m as Tui).getImageDimensions === "function";

let tui: Tui | undefined;
let convertToPng: ConvertToPng | undefined;
let loading: Promise<Loaded> | undefined;

export interface Loaded {
  // What could not be loaded, said plainly for pi's screen.
  problem?: string;
  // Where pi-tui and the conversion came from, for the log.
  from: string;
}

// pi-tui's entry point in pi's install: in pi's own repository, or where
// Node would resolve it from pi's package.
function tuiEntry(pi: string): string | undefined {
  const dirs = [join(dirname(pi), "tui")];
  for (let d = pi; ; d = dirname(d)) {
    dirs.push(join(d, "node_modules", "@earendil-works", "pi-tui"));
    if (dirname(d) === d) break;
  }
  for (const dir of dirs) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return join(dir, pkg.exports?.["."]?.import ?? pkg.main ?? "dist/index.js");
    } catch {
      // Not here; look further.
    }
  }
  return undefined;
}

// By name, which resolves where pi's loader runs this code from source;
// a variable, so that neither tsc nor esbuild resolves it.
async function byName(name: string): Promise<unknown> {
  try {
    return await import(name);
  } catch {
    return undefined;
  }
}

async function byPath(path: string): Promise<{ module?: unknown; error?: string }> {
  try {
    return { module: await import(pathToFileURL(path).href) };
  } catch (e) {
    return { error: (e as Error)?.message ?? String(e) };
  }
}

// Loads what the renderer needs, once: pi-tui, and pi's own conversion to
// PNG. First as given (pi-parts.js), then by name, then from pi's install,
// found from pi's entry point: a copy of pi-tui of its own, which draws
// the same but knows nothing of pi's settings for it. Without pi-tui no
// entry is drawn; without the conversion, a photo in a terminal speaking
// kitty's protocol is pi-tui's line.
export function loadPhotos(given: PiParts = {}, pi = piPackageDir()): Promise<Loaded> {
  loading ??= (async (): Promise<Loaded> => {
    const from: string[] = [];
    let problem: string | undefined;
    const named = isTui(given.tui) ? undefined : await byName("@earendil-works/pi-tui");
    if (isTui(given.tui)) {
      tui = given.tui;
      from.push("pi-tui from pi's loader");
    } else if (isTui(named)) {
      tui = named;
      from.push("pi-tui by name");
    } else {
      const entry = pi && tuiEntry(pi);
      const got = entry ? await byPath(entry) : { error: pi ? `not found beside pi in ${pi}` : "pi's install was not found from its command line" };
      if (isTui(got.module)) {
        tui = got.module;
        from.push(`pi-tui from ${entry}`);
      } else {
        problem = `pi-tui did not load (${got.error ?? `${entry} lacks Image`}), so no photo is drawn`;
      }
    }
    if (typeof given.convertToPng === "function") {
      convertToPng = given.convertToPng as ConvertToPng;
      from.push("conversion from pi's loader");
    } else {
      const named = (await byName("@earendil-works/pi-coding-agent")) as { convertToPng?: unknown } | undefined;
      const got = typeof named?.convertToPng === "function" || !pi ? { module: named } : await byPath(join(pi, "dist", "utils", "image-convert.js"));
      const fn = (got.module as { convertToPng?: unknown } | undefined)?.convertToPng;
      if (typeof fn === "function") {
        convertToPng = fn as ConvertToPng;
        from.push(named === got.module ? "conversion by name" : "conversion from pi's install");
      } else if (!problem) {
        problem = `pi's conversion to PNG did not load (${got.error ?? "no convertToPng"}), so in terminals that speak kitty's protocol a photo shows as a line of text`;
      }
    }
    return { problem, from: from.join(", ") || "nothing" };
  })();
  return loading;
}

// The images of a user message, as pi keeps them.
export function photosOf(message: unknown): Photo[] {
  const content = (message as { role?: string; content?: unknown } | undefined)?.role === "user" ? (message as { content: unknown }).content : undefined;
  if (!Array.isArray(content)) return [];
  return content.filter((c): c is Photo & { type: "image" } => c?.type === "image" && typeof c.data === "string" && c.data !== "" && typeof c.mimeType === "string");
}

// Kitty's protocol takes only PNG, so pi converts other images first, as
// does this, keeping each by the image object pi holds.
const pngs = new WeakMap<Photo, Photo | null>();
const converting = new WeakSet<Photo>();
let converted = () => {};

// Called when a PNG is ready that an entry drawn already waits for.
export function onConverted(fn: () => void): void {
  converted = fn;
}

const needsPng = (p: Photo) => tui?.getCapabilities().images === "kitty" && p.mimeType !== "image/png";

// Starts making the PNGs a terminal speaking kitty's protocol needs, so
// that they are likely ready when the entry is drawn.
export function preparePhotos(photos: readonly Photo[]): void {
  for (const p of photos) {
    if (!convertToPng || !needsPng(p) || pngs.has(p) || converting.has(p)) continue;
    converting.add(p);
    convertToPng(p.data, p.mimeType).then(
      (png) => pngs.set(p, png),
      () => pngs.set(p, null),
    ).finally(() => {
      converting.delete(p);
      converted();
    });
  }
}

interface Shown {
  show: boolean;
  width: number;
  color: (s: string) => string;
}

// A message's images, a line apart, each as pi draws a tool's: pi-tui's
// Image, which falls back to a line of text where the terminal shows no
// images; with pi's showImages off, that line. pi puts a line before the
// entry itself. The message is found when drawn, not when pi asks for the
// entry: pi draws a session it replaces another with, or reloads, before
// the extension has it (Host.bind), and drops an entry it is given nothing
// for; until then this draws nothing.
class Photos implements Component {
  private photos: Photo[] | undefined;
  private drawn = new Map<Photo, Component>();

  constructor(
    private messageId: string,
    private find: (entryId: string) => unknown,
    private shown: Shown,
  ) {}

  show(shown: Shown): void {
    // An image is made for one width.
    if (shown.width !== this.shown.width) this.drawn.clear();
    this.shown = shown;
    this.invalidate();
  }

  render(width: number): string[] {
    if (!this.photos) {
      const m = this.find(this.messageId);
      if (m === undefined) return [];
      this.photos = photosOf(m);
    }
    const lines: string[] = [];
    for (const p of this.photos) {
      const c = this.component(p);
      if (!c) continue;
      if (lines.length > 0) lines.push("");
      lines.push(...c.render(width));
    }
    return lines;
  }

  invalidate(): void {
    for (const c of this.drawn.values()) c.invalidate();
  }

  private component(p: Photo): Component | undefined {
    const t = tui!;
    const line = (): Component => ({
      render: (width) => {
        const s = this.shown.color(t.imageFallback(p.mimeType, t.getImageDimensions(p.data, p.mimeType) ?? undefined));
        return [t.truncateToWidth ? t.truncateToWidth(s, width) : s];
      },
      invalidate() {},
    });
    if (!this.shown.show) return line();
    let image: Photo = p;
    if (needsPng(p)) {
      if (!convertToPng) return line();
      const png = pngs.get(p);
      // Drawn once it is ready; one that cannot be made, as a line.
      if (png === undefined) {
        preparePhotos([p]);
        return undefined;
      }
      if (png === null) return line();
      image = png;
    }
    let c = this.drawn.get(p);
    if (!c) {
      c = new t.Image(image.data, image.mimeType, { fallbackColor: this.shown.color }, { maxWidthCells: this.shown.width });
      this.drawn.set(p, c);
    }
    return c;
  }
}

// pi's terminal settings for images, read as pi reads them.
function shown(settings: Settings | undefined, color: (s: string) => string): Shown {
  const width = settings?.terminal?.imageWidthCells;
  return {
    show: settings?.terminal?.showImages ?? true,
    width: typeof width === "number" && Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 60,
    color,
  };
}

// The renderer for PHOTO_ENTRY: find gives a user message by its entry ID,
// once the session is the extension's. pi asks again for an entry's
// component whenever it rebuilds it, so each entry keeps one, its images
// drawn once.
export function photoRenderer(find: (entryId: string) => unknown, settings: () => Settings | undefined): EntryRenderer<PhotoData> {
  const made = new WeakMap<CustomEntry<PhotoData>, Photos>();
  return (entry, _options, theme) => {
    if (!tui || typeof entry.data?.message !== "string") return undefined;
    const now = shown(settings(), (s) => theme.fg("dim", s));
    let c = made.get(entry);
    if (c) {
      c.show(now);
      return c;
    }
    c = new Photos(entry.data.message, find, now);
    made.set(entry, c);
    return c;
  };
}
