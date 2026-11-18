// Writes cases/e2e/objects.json (objects.ts says what it holds):
//   node --experimental-transform-types --no-warnings crypto/test/record.ts
import { writeFileSync } from "node:fs";
import { build } from "./objects.ts";

writeFileSync(new URL("../../cases/e2e/objects.json", import.meta.url), JSON.stringify(await build(), null, 1) + "\n");
