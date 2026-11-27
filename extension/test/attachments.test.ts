// Files sent with a prompt: their pieces written to a private directory,
// the line pi gets for each, and the file shown again in history.
import { create } from "@bufbuild/protobuf";
import { AttachmentChunkSchema, AttachmentSchema } from "@pirc/protocol";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { ATTACHMENTS_MAX, attachmentsBase, safeMime, safeName, splitAttachments, Uploads, withAttachments } from "../src/attachments.ts";

const root = () => mkdtempSync(join(tmpdir(), "pirc-att-test-"));
const chunk = (id: string, offset: number, data: number[] | Uint8Array) => create(AttachmentChunkSchema, { id, offset: BigInt(offset), data: data instanceof Uint8Array ? data : new Uint8Array(data) });
const att = (id: string, name: string, size: number, mimeType = "application/pdf") => create(AttachmentSchema, { id, name, mimeType, size: BigInt(size) });

test("a file's pieces are saved under its name, private to the user, and named to pi", () => {
  const u = new Uploads(root());
  u.chunk("s1", "c1", chunk("a", 0, [1, 2, 3]));
  u.chunk("s1", "c1", chunk("a", 3, [4, 5]));
  const r = u.take("s1", "c1", [att("a", "report.pdf", 5)]);
  assert.ok("files" in r, JSON.stringify(r));
  const [f] = r.files;
  assert.equal(f!.name, "report.pdf");
  assert.deepEqual([...readFileSync(f!.path)], [1, 2, 3, 4, 5]);
  assert.equal(statSync(f!.path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(f!.path)).mode & 0o777, 0o700);
  assert.equal(withAttachments("read this", r.files), `read this\n\n[pirc attachment] ${f!.path} (application/pdf, 5 bytes)`);
});

test("two files of one name in one prompt are both kept", () => {
  const u = new Uploads(root());
  u.chunk("s1", "c1", chunk("a", 0, [1]));
  u.chunk("s1", "c1", chunk("b", 0, [2]));
  const r = u.take("s1", "c1", [att("a", "x.txt", 1), att("b", "x.txt", 1)]);
  assert.ok("files" in r);
  assert.notEqual(r.files[0]!.path, r.files[1]!.path);
  assert.deepEqual(r.files.map((f) => [...readFileSync(f.path)]), [[1], [2]]);
});

test("a prompt is refused for a missing, short, out-of-order or other client's file", () => {
  const u = new Uploads(root());
  assert.match((u.take("s1", "c1", [att("a", "x", 1)]) as { error: string }).error, /no file came/);
  u.chunk("s1", "c1", chunk("a", 0, [1, 2]));
  assert.match((u.take("s1", "c1", [att("a", "x", 3)]) as { error: string }).error, /incomplete/);
  u.chunk("s1", "c1", chunk("b", 0, [1]));
  u.chunk("s1", "c1", chunk("b", 5, [1]));
  assert.match((u.take("s1", "c1", [att("b", "x", 2)]) as { error: string }).error, /out of order/);
  u.chunk("s1", "c1", chunk("c", 3, [1]));
  assert.match((u.take("s1", "c1", [att("c", "x", 1)]) as { error: string }).error, /first piece/);
  u.chunk("s1", "c2", chunk("d", 0, [1]));
  assert.match((u.take("s1", "c1", [att("d", "x", 1)]) as { error: string }).error, /no file came/);
});

test("pieces past the cap fail the upload at the piece that crosses it", () => {
  const u = new Uploads(root());
  const big = new Uint8Array(ATTACHMENTS_MAX);
  u.chunk("s1", "c1", chunk("a", 0, big));
  u.chunk("s1", "c1", chunk("b", 0, [1]));
  assert.match((u.take("s1", "c1", [att("b", "x", 1)]) as { error: string }).error, /over 10 MiB/);
  assert.ok("files" in u.take("s1", "c1", [att("a", "x", ATTACHMENTS_MAX)]));
});

test("a retry's first piece starts the upload afresh", () => {
  const u = new Uploads(root());
  u.chunk("s1", "c1", chunk("a", 0, [1, 2]));
  u.chunk("s1", "c1", chunk("a", 0, [3]));
  const r = u.take("s1", "c1", [att("a", "x", 1)]);
  assert.ok("files" in r);
  assert.deepEqual([...readFileSync(r.files[0]!.path)], [3]);
});

test("a session's files go when it ends; a day-old file goes at the sweep", () => {
  const dir = root();
  const u = new Uploads(dir);
  u.chunk("s1", "c1", chunk("a", 0, [1]));
  const r = u.take("s1", "c1", [att("a", "x", 1)]);
  assert.ok("files" in r);
  u.endSession("s1");
  assert.equal(existsSync(r.files[0]!.path), false);

  u.chunk("s2", "c1", chunk("a", 0, [1]));
  u.chunk("s2", "c1", chunk("b", 0, [1]));
  const old = u.take("s2", "c1", [att("a", "old", 1)]);
  const fresh = u.take("s2", "c1", [att("b", "fresh", 1)]);
  assert.ok("files" in old && "files" in fresh);
  const day = Date.now() / 1000 - 2 * 24 * 3600;
  utimesSync(dirname(old.files[0]!.path), day, day);
  u.sweep();
  assert.equal(existsSync(old.files[0]!.path), false);
  assert.equal(existsSync(fresh.files[0]!.path), true);
});

test("the shared directory must be the user's own and closed to others", () => {
  const dir = root();
  const base = join(dir, `pirc-attachments-${process.getuid?.() ?? 0}`);
  mkdirSync(base, { mode: 0o755 });
  assert.throws(() => attachmentsBase(dir), /open to other users/);
  const other = root();
  writeFileSync(join(other, `pirc-attachments-${process.getuid?.() ?? 0}`), "");
  assert.throws(() => attachmentsBase(other));
});

test("names lose their directories and control characters; odd media types become octet-stream", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("a\\b\\c.txt"), "c.txt");
  assert.equal(safeName("bad\nname.pdf"), "badname.pdf");
  assert.equal(safeName(".."), "file");
  assert.equal(safeName(""), "file");
  const long = safeName(`${"é".repeat(300)}.pdf`);
  assert.ok(Buffer.byteLength(long) <= 200 && long.endsWith(".pdf"));
  assert.equal(safeMime("application/pdf"), "application/pdf");
  assert.equal(safeMime("text/plain, evil (x)"), "application/octet-stream");
});

test("history shows the files the lines named, and not the lines", () => {
  const files = [
    { path: "/tmp/p/s/a/report (final).pdf", name: "report (final).pdf", mimeType: "application/pdf", size: 1200 },
    { path: "/tmp/p/s/b/notes.txt", name: "notes.txt", mimeType: "text/plain", size: 3 },
  ];
  const r = splitAttachments(withAttachments("look at these", files));
  assert.equal(r.text, "look at these");
  assert.deepEqual(r.attachments, [
    { name: "report (final).pdf", mimeType: "application/pdf", size: 1200n },
    { name: "notes.txt", mimeType: "text/plain", size: 3n },
  ]);
  assert.deepEqual(splitAttachments(withAttachments("", files.slice(1))), { text: "", attachments: [{ name: "notes.txt", mimeType: "text/plain", size: 3n }] });
  // A line typed in the middle of a message is the person's own text.
  const typed = "[pirc attachment] /x (a/b, 1 bytes)\nmore";
  assert.deepEqual(splitAttachments(typed), { text: typed, attachments: [] });
});
