// Where the running pi is installed, read from disk: the extension cannot
// import pi's code by its package name (docs/design.md, section 8).
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

// The folder of pi's package, from its command-line entry point; none when
// it cannot be found.
export function piPackageDir(): string | undefined {
  try {
    let dir = dirname(realpathSync(process.argv[1]));
    for (let i = 0; i < 5; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === "@earendil-works/pi-coding-agent") return dir;
      } catch {
        // Not here; look higher.
      }
    }
  } catch {
    // No entry point to follow.
  }
  return undefined;
}

export function piVersion(): string {
  const dir = piPackageDir();
  if (!dir) return "unknown";
  try {
    return String(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version);
  } catch {
    return "unknown";
  }
}
