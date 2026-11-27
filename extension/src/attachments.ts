// Files a client sends with a prompt (Prompt.attachments). Their bytes
// arrive first, in AttachmentChunks, and are written straight to a file in
// a directory of the session's own, private to this user, outside any
// repository; the prompt then names each file to pi in a line of its own,
// which pi reads with its tools. The session's directory goes when the
// session ends, and anything left a day old is swept when the extension
// starts.
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Attachment, AttachmentChunk } from "@pirc/protocol";

// What one client may have on its way for a session at once, in bytes: the
// cap on a prompt's files.
export const ATTACHMENTS_MAX = 10 * 1024 * 1024;
// An upload with no chunk and no prompt for this long is dropped.
export const UPLOAD_IDLE_MS = 2 * 60 * 1000;
// Files older than this are swept when the extension starts.
export const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;
const NAME_MAX = 200;
// Files saved for prompts, kept for a retry that names them again.
const TAKEN_MAX = 200;

// The line naming a file to pi, and the pattern that finds it again in the
// message pi keeps, so that history shows the file and not the line.
const MARK = "[pirc attachment]";
const LINE = /^\[pirc attachment\] (.+) \(([^\s(),]+), (\d+) bytes\)$/;

export interface Saved {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}

interface Upload {
  dir: string;
  fd: number | undefined;
  received: number;
  failed?: string;
  timer: NodeJS.Timeout;
}

