// The licences of the third-party packages a bundle carries, as one text
// file, for the web app's builds (its server's bundle, and the page, which
// every browser receives). Written from the bundle's own list of modules,
// so it names exactly what is inside.
//
// Each package's licence files (LICENSE, LICENCE, COPYING, NOTICE, any
// extension) are reproduced in full. A package that ships none has them
// from third_party/ when SUPPLIED names it there, else is listed with its
// package.json's licence and author, and says so.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Packages that ship no licence file, and the directory of third_party/
// that holds their licences (NOTICE).
const SUPPLIED: Record<string, string> = {
  "@bufbuild/protobuf": "bufbuild-protobuf",
};
const thirdParty = resolve(import.meta.dirname, "..", "third_party");

// The package directories, "…/node_modules/<name>" or
// "…/node_modules/@scope/<name>", of the module paths given.
export function packageRoots(modules: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const m of modules) {
    const i = m.lastIndexOf("node_modules/");
    if (i < 0) continue;
    const rest = m.slice(i + "node_modules/".length).split("/");
    const name = rest[0].startsWith("@") ? rest.slice(0, 2).join("/") : rest[0];
    roots.add(m.slice(0, i) + "node_modules/" + name);
  }
  return [...roots];
}

export function licenses(title: string, roots: string[]): string {
  const pkgs = roots
    .map((dir) => ({ dir, json: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license?: string; author?: string | { name?: string } } }))
    // One entry per name and version (pnpm can link the same twice).
    .filter((p, i, all) => all.findIndex((q) => q.json.name === p.json.name && q.json.version === p.json.version) === i)
    .sort((a, b) => `${a.json.name}@${a.json.version}`.localeCompare(`${b.json.name}@${b.json.version}`));
  const out = [
    `${title}`,
    "",
    `Third-party code in it: ${pkgs.length} packages, each with its licence below.`,
    "",
    ...pkgs.map((p) => `  ${p.json.name}@${p.json.version} (${p.json.license ?? "no licence given"})`),
    "",
  ];
  for (const p of pkgs) {
    out.push("=".repeat(78), `${p.json.name}@${p.json.version}`, "=".repeat(78), "");
    let dir = p.dir;
    let files = existsSync(dir) ? readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(f)).sort() : [];
    if (files.length === 0 && SUPPLIED[p.json.name]) {
      dir = join(thirdParty, SUPPLIED[p.json.name]);
      files = readdirSync(dir).sort();
      out.push(`This package ships no licence file; its licences, from PiRC's third_party/${SUPPLIED[p.json.name]}:`, "");
    }
    if (files.length === 0) {
      const author = typeof p.json.author === "string" ? p.json.author : p.json.author?.name;
      out.push(`This package ships no licence file. Its package.json gives the licence as ${p.json.license ?? "(none)"}${author ? `, by ${author}` : ""}.`, "");
      continue;
    }
    for (const f of files) out.push(readFileSync(join(dir, f), "utf8").trimEnd(), "");
  }
  return out.join("\n") + "\n";
}
