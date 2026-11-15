// Two installs of PiRC in one pi (copies.ts): which copy runs, and the
// install the other names to remove.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { claimLoad, installOf, packageRoot } from "../src/copies.ts";

// pi's event bus, one per load: handlers run as the event is emitted.
function bus(): ExtensionAPI["events"] {
  const e = new EventEmitter();
  return {
    emit: (channel: string, data: unknown) => void e.emit(channel, data),
    on: (channel: string, handler: (data: unknown) => void) => {
      e.on(channel, handler);
      return () => void e.off(channel, handler);
    },
  } as ExtensionAPI["events"];
}

const agent = "/home/u/.pi/agent";
const git = `${agent}/git/github.com/pirc-dev/pirc-extension`;
const npm = `${agent}/npm/node_modules/pirc-extension`;

test("a copy's folder, from its module's URL, a query and all", () => {
  assert.equal(packageRoot(`file://${npm}/pirc.js?t=1731661234.5`), npm);
});

test("the install a folder is, as pi remove takes it", () => {
  assert.equal(installOf(git), "git:github.com/pirc-dev/pirc-extension");
  assert.equal(installOf(npm), "npm:pirc-extension");
  assert.equal(installOf(`${agent}/npm/node_modules/@pirc-dev/extension`), "npm:@pirc-dev/extension");
  assert.equal(installOf("/src/pirc/extension/src"), "/src/pirc/extension/src");
});

test("alone, a copy runs, and so does a later load of it", () => {
  const events = bus();
  assert.equal(claimLoad(events, npm), undefined);
  assert.equal(claimLoad(events, npm), undefined);
});

test("the first copy loaded runs, and the second names the git install to remove", () => {
  let events = bus();
  assert.equal(claimLoad(events, git), undefined);
  assert.equal(
    claimLoad(events, npm),
    "pirc: PiRC is installed twice, as git:github.com/pirc-dev/pirc-extension and npm:pirc-extension, and only git:github.com/pirc-dev/pirc-extension runs. Remove one: pi remove git:github.com/pirc-dev/pirc-extension, then /reload",
  );
  events = bus();
  assert.equal(claimLoad(events, npm), undefined);
  assert.match(claimLoad(events, git)!, /only npm:pirc-extension runs\. Remove one: pi remove git:github\.com\/pirc-dev\/pirc-extension,/);
});

test("on a new load's bus, after the other install is removed, the copy left runs", () => {
  const before = bus();
  claimLoad(before, git);
  claimLoad(before, npm);
  assert.equal(claimLoad(bus(), npm), undefined);
});
