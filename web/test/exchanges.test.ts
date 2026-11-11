// Every recorded exchange in cases/exchanges/, replayed (exchange.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { replay } from "./exchange.ts";

const dir = join(import.meta.dirname, "../../cases/exchanges");
for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const ex = JSON.parse(readFileSync(join(dir, name), "utf8")) as { about: string; steps: Record<string, never>[] };
  test(`${name}: ${ex.about}`, () => replay(ex.steps));
}
