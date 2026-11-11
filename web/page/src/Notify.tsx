// Notifications on this device (docs/web.md, section 6): turned on in
// Settings, which asks the browser's permission and subscribes it with the
// server's key, then sends a test; turned off there. A subscription the
// browser already has is given to the server again as the list loads, so
// that the two agree.
import { useEffect, useRef, useState } from "react";
import { api } from "./live.ts";
import { useHold } from "./update.ts";

type State =
  | { kind: "checking" }
  | { kind: "unsupported"; why: string }
  | { kind: "blocked" }
  | { kind: "off" }
  | { kind: "on"; endpoint: string }
  | { kind: "busy"; was: "on" | "off" };

const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Opened from the Home Screen, as an app.
const installed = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

function supported(): string | undefined {
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return undefined;
  if (ios()) return installed() ? "Needs iOS 16.4 or later." : "Needs PiRC on the Home Screen: Share, then Add to Home Screen, and open it from there.";
  return "This browser cannot show notifications.";
}

// Where a site's notifications are allowed again.
export const unblock = () => (ios() ? "Blocked: allow them in the iPhone's Settings, under Notifications, then PiRC." : "Blocked: allow notifications for this site in the browser's settings.");

// The service worker, or an error if it has not started by now: one that
// failed to register would otherwise leave the screen waiting for ever.
async function ready(): Promise<ServiceWorkerRegistration> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("The app's service worker has not started: reload the page to try again.")), 10_000))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function bytes(b64url: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await ready();
  return reg.pushManager.getSubscription();
}

async function turnOn(): Promise<string> {
  if ((await Notification.requestPermission()) !== "granted") throw new Error("blocked");
  const reg = await ready();
  const { publicKey } = await api.call<{ publicKey: string }>("/api/push");
  const key = bytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // One made with another key of the server's cannot be reused.
  const old = sub?.options.applicationServerKey;
  if (sub && (!old || new Uint8Array(old).join() !== key.join())) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api.call("/api/push/subscribe", { subscription: sub.toJSON() });
  const test = await api.call<{ ok: boolean; message?: string }>("/api/push/test", { endpoint: sub.endpoint });
  if (!test.ok) throw new Error(`Subscribed, but the test notification failed: ${test.message}`);
  return sub.endpoint;
}

// Gives the server the subscription this browser has, if any (the list
// calls it as it loads).
export async function resubscribe(): Promise<void> {
  if (supported() || Notification.permission !== "granted") return;
  const sub = await subscription().catch(() => null);
  if (sub) await api.call("/api/push/subscribe", { subscription: sub.toJSON() }).catch(() => {});
}

// The device's notifications, for Settings to draw: their state, a
// problem met turning them on or off or testing, and those three actions.
export function useNotify() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [problem, setProblem] = useState<string | undefined>();

  // Looked at again whenever the page comes back into view, since
  // permission is given or taken away in the browser's or phone's settings.
  // Not while turning on or off, which says how it went itself; an answer
  // to an older look, or one that comes back during a turn, is dropped.
  const busy = useRef(false);
  busy.current = state.kind === "busy";
  const looks = useRef(0);
  useEffect(() => {
    let current = true;
    const look = () => {
      if (busy.current) return;
      const n = ++looks.current;
      const fresh = () => current && n === looks.current && !busy.current;
      const why = supported();
      if (why) return setState({ kind: "unsupported", why });
      if (Notification.permission === "denied") return setState({ kind: "blocked" });
      subscription().then((sub) => {
        if (!fresh()) return;
        setState(!sub || Notification.permission !== "granted" ? { kind: "off" } : { kind: "on", endpoint: sub.endpoint });
        setProblem(undefined);
      }, (e: Error) => {
        if (!fresh()) return;
        setState({ kind: "off" });
        setProblem(e.message);
      });
    };
    look();
    const seen = () => document.visibilityState === "visible" && look();
    document.addEventListener("visibilitychange", seen);
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", seen);
    };
  }, []);
  // A new version does not reload the page while the browser asks.
  useHold(state.kind === "busy");

  const on = async () => {
    looks.current++;
    setProblem(undefined);
    setState({ kind: "busy", was: "off" });
    try {
      setState({ kind: "on", endpoint: await turnOn() });
    } catch (e) {
      if ((e as Error).message === "blocked") return setState({ kind: Notification.permission === "denied" ? "blocked" : "off" });
      const sub = await subscription().catch(() => null);
      setState(sub ? { kind: "on", endpoint: sub.endpoint } : { kind: "off" });
      setProblem((e as Error).message);
    }
  };

  const off = async () => {
    looks.current++;
    setProblem(undefined);
    setState({ kind: "busy", was: "on" });
    try {
      const sub = await subscription();
      if (sub) {
        await api.call("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe();
      }
      setState({ kind: "off" });
    } catch (e) {
      setState({ kind: "off" });
      setProblem((e as Error).message);
    }
  };

  const test = async (endpoint: string) => {
    setProblem(undefined);
    try {
      const r = await api.call<{ ok: boolean; message?: string }>("/api/push/test", { endpoint });
      if (!r.ok) setProblem(r.message);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };

  return { state, problem, on, off, test };
}
