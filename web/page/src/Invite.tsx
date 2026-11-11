// Adding a host or an app (docs/design.md, 5.3): a one-time token from the
// relay, shown once and kept nowhere. A host's as the /pirc enrol line to
// run in its pi; an app's as a pirc://join link and its QR code, for the
// mobile app to scan.
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";

import { CopyButton } from "./Copy.tsx";
import { live } from "./live.ts";
import { Answers, Sheet } from "./Sheet.tsx";

type Role = "host" | "client";
type Made = { role: Role; token: string; expiresAt: number; relay: string };

// The link an app joins by.
export function joinLink(relay: string, token: string): string {
  return `pirc://join?relay=${encodeURIComponent(relay)}&token=${encodeURIComponent(token)}`;
}

export function Invite(p: { role: Role; close: () => void }) {
  const [made, setMade] = useState<Made>();
  return made ? <Token made={made} close={p.close} /> : <Ask role={p.role} made={setMade} close={p.close} />;
}

function Ask(p: { role: Role; made: (m: Made) => void; close: () => void }) {
  const role = p.role;
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const make = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await live.invite(role, label.trim());
      if (r.ok) p.made({ role, token: r.token, expiresAt: r.expiresAt, relay: r.relay });
      else setError(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={role === "host" ? "Add a host" : "Add an app"} sub="With a one-time token, valid for 15 minutes" close={p.close}>
      <form
        className="flex flex-col gap-3.5 px-5 pb-1 cards:px-4"
        onSubmit={(e) => {
          e.preventDefault();
          void make();
        }}
      >
        <p className="font-read text-[15.5px] leading-snug text-ink2">
          {role === "host"
            ? "A computer running pi, whose sessions then show here. You run a line in its pi; nobody needs to compare keys."
            : "PiRC's app on a phone, which scans a code to join. It can then see and run every session, as this one can."}
        </p>
        <label className="flex flex-col gap-1 text-[13px] text-ink2">
          Name
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={128}
            placeholder="Its own, if left empty"
            enterKeyHint="go"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="border-b-[1.5px] border-ink bg-transparent py-2 font-read text-xl text-ink outline-none placeholder:text-ink3 cockpit:min-h-11 cockpit:rounded-lg cockpit:border cockpit:border-rule cockpit:bg-card cockpit:px-3 cockpit:py-0 cockpit:font-mono cockpit:text-base cockpit:focus:border-accent cards:min-h-12 cards:rounded-xl cards:border cards:border-rule cards:bg-card cards:px-3.5 cards:py-0 cards:text-base cards:focus:border-accent"
          />
        </label>
        {error && <p className="text-[14px] text-block" role="alert">{error}</p>}
        <Answers cancel={p.close} label={busy ? "…" : "Make a token"} disabled={busy} go={() => void make()} />
      </form>
    </Sheet>
  );
}

function Token(p: { made: Made; close: () => void }) {
  const m = p.made;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const expired = now >= m.expiresAt;
  const until = new Date(m.expiresAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const text = m.role === "host" ? `/pirc enrol ${m.relay} ${m.token}` : joinLink(m.relay, m.token);
  return (
    <Sheet title={m.role === "host" ? "Add a host" : "Add an app"} sub={expired ? "The token has expired" : `Valid until ${until}, for one ${m.role === "host" ? "host" : "app"}`} close={p.close}>
      <div className="flex flex-col gap-3.5 px-5 pb-1 cards:px-4">
        {expired ? (
          <p className="font-read text-[15.5px] leading-snug text-ink2">Nothing joined with it in time. Make another when it is at hand.</p>
        ) : (
          <>
            <p className="font-read text-[15.5px] leading-snug text-ink2">
              {m.role === "host"
                ? "In pi on that computer, run this line. It joins at once and shows in the list."
                : "On the phone, scan this with PiRC's app, or open the link there. It joins at once and shows in the list."}
            </p>
            {m.role === "client" && <Qr text={text} />}
            <div className="flex items-start gap-1 rounded-[10px] bg-wash py-1 pr-1.5 pl-3.5">
              <code className="min-w-0 flex-1 py-1.5 font-mono text-[13px] leading-relaxed break-all text-ink select-all">{text}</code>
              <CopyButton text={() => text} label={m.role === "host" ? "Copy the line" : "Copy the link"} />
            </div>
            <p className="text-[13px] text-ink3">Shown once: closing this forgets it. Anyone with it can join until it is used.</p>
          </>
        )}
        <button className="h-12 rounded-full bg-ink text-[15.5px] font-semibold text-paper cards:h-13 cards:rounded-[14px] cards:bg-accent cards:text-on-accent cockpit:rounded-[10px] cockpit:bg-accent cockpit:text-on-accent" onClick={p.close}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

// Dark on white whatever the look, with the quiet zone scanners need.
function Qr(p: { text: string }) {
  const { size, path } = useMemo(() => {
    const q = encode(p.text, { ecc: "M", border: 4 });
    let d = "";
    q.data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { size: q.size, path: d };
  }, [p.text]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto block aspect-square w-full max-w-64 rounded-xl" role="img" aria-label="QR code of the link" shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
