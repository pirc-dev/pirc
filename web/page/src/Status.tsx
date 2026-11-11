// A session's status: blocked, working, done or idle.

// herdr's statuses, as dingger shows them: blocked (pi asks a question),
// working, done (finished since last opened here) and idle. Shown as
// characters in their colour, as in a terminal; in Triage, each on a small
// tile; in Native, on a round badge.
export const tone = { blocked: "text-block", working: "text-work", done: "text-done", idle: "text-idle" };

export function Status(p: { on: boolean; compacting?: boolean; asks?: boolean; news?: boolean; className?: string }) {
  const [symbol, color, label] =
    p.asks ? ["×", `${tone.blocked} cards:bg-block-wash`, "Asks a question"]
    : p.on || p.compacting ? ["◐", `${tone.working} animate-pulse cards:bg-work-wash`, p.compacting ? "Compacting" : "Working"]
    : p.news ? ["✓", `${tone.done} cards:bg-done-wash`, "Finished since last opened"]
    : ["○", `${tone.idle} cards:ring-1 cards:ring-rule cards:ring-inset native:bg-idle-wash native:ring-0`, "Idle"];
  const tile = "cards:grid cards:size-[22px] cards:place-items-center cards:self-center cards:rounded-md cards:text-[13px] cards:leading-none native:size-8 native:rounded-full native:text-base";
  return <span className={`inline-block shrink-0 text-center font-mono font-semibold ${color} ${p.className ?? "w-4 text-[15px]"} ${tile}`} title={label} aria-label={label} role="img">{symbol}</span>;
}
