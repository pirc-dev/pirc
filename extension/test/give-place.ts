// A pi extension for the end-to-end tests: /giveplace <text> says where pi
// runs through pirc:place, as another extension would (docs/design.md,
// section 4); /giveplace alone hands back to PiRC's own detection.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("giveplace", {
    description: "test: give PiRC a place",
    handler: async (args) => {
      const text = args.trim();
      pi.events.emit("pirc:place", text ? { kind: "test", display: text } : null);
    },
  });
}
