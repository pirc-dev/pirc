// Copying text to the clipboard: a small button that says Copy, then
// Copied for a moment, or why it could not.
import { useEffect, useState } from "react";

export function CopyButton(p: { text: () => string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 1500);
    return () => clearTimeout(t);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.text());
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return (
    <button
      className={`min-h-8 flex-none px-1.5 font-ui text-[12.5px] font-medium text-ink3 hover:text-ink ${state === "failed" ? "text-block" : ""} ${p.className ?? ""}`}
      aria-label={p.label}
      onClick={() => void copy()}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy"}</span>
    </button>
  );
}
