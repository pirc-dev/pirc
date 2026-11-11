// Machines asking to join the relay (docs/design.md, 5.3): a line on the
// session list for each, and a sheet to approve or reject one once its key
// matches the one the machine shows.
import { useEffect, useState } from "react";
import type { PendingHostView } from "../../core/view.ts";
import { Icon } from "./icons.tsx";
import { useLayer } from "./layer.ts";
import { live } from "./live.ts";
import { ago } from "./names.ts";
import { Answers, Sheet } from "./Sheet.tsx";
import { useNow } from "./time.ts";

export function JoinRequests(p: { hosts: PendingHostView[] }) {
  const [key, setKey] = useState<string>();
  const layer = useLayer(key !== undefined, () => setKey(undefined));
  const host = p.hosts.find((h) => h.key === key);
  // Decided, here or elsewhere, or expired: its sheet goes.
  useEffect(() => {
    if (key !== undefined && !host) layer.close();
    // layer.close reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, host]);
  if (p.hosts.length === 0) return null;
  return (
    <>
      <ul className="mx-5 mt-1 mb-2 flex flex-col gap-1.5 cards:mx-3 native:mx-4 cockpit:mx-3.5">
        {p.hosts.map((h) => (
          <li key={h.key}>
            <button
              className="flex min-h-11 w-full items-center gap-2.5 rounded-[10px] bg-work-wash px-3.5 py-2 text-left text-[14.5px] text-work cockpit:font-mono cockpit:text-[13px]"
              onClick={() => {
                layer.show();
                setKey(h.key);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{h.label || "A machine"} asks to join</span>
                <span className="block truncate font-mono text-[12px] opacity-80">key {h.key.slice(0, 16)}…</span>
              </span>
              <Icon name="chevron" />
            </button>
          </li>
        ))}
      </ul>
      {host && <Decide host={host} close={layer.close} />}
    </>
  );
}

function Decide(p: { host: PendingHostView; close: () => void }) {
  const h = p.host;
  const now = useNow();
  const [label, setLabel] = useState(h.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = async (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await live.decide(h.key, approve, approve ? label.trim() : undefined);
      // Done: the list no longer has it, and the sheet closes with it.
      if (!r.ok) setError(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Add this machine?" sub={`Asked ${ago(h.firstSeen, now) === "now" ? "just now" : `${ago(h.firstSeen, now)} ago`}${h.remote ? ` from ${h.remote}` : ""}`} close={p.close}>
      <div className="flex flex-col gap-3.5 px-5 pb-1 cards:px-4">
        <p className="font-read text-[15.5px] leading-snug text-ink2">
          Approve it only if this key is the one <code className="font-mono text-[14px] text-ink">/pirc status</code> shows on that machine. Its sessions then appear here, and what you send them runs there.
        </p>
        <code className="rounded-[10px] bg-wash px-3.5 py-2.5 font-mono text-[14px] leading-relaxed break-all text-ink select-all">{h.key}</code>
        {h.software && <p className="text-[13px] text-ink2 cockpit:font-mono cockpit:text-xs">It runs {h.software}.</p>}
        <label className="flex flex-col gap-1 text-[13px] text-ink2">
          Name it
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={h.label || "A name for this machine"}
            maxLength={128}
            enterKeyHint="done"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="border-b-[1.5px] border-ink bg-transparent py-2 font-read text-xl text-ink outline-none placeholder:text-ink3 cockpit:min-h-11 cockpit:rounded-lg cockpit:border cockpit:border-rule cockpit:bg-card cockpit:px-3 cockpit:py-0 cockpit:font-mono cockpit:text-base cockpit:focus:border-accent cards:min-h-12 cards:rounded-xl cards:border cards:border-rule cards:bg-card cards:px-3.5 cards:py-0 cards:text-base cards:focus:border-accent"
          />
        </label>
        {error && <p className="text-[14px] text-block" role="alert">{error}</p>}
        <Answers cancel={() => void decide(false)} cancelLabel="Reject" label={busy ? "…" : "Approve"} disabled={busy} go={() => void decide(true)} />
      </div>
    </Sheet>
  );
}
