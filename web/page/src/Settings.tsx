// Settings, a screen of its own at /settings, where a chat would be: on a
// phone over the list, on a laptop beside it; leaving goes back to the
// chat or list it was opened from. This browser's settings (notifications,
// the look and the keys, each kept in it), then the hosts and the clients
// registered with the relay (docs/web.md, section 5).
import type { DeviceView } from "../../core/view.ts";
import { useEffect, useId, useRef } from "react";

import { Devices } from "./Devices.tsx";
import { Icon } from "./icons.tsx";
import { free, setKeys, useKey, useKeyboard, useKeys } from "./keys.ts";
import { LOOKS, setLook, useLook } from "./look.ts";
import { unblock, useNotify } from "./Notify.tsx";

export function Settings(p: { back: () => void; wide: boolean; devices: DeviceView[]; connected: boolean }) {
  // Focus comes to the title, so that a screen reader starts here.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus({ preventScroll: true }), []);
  // Esc goes back, as from a sheet, whether or not the keys are on.
  useKey(true, (e) => {
    if (e.key !== "Escape" || !free(e)) return;
    e.preventDefault();
    p.back();
  });
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-paper pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-[40rem]">
        <header className="px-5 pt-3 cards:px-4 cockpit:px-3.5">
          {!p.wide && (
            <div className="-ml-1 flex min-h-8 items-center">
              <button className="flex min-h-11 items-center gap-0.5 text-[15px] text-ink2 cards:text-[16px] cards:text-accent native:text-[17px] cockpit:font-mono cockpit:text-sm" onClick={p.back}>
                <Icon name="back" className="size-5" />Sessions
              </button>
            </div>
          )}
          <h1 ref={heading} tabIndex={-1} className={`mb-1.5 truncate outline-none font-read text-[34px] leading-tight tracking-[-0.015em] cards:mb-2.5 cards:text-[28px] cards:font-[650] cards:tracking-[-0.03em] native:text-[34px] native:font-bold native:tracking-[0.01em] cockpit:mb-1 cockpit:font-mono cockpit:text-[22px] cockpit:font-bold cockpit:tracking-[-0.02em] ${p.wide ? "mt-8" : "mt-0.5 cockpit:mt-1"}`}>Settings</h1>
        </header>
        <Section title="This browser" sub="Kept here: each browser has its own.">
          <Notifications />
          <LookChoice />
          <Keys />
        </Section>
        <Section title="Hosts" sub="Computers running pi, whose sessions show here.">
          <Devices role="host" devices={p.devices} connected={p.connected} />
        </Section>
        <Section title="Clients" sub="This web app and the phone apps, each reaching every host.">
          <Devices role="client" devices={p.devices} connected={p.connected} />
        </Section>
      </div>
    </div>
  );
}

function Section(p: { title: string; sub: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="pt-5">
      <h2 id={id} className="px-5 text-xs font-semibold tracking-[0.12em] text-ink2 uppercase cards:px-7 native:px-8 native:text-[13px] native:font-normal native:tracking-[0.03em] cockpit:px-3.5 cockpit:font-mono cockpit:tracking-[0.06em]">{p.title}</h2>
      <p className="px-5 pt-1 pb-2.5 text-[13px] text-ink3 cards:px-7 native:px-8 cockpit:px-3.5 cockpit:font-mono cockpit:text-xs">{p.sub}</p>
      <div className="border-b border-rule cards:mx-3 cards:overflow-hidden cards:rounded-[14px] cards:border cards:bg-card native:mx-4 native:border-0">{p.children}</div>
    </section>
  );
}

// A row: a label, a line under it, and its control at the end; or, with
// below, a control under the label (the looks).
function Row(p: { label: string; labelId?: string; sub?: React.ReactNode; end?: React.ReactNode; below?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="border-t border-rule px-5 py-3 first:border-t-0 cards:px-3.5 native:px-4 cockpit:px-4">
      <div className="flex min-h-8 items-center gap-3">
        <div className="min-w-0 flex-1">
          <div id={p.labelId} className="text-base cockpit:text-[15px]">{p.label}</div>
          {p.sub && <div className="mt-0.5 text-[13px] text-ink2 cockpit:font-mono cockpit:text-xs cockpit:text-ink3">{p.sub}</div>}
        </div>
        {p.end}
      </div>
      {p.below}
    </div>
  );
}

