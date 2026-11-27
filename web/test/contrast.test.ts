// The page's text colours against what they sit on (page/src/index.css):
// ink2 and ink3, secondary and tertiary text, at least 4.5:1 (WCAG AA) in
// every look and scheme, on paper, card, sheet and sheet-card and on the
// grey wash laid over each; and red text on its pale red.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("../page/src/index.css", import.meta.url), "utf8");

type Vars = Record<string, string>;
// Each block of variables: its look ("quiet" for :root), and whether it is
// the dark scheme's.
const blocks: { look: string; dark: boolean; vars: Vars }[] = [];
for (const m of css.matchAll(/:root(?:\[data-look="(\w+)"\])? \{([^}]*)\}/g)) {
  const vars: Vars = {};
  for (const v of m[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[v[1]] = v[2].trim();
  if (Object.keys(vars).length === 0) continue;
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*$/.test(css.slice(0, m.index));
  blocks.push({ look: m[1] ?? "quiet", dark, vars });
}

// As the cascade has them: Quiet's light, its dark, the look's light, its dark.
function varsOf(look: string, dark: boolean): Vars {
  const pick = (l: string, d: boolean) => blocks.find((b) => b.look === l && b.dark === d)?.vars ?? {};
  const layers = [pick("quiet", false), dark ? pick("quiet", true) : {}, look === "quiet" ? {} : pick(look, false), look !== "quiet" && dark ? pick(look, true) : {}];
  return Object.assign({}, ...layers);
}

type Rgba = [number, number, number, number];
function color(vars: Vars, name: string): Rgba {
  let v = vars[name];
  for (let i = 0; i < 5; i++) {
    const ref = /^var\(--([\w-]+)\)$/.exec(v);
    if (!ref) break;
    v = vars[ref[1]];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(v);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3], rgb[4] ? +rgb[4] : 1];
  throw new Error(`--${name}: ${v}`);
}
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1) as Rgba;
function lum(c: Rgba): number {
  const ch = (v: number) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
}
const contrast = (a: Rgba, b: Rgba) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

for (const look of ["quiet", "triage", "native", "cockpit"]) {
  for (const dark of [false, true]) {
    test(`${look} ${dark ? "dark" : "light"}: secondary and tertiary text are 4.5:1 or more`, () => {
      const vars = varsOf(look, dark);
      const grounds: [string, Rgba][] = ["paper", "card", "sheet", "sheet-card"].map((g) => [g, color(vars, g)]);
      for (const [g, c] of [...grounds]) grounds.push([`wash on ${g}`, over(color(vars, "wash"), c)]);
      // Stop's word, and errors, red on their pale red.
      for (const g of ["paper", "card"]) {
        const r = contrast(color(vars, "block"), over(color(vars, "block-wash"), color(vars, g)));
        assert.ok(r >= 4.5, `block on its wash on ${g}: ${r.toFixed(2)}`);
      }
      for (const ink of ["ink2", "ink3"]) {
        for (const [g, c] of grounds) {
          const r = contrast(color(vars, ink), c);
          assert.ok(r >= 4.5, `${ink} on ${g}: ${r.toFixed(2)}`);
        }
      }
    });
  }
}
