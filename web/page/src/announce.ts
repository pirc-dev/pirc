// What a screen reader is told without its focus moving: two regions kept
// in the page from the start (one added later is not always heard), out of
// sight. One is polite, and waits for what is being read; the other
// interrupts, for what went wrong. Left out when something over the page
// makes the rest of it inert (modal.ts).
const region = (urgent: boolean): HTMLElement => {
  const el = document.createElement("div");
  el.setAttribute("aria-live", urgent ? "assertive" : "polite");
  el.setAttribute("aria-atomic", "true");
  if (urgent) el.setAttribute("role", "alert");
  el.dataset.announce = "";
  el.className = "sr-only";
  document.body.append(el);
  return el;
};

let regions: { polite: HTMLElement; urgent: HTMLElement } | undefined;

// Said once: the same words again are said again, since a region is heard
// only when its text changes.
export function announce(text: string, urgent = false): void {
  if (!text.trim()) return;
  regions ??= { polite: region(false), urgent: region(true) };
  const el = urgent ? regions.urgent : regions.polite;
  el.textContent = el.textContent === text ? `${text} ` : text;
}

// Made early, before anything is to be said.
export function announcer(): void {
  regions ??= { polite: region(false), urgent: region(true) };
}
