// Bundles the extension or the web app's server into one ES module for
// Node 22, for sh/build.sh (docs/design.md, section 12, step 9).
//
//   node sh/bundle.ts extension|web <version> <outfile>
//
// For the extension, fails if the bundle takes in a package NOTICE does not
// list: the third-party code it carries is exactly what third_party/
// licenses. The web app's server carries far more, so its
// licences are written beside it, as third-party-licenses.txt, from what
// the bundle holds (sh/licenses.ts).
import { build } from "esbuild";
import { chmodSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { licenses, packageRoots } from "./licenses.ts";

const ENTRIES: Record<string, string> = {
  extension: "extension/src/index.ts",
  web: "web/server/main.ts",
};

// The third-party packages the extension's bundle carries, as NOTICE lists
// them.
const PACKAGES = ["@bufbuild/protobuf@2.16.0", "ws@8.22.0"];

const [what, version, outfile] = process.argv.slice(2);
const entry = ENTRIES[what ?? ""];
if (!entry || !version || !outfile) {
  console.error("usage: node sh/bundle.ts extension|web <version> <outfile>");
  process.exit(2);
}

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // pi supplies its own packages to extensions; the extension imports only
  // their types, so nothing of pi ends up in the bundle either way.
  external: ["@earendil-works/*"],
  define: { PIRC_VERSION: JSON.stringify(version) },
  // ws is CommonJS and require()s Node's modules, which esbuild's ES output
  // cannot do on its own: without this the bundle throws on load. Its
  // optional native modules (bufferutil, utf-8-validate) are required inside
  // its own try, and fall back to JavaScript.
  banner: {
    js: [
      what === "web"
        ? `// PiRC web app ${version}. Third-party code in this file: see third-party-licenses.txt beside it.`
        : `// PiRC ${what} ${version}. Third-party code in this file: ${PACKAGES.join(", ")}; see NOTICE.`,
      'import { createRequire as __pircCreateRequire } from "node:module";',
      "const require = __pircCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
  metafile: true,
  write: false,
  logLevel: "warning",
});

// node_modules/.pnpm/<name>@<version>/node_modules/<name>/...
const seen = new Set<string>();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/\.pnpm\/((?:@[^+/]+\+)?[^@/]+@[^/_]+)/.exec(input);
  if (m) seen.add(m[1].replace("+", "/"));
}
const unexpected = [...seen].filter((p) => !PACKAGES.includes(p));
const missing = PACKAGES.filter((p) => !seen.has(p));
if (what === "web") {
  writeFileSync(join(dirname(outfile), "third-party-licenses.txt"), licenses(`PiRC's web app ${version}: the server (pirc-web.mjs)`, packageRoots(Object.keys(result.metafile.inputs))));
} else if (unexpected.length || missing.length) {
  console.error(`bundle: the ${what} carries packages NOTICE does not list: ${unexpected.join(", ") || "none"}; listed but absent: ${missing.join(", ") || "none"}`);
  process.exit(1);
}

// esbuild keeps the entry point's own #! line, which for the web app's
// server runs the TypeScript source; the bundle runs on stock Node.
let text = result.outputFiles[0].text.replace(/^#![^\n]*\n/, "");
const command = what === "web";
if (command) text = `#!/usr/bin/env node\n${text}`;
writeFileSync(outfile, text);
if (command) chmodSync(outfile, 0o755);
console.log(`${outfile}: ${[...seen].sort().join(", ")}`);
