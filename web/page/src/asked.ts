// A question's text as the question area shows it (Ask.tsx), its line
// breaks and indentation kept: indented lines, and a block a line opens
// with { or [ to where it closes, are code; "Name: value" lines a label
// and its value, and "Name:" alone a label; the rest plain text.
export type Part =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "field"; label: string; value: string }
  | { kind: "label"; label: string };

const FIELD = /^([A-Za-z][\w .'/-]{0,40}):(?:[ \t]+(\S.*?))?\s*$/;
const count = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
const depth = (l: string) => count(l, /[{[]/g) - count(l, /[}\]]/g);
const indented = (l: string | undefined) => l !== undefined && /^\s+\S/.test(l);

export function parts(text: string): Part[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Part[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    if (indented(l) || /[{[]\s*$/.test(l)) {
      const start = i;
      let open = 0;
      do open += depth(lines[i++]);
      while (i < lines.length && (open > 0 || indented(lines[i])));
      const block = lines.slice(start, i);
      // As a block of its own: without the indentation every line shares.
      const shared = Math.min(...block.filter((x) => x.trim()).map((x) => /^\s*/.exec(x)![0].length));
      out.push({ kind: "code", text: block.map((x) => x.slice(shared)).join("\n").trimEnd() });
      continue;
    }
    const f = FIELD.exec(l);
    if (f) {
      out.push(f[2] ? { kind: "field", label: f[1], value: f[2] } : { kind: "label", label: f[1] });
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].trim() && !indented(lines[i]) && !/[{[]\s*$/.test(lines[i]) && !FIELD.test(lines[i])) i++;
    out.push({ kind: "text", text: lines.slice(start, i).join("\n") });
  }
  return out;
}
