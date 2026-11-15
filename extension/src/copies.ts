// Two installs of PiRC in one pi, from git and from npm say, are two
// packages to pi, which knows an npm package by its name and a git one by
// its URL; both load, and pi then drops the /pirc command that each
// registers. So the first copy pi loads runs, and any other, from another
// folder, says which install to remove and does nothing. The copies find
// each other on pi's event bus, which is one per load, and on which pi
// drops a load's listeners when it reloads: a copy that hears none is the
// only one. A later load of the same copy (a session replaced) may still
// hear an earlier one, which is itself.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COPY_EVENT = "pirc:copy";

interface Claim {
  root: string;
  owner?: string;
}

/** The folder of the package a module is in: the published package's, or the source's. */
export function packageRoot(moduleURL: string): string {
  return dirname(fileURLToPath(new URL("./x", moduleURL)));
}

/**
 * The install a folder is, as `pi remove` takes it: `git:<host>/<path>`
 * for pi's git checkouts, `npm:<name>` for its npm installs, otherwise the
 * folder.
 */
export function installOf(root: string): string {
  const git = /\/git\/([^/]+\/.+)$/.exec(root);
  if (git) return `git:${git[1]}`;
  const npm = /\/node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(root);
  if (npm) return `npm:${npm[1]}`;
  return root;
}

/**
 * Claims this load of pi for the copy at `root`: undefined when it is the
 * only copy, which then answers later ones, or the line to show when
 * another copy has it.
 */
export function claimLoad(events: ExtensionAPI["events"], root: string): string | undefined {
  const claim: Claim = { root };
  events.emit(COPY_EVENT, claim);
  if (claim.owner === undefined || claim.owner === root) {
    events.on(COPY_EVENT, (data) => {
      const other = data as Claim | undefined;
      if (other && typeof other === "object" && other.owner === undefined) other.owner = root;
    });
    return undefined;
  }
  const [running, here] = [installOf(claim.owner), installOf(root)];
  // The docs lead with npm, so a git install is the one to go.
  const remove = running.startsWith("git:") && !here.startsWith("git:") ? running : here;
  return `pirc: PiRC is installed twice, as ${running} and ${here}, and only ${running} runs. Remove one: pi remove ${remove}, then /reload`;
}
