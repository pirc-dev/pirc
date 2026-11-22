// A session's status: asking, working, done or idle.

// herdr's statuses, in its words: blocked (pi asks a question),
// working, done (finished since last opened here) and idle; here a
// question is in the accent colour, as something waiting for the person,
// not an error. Shown as characters in their colour, as in a terminal; in
// Triage, each on a small tile; in Native, on a round badge.
export const tone = { asking: "text-accent", working: "text-work", done: "text-done", idle: "text-idle" };

// What each session counts as in the list's counts: one status each, the
// first that holds of asking, working and done, so that they add up.
export function counted(s: { questions?: unknown[]; working: boolean; compacting: boolean }, news: boolean): "asking" | "working" | "done" | undefined {
  return s.questions?.length ? "asking" : s.working || s.compacting ? "working" : news ? "done" : undefined;
}

export function Status(p: { on: boolean; compacting?: boolean; asks?: boolean; news?: boolean; className?: string }) {
  const [symbol, color, label] =
    p.asks ? ["?", `${tone.asking} cards:bg-accent-soft`, "Asks a question"]
    : p.on || p.compacting ? ["◐", `${tone.working} animate-pulse cards:bg-work-wash`, p.compacting ? "Compacting" : "Working"]
    : p.news ? ["✓", `${tone.done} cards:bg-done-wash`, "Finished since last opened"]
    : ["○", `${tone.idle} cards:ring-1 cards:ring-rule cards:ring-inset native:bg-idle-wash native:ring-0`, "Idle"];
  const tile = "cards:grid cards:size-[22px] cards:place-items-center cards:self-center cards:rounded-md cards:text-[13px] cards:leading-none native:size-8 native:rounded-full native:text-base";
  return <span className={`inline-block shrink-0 text-center font-mono font-semibold ${color} ${p.className ?? "w-4 text-[15px]"} ${tile}`} title={label} aria-label={label} role="img">{symbol}</span>;
}
