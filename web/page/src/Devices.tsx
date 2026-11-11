// The hosts or the clients registered with the relay (docs/design.md, 5.3),
// as rows of one of Settings' sections, each online or not; one tapped
// opens a sheet to rename or remove it; below them, adding one. The names
// are the relay's, shared by every client.
import { useEffect, useState } from "react";
import type { DeviceView } from "../../core/view.ts";
import { Icon } from "./icons.tsx";
import { Invite } from "./Invite.tsx";
import { useLayer } from "./layer.ts";
import { live } from "./live.ts";
import { Answers, Sheet, SheetRow } from "./Sheet.tsx";

export function Devices(p: { role: "host" | "client"; devices: DeviceView[]; connected: boolean }) {
  const [key, setKey] = useState<string>();
  const layer = useLayer(key !== undefined, () => setKey(undefined));
  const [adding, setAdding] = useState(false);
  const addLayer = useLayer(adding, () => setAdding(false));
  const device = p.devices.find((d) => d.key === key);
  // Gone, removed elsewhere or out of reach with the relay: its sheet goes.
  useEffect(() => {
    if (key !== undefined && !device) layer.close();
    // layer.close reads only refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, device]);
  if (!p.connected) return <p className="px-5 py-3 text-[14px] text-ink2 cards:px-3.5 native:px-4 cockpit:px-4 cockpit:font-mono cockpit:text-[13px]">Not connected to the relay.</p>;
  // This web app first among the clients.
  const shown = p.devices.filter((d) => d.role === p.role).sort((a, b) => Number(b.self) - Number(a.self));
  return (
    <>
      {shown.map((d) => (
        <button
          key={d.key}
          className="flex min-h-14 w-full items-center gap-3 border-t border-rule px-5 py-2.5 text-left first:border-t-0 active:bg-wash cards:px-3.5 native:px-4 cockpit:px-4"
          onClick={() => {
            layer.show();
            setKey(d.key);
          }}
          aria-label={`${name(d)}: rename or remove`}
        >
          <span className={`size-2 flex-none rounded-full ${d.online ? "bg-done" : "ring-1 ring-ink3 ring-inset"}`} aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base cockpit:text-[15px]">{name(d)}</span>
            <span className="block truncate text-[13px] text-ink2 cockpit:font-mono cockpit:text-xs cockpit:text-ink3">{line(d)}</span>
          </span>
          <Icon name="chevron" className="size-[1em] text-ink3" />
        </button>
      ))}
      <button
        className="flex min-h-13 w-full items-center gap-3 border-t border-rule px-5 py-2.5 text-left text-base text-accent active:bg-wash cards:px-3.5 native:px-4 cockpit:px-4 cockpit:text-[15px]"
        onClick={() => {
          addLayer.show();
          setAdding(true);
        }}
      >
        <Icon name="plus" className="size-[1em]" />
        {p.role === "host" ? "Add a host" : "Add an app"}
      </button>
      {device && <DeviceSheet device={device} close={layer.close} />}
      {adding && <Invite role={p.role} close={addLayer.close} />}
    </>
  );
}

// This server shows as what it is, its label in its sheet.
function name(d: DeviceView): string {
  return d.self ? "This web app" : d.label || "Unnamed";
}

function line(d: DeviceView): string {
  if (d.self) return "Every browser signs in through it";
  // An app the relay wakes when a turn ends, even when closed (design.md, 5.3).
  const push = d.push ? " · Notifications on" : "";
  return `${d.online ? "Online" : "Offline"}${push} · key ${d.key.slice(0, 8)}…`;
}

function DeviceSheet(p: { device: DeviceView; close: () => void }) {
  const d = p.device;
  const [removing, setRemoving] = useState(false);
  const host = d.role === "host";
  if (removing) return <Remove device={d} back={() => setRemoving(false)} close={p.close} />;
  return (
    <Sheet title={d.self ? "This web app" : host ? "This host" : "This app"} sub={`Added ${new Date(d.addedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`} close={p.close}>
      <Rename device={d} close={p.close} />
      {/* The relay refuses this server's own key: every browser signs in with it. */}
      {!d.self && (
        <div className="mt-3">
          <SheetRow label={host ? "Remove this host" : "Remove this app"} sub={host ? "Its sessions end and it stops connecting" : "It loses access to every host"} danger onClick={() => setRemoving(true)} />
        </div>
      )}
    </Sheet>
  );
}

function Rename(p: { device: DeviceView; close: () => void }) {
  const d = p.device;
  const [label, setLabel] = useState(d.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = label.trim();
  const save = async () => {
    if (busy || !name) return;
    if (name === d.label) return p.close();
    setBusy(true);
    setError(undefined);
    try {
      const r = await live.rename(d.key, name);
      if (r.ok) p.close();
      else setError(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3.5 px-5 pb-1 cards:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="font-read text-[15.5px] leading-snug text-ink2">
        {d.role === "host" ? "The name its sessions show under, here and in every other app." : "The name the relay knows it by, the same in every app."}
      </p>
      <label className="flex flex-col gap-1 text-[13px] text-ink2">
        Name
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={128}
          enterKeyHint="done"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="border-b-[1.5px] border-ink bg-transparent py-2 font-read text-xl text-ink outline-none placeholder:text-ink3 cockpit:min-h-11 cockpit:rounded-lg cockpit:border cockpit:border-rule cockpit:bg-card cockpit:px-3 cockpit:py-0 cockpit:font-mono cockpit:text-base cockpit:focus:border-accent cards:min-h-12 cards:rounded-xl cards:border cards:border-rule cards:bg-card cards:px-3.5 cards:py-0 cards:text-base cards:focus:border-accent"
        />
      </label>
      <code className="rounded-[10px] bg-wash px-3.5 py-2.5 font-mono text-[13px] leading-relaxed break-all text-ink2 select-all">{d.key}</code>
      {error && <p className="text-[14px] text-block" role="alert">{error}</p>}
      <Answers cancel={p.close} label={busy ? "…" : "Save"} disabled={busy || !name} go={() => void save()} />
    </form>
  );
}

function Remove(p: { device: DeviceView; back: () => void; close: () => void }) {
  const d = p.device;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // Gone from the list, the sheet closes; this is for a refusal.
      const r = await live.remove(d.key);
      if (r.ok) p.close();
      else setError(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title={`Remove ${d.label || (d.role === "host" ? "this host" : "this app")}?`} close={p.close}>
      <div className="flex flex-col gap-3.5 px-5 pb-1 cards:px-4">
        <p className="font-read text-[15.5px] leading-snug text-ink2">
          {d.role === "host"
            ? <>Its sessions end here and in every other app, and it stops connecting to the relay. To bring it back, run <code className="font-mono text-[14px]">/pirc enrol</code> on it and approve it again.</>
            : "It loses access to every host at once, and is signed out of the relay. To bring it back, enrol it again."}
        </p>
        {error && <p className="text-[14px] text-block" role="alert">{error}</p>}
        <Answers cancel={p.back} cancelLabel="Back" label={busy ? "…" : "Remove"} danger disabled={busy} go={() => void remove()} />
      </div>
    </Sheet>
  );
}
