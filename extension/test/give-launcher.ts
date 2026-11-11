// A pi extension for the end-to-end tests and the demo: gives PiRC a
// launcher through pirc:launcher, as another extension would
// (docs/design.md, section 4). It opens the new pi as tmux would, but with
// this pi's own arguments, which load the extension and the fake model.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { tmuxLauncher } from "../src/launch.ts";

export default function (pi: ExtensionAPI): void {
  const tmux = tmuxLauncher(process.env);
  if (!tmux) return;
  // On every session start: PiRC's listener is there by then, whatever
  // order the extensions load in, and a reload starts PiRC afresh.
  pi.on("session_start", () => {
    pi.events.emit("pirc:launcher", {
      name: "test",
      launch: (o: Parameters<typeof tmux.launch>[0]) => tmux.launch({ ...o, command: [...o.command, ...process.argv.slice(2)] }),
    });
  });
}
