// Every case in cases/functions/ and cases/notices/, checked (functions.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { JsonValue } from "@bufbuild/protobuf";

import { call } from "./functions.ts";

interface Case { fn: string; about: string; args: JsonValue[]; is: JsonValue }

for (const folder of ["functions", "notices"]) {
  const dir = join(import.meta.dirname, "../../cases", folder);
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as { about: string; cases: Case[] };
    test(`${folder}/${name}: ${file.about}`, () => {
      for (const c of file.cases) assert.deepEqual(call(c.fn, c.args), c.is, `${c.fn}: ${c.about}`);
    });
  }
}