// The directory that holds every session's files: one per user, which must
// be a real directory of this user's, closed to everyone else, since the
// temporary directory may be shared (as /tmp on Linux).
export function attachmentsBase(root = tmpdir()): string {
  const uid = process.getuid?.() ?? 0;
  const base = join(root, `pirc-attachments-${uid}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const st = lstatSync(base);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${base} is not a directory`);
  if (process.getuid && st.uid !== uid) throw new Error(`${base} belongs to another user`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${base} is open to other users`);
  return base;
}

// A file's name as given, made safe to write: no directory, no control
// characters, not empty or a dot name, and not too long.
export function safeName(name: string): string {
  let n = basename(name.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (n === "" || n === "." || n === "..") n = "file";
  if (Buffer.byteLength(n) <= NAME_MAX) return n;
  // Cut from the stem, keeping a short extension.
  const dot = n.lastIndexOf(".");
  const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : "";
  let stem = [...(ext ? n.slice(0, dot) : n)];
  while (stem.length > 1 && Buffer.byteLength(stem.join("") + ext) > NAME_MAX) stem = stem.slice(0, -1);
  return stem.join("") + ext;
}

// A media type as given, if it is one; else octet-stream. It goes in the
// line pi reads, so nothing else may.
export function safeMime(mime: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime.toLowerCase() : "application/octet-stream";
}

export function attachmentLine(f: Saved): string {
  return `${MARK} ${f.path} (${f.mimeType}, ${f.size} bytes)`;
}

// The text pi gets: the client's own, then a line for each file.
export function withAttachments(text: string, files: Saved[]): string {
  if (files.length === 0) return text;
  const lines = files.map(attachmentLine).join("\n");
  return text ? `${text}\n\n${lines}` : lines;
}

// A message's text without its files' lines, and the files they named
// (with no bytes, and no id).
export function splitAttachments(text: string): { text: string; attachments: { name: string; mimeType: string; size: bigint }[] } {
  if (!text.includes(MARK)) return { text, attachments: [] };
  const lines = text.split("\n");
  const attachments: { name: string; mimeType: string; size: bigint }[] = [];
  let end = lines.length;
  while (end > 0) {
    const m = LINE.exec(lines[end - 1]!);
    if (!m) break;
    attachments.unshift({ name: basename(m[1]!), mimeType: m[2]!, size: BigInt(m[3]!) });
    end--;
  }
  if (attachments.length === 0) return { text, attachments };
  while (end > 0 && lines[end - 1] === "") end--;
  return { text: lines.slice(0, end).join("\n"), attachments };
}

export class Uploads {
  private readonly uploads = new Map<string, Upload>();
  // Each file a prompt took, by its upload's key: a retry of the prompt,
  // after an answer that let it be tried again, names the same ids
  // without sending their pieces again.
  private readonly taken = new Map<string, Saved>();
  private base: string | undefined;

  constructor(private readonly root?: string) {}

  private baseDir(): string {
    this.base ??= attachmentsBase(this.root);
    return this.base;
  }

  // Whether the directory is there, without making it.
  private exists(): boolean {
    return this.base !== undefined || existsSync(join(this.root ?? tmpdir(), `pirc-attachments-${process.getuid?.() ?? 0}`));
  }

  private sessionDir(sessionId: string): string {
    return join(this.baseDir(), safeName(sessionId));
  }

  private key(sessionId: string, client: string, id: string): string {
    return `${sessionId}/${client}/${id}`;
  }

  // What the client has on its way for the session, in bytes.
  private pending(sessionId: string, client: string): number {
    const prefix = `${sessionId}/${client}/`;
    let n = 0;
    for (const [k, u] of this.uploads) if (k.startsWith(prefix) && !u.failed) n += u.received;
    return n;
  }

  // Takes one chunk. Unanswered: a chunk out of order, or one past the
  // cap, fails its upload, and the prompt naming it is refused with why.
  // A chunk at offset 0 starts the upload afresh, as a client's retry does.
  chunk(sessionId: string, client: string, c: AttachmentChunk): void {
    if (!c.id) return;
    const k = this.key(sessionId, client, c.id);
    let u = this.uploads.get(k);
    if (c.offset === 0n) {
      if (u) this.drop(k);
      const dir = join(this.sessionDir(sessionId), `${safeName(client).slice(0, 16)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      u = { dir, fd: openSync(join(dir, ".part"), "wx", 0o600), received: 0, timer: this.idleTimer(k) };
      this.uploads.set(k, u);
    }
    if (!u) {
      const failed: Upload = { dir: "", fd: undefined, received: 0, failed: "its file's first piece is missing", timer: this.idleTimer(k) };
      this.uploads.set(k, failed);
      return;
    }
    if (u.failed) return;
    this.touch(k, u);
    if (c.offset !== BigInt(u.received)) return this.fail(u, "its file's pieces came out of order");
    if (this.pending(sessionId, client) + c.data.length > ATTACHMENTS_MAX) return this.fail(u, `its files are over ${ATTACHMENTS_MAX / (1024 * 1024)} MiB`);
    writeSync(u.fd!, c.data);
    u.received += c.data.length;
  }

  // The files a prompt names, saved under their names, or why not. Either
  // way the uploads are done with.
  take(sessionId: string, client: string, attachments: Attachment[]): { files: Saved[] } | { error: string } {
    const keys = attachments.map((a) => this.key(sessionId, client, a.id));
    try {
      if (new Set(keys).size !== keys.length) return { error: "a file is named twice" };
      let total = 0n;
      for (const a of attachments) total += a.size;
      if (total > BigInt(ATTACHMENTS_MAX)) return { error: `its files are over ${ATTACHMENTS_MAX / (1024 * 1024)} MiB` };
      const files: Saved[] = [];
      for (const [i, a] of attachments.entries()) {
        const u = this.uploads.get(keys[i]!);
        const kept = this.taken.get(keys[i]!);
        if (a.id && !u && kept && BigInt(kept.size) === a.size && existsSync(kept.path)) {
          files.push(kept);
          continue;
        }
        if (!a.id || !u) return { error: `no file came for ${safeName(a.name)}` };
        if (u.failed) return { error: u.failed };
        if (BigInt(u.received) !== a.size) return { error: `${safeName(a.name)} came incomplete` };
        closeSync(u.fd!);
        u.fd = undefined;
        const path = join(u.dir, safeName(a.name));
        renameSync(join(u.dir, ".part"), path);
        files.push({ path, name: safeName(a.name), mimeType: safeMime(a.mimeType), size: u.received });
      }
      for (const [i, k] of keys.entries()) {
        this.forget(k);
        this.taken.delete(k);
        this.taken.set(k, files[i]!);
      }
      while (this.taken.size > TAKEN_MAX) this.taken.delete(this.taken.keys().next().value!);
      return { files };
    } finally {
      for (const k of keys) if (this.uploads.has(k)) this.drop(k);
    }
  }

  // The session's files and uploads, gone: it has ended.
  endSession(sessionId: string): void {
    for (const k of [...this.uploads.keys()]) if (k.startsWith(`${sessionId}/`)) this.drop(k);
    for (const k of [...this.taken.keys()]) if (k.startsWith(`${sessionId}/`)) this.taken.delete(k);
    // Also files an earlier load of the extension saved, in this process.
    if (!this.exists()) return;
    rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  // Every session's files older than a day, gone.
  sweep(now = Date.now()): void {
    if (!this.exists()) return;
    const base = this.baseDir();
    for (const session of readdirSync(base)) {
      const dir = join(base, session);
      let uploads: string[];
      try {
        uploads = readdirSync(dir);
      } catch {
        continue;
      }
      for (const u of uploads) {
        const path = join(dir, u);
        if (now - lstatSync(path).mtimeMs > SWEEP_AGE_MS) rmSync(path, { recursive: true, force: true });
      }
      if (readdirSync(dir).length === 0 && now - lstatSync(dir).mtimeMs > SWEEP_AGE_MS) rmSync(dir, { recursive: true, force: true });
    }
  }

  // Every upload let go, as the extension unloads; files stay for their
  // session.
  stop(): void {
    for (const k of [...this.uploads.keys()]) {
      const u = this.uploads.get(k)!;
      clearTimeout(u.timer);
      if (u.fd !== undefined) closeSync(u.fd);
      this.uploads.delete(k);
    }
  }

  private idleTimer(k: string): NodeJS.Timeout {
    const t = setTimeout(() => this.drop(k), UPLOAD_IDLE_MS);
    t.unref();
    return t;
  }

  private touch(k: string, u: Upload): void {
    clearTimeout(u.timer);
    u.timer = this.idleTimer(k);
  }

  private fail(u: Upload, why: string): void {
    u.failed = why;
    if (u.fd !== undefined) closeSync(u.fd);
    u.fd = undefined;
    if (u.dir) rmSync(u.dir, { recursive: true, force: true });
    u.received = 0;
  }

  // The upload done with, its file kept.
  private forget(k: string): void {
    const u = this.uploads.get(k);
    if (!u) return;
    clearTimeout(u.timer);
    this.uploads.delete(k);
  }

  // The upload done with, its file gone.
  private drop(k: string): void {
    const u = this.uploads.get(k);
    if (!u) return;
    clearTimeout(u.timer);
    if (u.fd !== undefined) closeSync(u.fd);
    if (u.dir) rmSync(u.dir, { recursive: true, force: true });
    this.uploads.delete(k);
  }
}
