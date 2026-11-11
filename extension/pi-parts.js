// The published extension's first entry, before loader.js: what the bundle
// cannot import of pi, left for it on globalThis (docs/design.md, section
// 8). pi's loader resolves pi's packages for a file with a static import of
// one, as here, but not for the bundle, which Node imports. These are pi-tui
// and pi's conversion to PNG, the very modules pi draws with; whole modules,
// so that a name one lacks fails nothing. Set in the factory, which pi runs
// at every load, /reload included.
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import * as piTui from "@earendil-works/pi-tui";

export default function () {
  globalThis[Symbol.for("pirc.piParts")] = { tui: piTui, convertToPng: piCodingAgent.convertToPng };
}
