// Signing in with a passkey, and making one from a pairing link
// (docs/web.md, section 2). The link's token is after "#", which the
// browser never sends; the page sends it once, to start the passkey.
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useState } from "react";

import { api, live } from "./live.ts";
import { useLook } from "./look.ts";
import { useHold } from "./update.ts";

// Like the first page of a book: the mark, a title, a sentence, and the
// one action low enough for a thumb, with what went wrong just above it.
function Screen(p: { title: string; lead?: React.ReactNode; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col bg-paper px-8 pt-[max(7rem,env(safe-area-inset-top))] pb-[max(4rem,calc(env(safe-area-inset-bottom)+2rem))] native:px-7 native:pt-[max(3rem,env(safe-area-inset-top))]">
      <div className="flex flex-1 flex-col gap-5 native:items-center native:justify-center native:gap-3.5 native:text-center">
        <Mark />
        <h1 className="mt-6 font-read text-[40px] leading-[1.1] tracking-[-0.015em] text-balance cards:text-[34px] cards:font-[650] cards:tracking-[-0.035em] native:mt-2 native:text-[30px] native:font-bold native:tracking-[-0.01em] cockpit:mt-4 cockpit:font-mono cockpit:text-[30px] cockpit:font-bold cockpit:tracking-[-0.02em]">{p.title}</h1>
        {p.lead && <p className="max-w-[28ch] font-read text-lg leading-[1.55] text-ink2 cards:text-[16.5px] native:max-w-[30ch] native:text-base cockpit:text-base">{p.lead}</p>}
      </div>
      <div className="mx-auto flex w-full max-w-sm flex-col gap-3.5">
        {p.error && <p className="flex gap-2 text-[14.5px] leading-snug text-block cards:rounded-[10px] cards:bg-block-wash cards:px-3 cards:py-2.5 native:rounded-xl cockpit:font-mono cockpit:text-[13px]" role="alert"><span className="font-mono font-semibold">×</span>{p.error}</p>}
        {p.children}
      </div>
    </div>
  );
}

// π and the name in small capitals; in Triage, the four statuses as tiles;
// in Native, the app's icon; in Cockpit, the name as a prompt.
export function Mark() {
  const look = useLook();
  if (look === "native") return <img src="/icon-192.png" alt="PiRC" className="size-[92px] rounded-[22px] shadow-[0_10px_30px_rgb(0_0_0/0.18)]" />;
  if (look === "cockpit") {
    return <div className="font-mono text-[44px] leading-none font-bold tracking-[-0.03em]" aria-label="PiRC" role="img">pirc<span className="text-accent">_</span></div>;
  }
  if (look === "triage") {
    const tile = "grid size-[26px] place-items-center rounded-md font-mono text-sm font-semibold";
    return (
      <div className="grid w-max grid-cols-2 gap-1" aria-label="PiRC" role="img">
        <span className={`${tile} bg-block-wash text-block`}>×</span>
        <span className={`${tile} bg-done-wash text-done`}>✓</span>
        <span className={`${tile} bg-work-wash text-work`}>◐</span>
        <span className={`${tile} text-idle ring-1 ring-rule ring-inset`}>○</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2.5 font-read text-[15px] tracking-[0.14em] text-ink2 uppercase">
      <span className="text-[30px] leading-none tracking-normal text-ink normal-case italic">π</span>PiRC
    </div>
  );
}

const button = "flex h-13 w-full items-center justify-center rounded-full bg-ink text-base font-semibold text-paper disabled:bg-wash2 disabled:text-ink3 cards:rounded-[14px] cards:bg-accent cards:text-on-accent cards:disabled:opacity-40 native:text-[17px] cockpit:rounded-[10px] cockpit:bg-accent cockpit:text-on-accent";

function message(e: unknown): string {
  const err = e as Error;
  // The person closed the passkey prompt.
  if (err.name === "NotAllowedError") return "No passkey was used.";
  return err.message || "Something went wrong.";
}

export function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useHold(busy);
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const optionsJSON = await api.call<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/login/options", {});
      const response = await startAuthentication({ optionsJSON });
      await api.call("/api/login/verify", { response });
      await live.signedIn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title="Your pi sessions, wherever you are." error={error}>
      <button className={button} disabled={busy} onClick={go}>Sign in with a passkey</button>
    </Screen>
  );
}

export function Pair(p: { done: () => void }) {
  const [token] = useState(() => location.hash.slice(1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useHold(busy);
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const optionsJSON = await api.call<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/pair/options", { token });
      const response = await startRegistration({ optionsJSON });
      await api.call("/api/pair/verify", { response });
      // The link is used up: keep it out of the history.
      history.replaceState(null, "", "/");
      await live.signedIn();
      p.done();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const lead = "Make a passkey for PiRC in this browser. You will sign in with it from now on.";
  const missing = "This link has no token. Open the whole link again, or make a new one with pirc-web pair.";
  return (
    <Screen title="Add this browser" lead={lead} error={token ? error : missing}>
      <button className={button} disabled={busy || !token} onClick={go}>Make a passkey</button>
    </Screen>
  );
}
