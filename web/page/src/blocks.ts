// A reply being written, split where one top-level block ends and the next
// begins: at a blank line outside a code fence, before a line that starts
// at the margin and is not a list item, a table row or a quote's next
// line. Each block is then parsed once, as it is finished, and only the
// last, still growing, again with each word: parsing the whole reply with
// each word costs more the longer it gets. A reply with reference links or
// footnotes, which may be defined in another block, stays whole. Once
// written, a reply is drawn whole, as before.
export function blocksOf(text: string): string[] {
  if (/^ {0,3}\[[^\]]+\]:/m.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let start = 0;
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0].repeat(f[1].length);
      else if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence || line.trim() !== "" || i + 1 >= lines.length) continue;
    const next = lines[i + 1];
    if (next.trim() === "" || /^\s/.test(next) || /^([-*+]|\d+[.)])\s/.test(next) || /^[|>]/.test(next)) continue;
    // A list ends only where the next block is not one of its items.
    blocks.push(lines.slice(start, i).join("\n"));
    start = i + 1;
  }
  blocks.push(lines.slice(start).join("\n"));
  return blocks.filter((b) => b.trim() !== "");
}
