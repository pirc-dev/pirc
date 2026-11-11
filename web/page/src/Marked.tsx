// What a search matched, marked in the text shown: the characters at a
// match's positions (offset into the searched text, of which this text is a
// part), bold and underlined; on a tint in the card looks and Cockpit.
export function Marked(p: { text: string; offset: number; positions: Set<number> }) {
  const parts: React.ReactNode[] = [];
  let run = "";
  let on = false;
  const flush = (k: number) => {
    if (run) parts.push(on ? <b key={k} className="font-bold text-ink underline decoration-ink3 decoration-2 underline-offset-[3px] cockpit:rounded-[2px] cockpit:bg-accent-soft cockpit:no-underline cards:rounded-[3px] cards:bg-accent-soft cards:font-semibold cards:text-accent cards:no-underline">{run}</b> : run);
    run = "";
  };
  // Positions count UTF-16 units, as the search's indexOf does.
  let i = 0;
  for (const c of p.text) {
    const hit = p.positions.has(p.offset + i);
    if (hit !== on) {
      flush(i);
      on = hit;
    }
    run += c;
    i += c.length;
  }
  flush(p.text.length);
  return <>{parts}</>;
}
