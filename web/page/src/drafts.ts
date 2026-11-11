// What is being written in each chat, in this browser only, so that it
// survives leaving the chat or reloading the page (docs/web.md, section
// 6). Each device keeps its own, as it keeps what it has read (seen.ts).
const KEY = "pirc.drafts";
// Kept for the chats written in most recently, and for a week.
const KEEP = 100;
const MAX_AGE_MS = 7 * 24 * 3600_000;

type Drafts = Record<string, { text: string; at: number }>;

function load(): Drafts {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Drafts;
  } catch {
    return {};
  }
}

export function loadDraft(id: string, now = Date.now()): string {
  const d = load()[id];
  return d && now - d.at < MAX_AGE_MS ? d.text : "";
}

// An empty text clears the chat's draft.
export function saveDraft(id: string, text: string, now = Date.now()): void {
  const drafts = load();
  if (text.trim()) drafts[id] = { text, at: now };
  else if (id in drafts) delete drafts[id];
  else return;
  const kept = Object.entries(drafts).filter(([, d]) => now - d.at < MAX_AGE_MS).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Not kept: the draft lasts while the chat is open.
  }
}
