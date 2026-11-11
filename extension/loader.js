// The published extension's entry point. pi's /reload imports the
// extension again, but Node keeps every JavaScript module it has imported,
// so a bundle updated in place would not run until pi restarted. This file
// imports the bundle beside it by a URL that changes when the file does,
// so a reload after an update runs the new code, and is the same in every
// version, so that its own copy, which Node keeps, is never stale. Not
// index.js: versions before it had their bundle there, which Node would
// still hold after updating from one of them.
import { statSync } from "node:fs";

export default async function (pi) {
  const bundle = new URL("./pirc.js", import.meta.url);
  const { default: factory } = await import(`${bundle.href}?t=${statSync(bundle).mtimeMs}`);
  return factory(pi);
}