// An on/off switch, as the phone's own: its state is what it shows. One
// that cannot be used now stays where Tab reaches it, with the line saying
// why read with it.
function Switch(p: { on: boolean; disabled?: boolean; busy?: boolean; labelledBy: string; describedBy?: string; set: (on: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={p.on}
      aria-labelledby={p.labelledBy}
      aria-describedby={p.describedBy}
      aria-disabled={p.disabled || undefined}
      aria-busy={p.busy || undefined}
      onClick={() => !p.disabled && p.set(!p.on)}
      className="relative h-[31px] w-[51px] flex-none rounded-full bg-wash2 transition-colors duration-150 aria-disabled:opacity-40 aria-checked:bg-done cards:aria-checked:bg-accent native:aria-checked:bg-[#34c759] cockpit:rounded-md"
    >
      <span className={`absolute top-[2px] left-[2px] size-[27px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-150 cockpit:rounded-[5px] ${p.on ? "translate-x-5" : ""}`} />
    </button>
  );
}

function Notifications() {
  const n = useNotify();
  const label = useId();
  const line = useId();
  const s = n.state;
  const sub =
    s.kind === "checking" ? "…"
    : s.kind === "unsupported" ? s.why
    : s.kind === "blocked" ? unblock()
    : s.kind === "busy" ? (s.was === "off" ? "Turning on…" : "Turning off…")
    : s.kind === "on" ? "On in this browser: when a turn ends or pi asks."
    : "When a turn ends or pi asks.";
  // While turning on or off, it shows what was, until the browser answers.
  const on = s.kind === "on" || (s.kind === "busy" && s.was === "on");
  return (
    <>
      <Row
        label="Notifications"
        labelId={label}
        sub={<span id={line} aria-live="polite">{sub}</span>}
        end={<Switch on={on} disabled={!["on", "off"].includes(s.kind)} busy={s.kind === "busy"} labelledBy={label} describedBy={line} set={(v) => void (v ? n.on() : n.off())} />}
        below={n.problem && <p className="pt-2 text-[13px] text-block" role="alert">{n.problem}</p>}
      />
      {s.kind === "on" && (
        <button className="flex min-h-12 w-full items-center border-t border-rule px-5 text-left text-base text-ink active:bg-wash cards:px-3.5 cards:text-accent native:px-4 cockpit:px-4 cockpit:text-[15px] cockpit:text-link" onClick={() => void n.test(s.endpoint)}>
          Send a test notification
        </button>
      )}
    </>
  );
}

function LookChoice() {
  const look = useLook();
  const label = useId();
  return (
    <Row
      label="Look"
      labelId={label}
      below={
        <div className="mt-2.5 grid grid-cols-4 gap-[3px] rounded-full bg-wash p-[3px] cards:rounded-xl cockpit:rounded-[10px]" role="group" aria-labelledby={label}>
          {LOOKS.map((l) => (
            <button
              key={l}
              aria-pressed={look === l}
              className="min-h-9 rounded-full px-1 text-[14px] text-ink2 capitalize aria-pressed:bg-paper aria-pressed:font-semibold aria-pressed:text-ink aria-pressed:shadow-[0_1px_3px_rgb(0_0_0/0.12)] cards:rounded-[10px] cards:aria-pressed:bg-card cockpit:rounded-[7px] cockpit:font-mono cockpit:text-[13px] cockpit:normal-case"
              onClick={() => setLook(l)}
            >
              {l}
            </button>
          ))}
        </div>
      }
    />
  );
}

// The keys, on a computer, and a switch to turn them off: a letter alone
// can be pressed by mistake, or by voice control.
function Keys() {
  const keyboard = useKeyboard();
  const on = useKeys();
  const label = useId();
  if (!keyboard) return null;
  const k = (name: string) => <kbd className="rounded-[3px] border border-rule px-1 font-mono text-[11.5px] text-ink2">{name}</kbd>;
  return (
    <Row
      label="Keys"
      labelId={label}
      sub={on ? undefined : "Off: letters do nothing outside the message box."}
      end={<Switch on={on} labelledBy={label} set={setKeys} />}
      below={on && (
        <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink2 cockpit:font-mono">
          <span>{k("j")} {k("k")} move</span>
          <span>{k("⏎")} open</span>
          <span>{k("n")} next waiting</span>
          <span>{k("esc")} stop pi</span>
          <span>{k("?")} settings</span>
        </p>
      )}
    />
  );
}
