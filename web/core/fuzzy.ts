// Fuzzy matching for pickers: every word of the query must appear in the
// text, in order but not necessarily together ("son45" finds
// "claude-sonnet-4-5"). Words may match in any order relative to each other.

export interface Match {
  score: number;
  // Indexes into the text of the characters that matched, for highlighting.
  positions: number[];
}

const SEPARATORS = " /-_.:()[]";

function wordStart(text: string, i: number): boolean {
  return i === 0 || SEPARATORS.includes(text[i - 1]);
}

// One word against the text: a run of the word itself scores best, at the
// start of a word better still. Else its letters in order, where each after
// the first follows the one before or starts a word ("son45" in
// "sonnet-4-5"); letters picked from anywhere match nearly everything in a
// long list.
function matchWord(word: string, text: string): Match | undefined {
  let best: Match | undefined;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const score = 100 + word.length * 10 + (wordStart(text, at) ? 50 : 0) - at * 0.1;
    if (!best || score > best.score) best = { score, positions: Array.from(word, (_, k) => at + k) };
  }
  if (best) return best;
  for (let at = text.indexOf(word[0]); at >= 0; at = text.indexOf(word[0], at + 1)) {
    const positions = [at];
    let score = wordStart(text, at) ? 8 : 0;
    for (let i = at + 1; i < text.length && positions.length < word.length; i++) {
      if (text[i] !== word[positions.length]) continue;
      const together = positions.at(-1) === i - 1;
      if (!together && !wordStart(text, i)) continue;
      score += together ? 5 : 8 - Math.min(i - positions.at(-1)! - 1, 10);
      positions.push(i);
    }
    if (positions.length === word.length && (!best || score > best.score)) best = { score, positions };
  }
  return best;
}

// Lowercase letter by letter, keeping the text's length where a whole
// lowercase would change it ("İ"), so that positions index the text as
// given; Greek's final sigma as any other.
const lower = (text: string) => text.replace(/./gsu, (c) => {
  const l = c.toLowerCase();
  return l.length === c.length ? l : c;
}).replaceAll("ς", "σ");

// The query against the text, ignoring case; none when a word is missing.
// An empty query matches everything with no score.
export function fuzzy(query: string, text: string): Match | undefined {
  const low = lower(text);
  const seen = new Set<number>();
  let score = 0;
  for (const word of lower(query).split(/\s+/).filter(Boolean)) {
    const m = matchWord(word, low);
    if (!m) return undefined;
    score += m.score;
    for (const p of m.positions) seen.add(p);
  }
  return { score, positions: [...seen].sort((a, b) => a - b) };
}

// The items that match, best first; ties keep their order. With no query,
// every item, in order.
export function rank<T>(query: string, items: T[], text: (item: T) => string): { item: T; match: Match }[] {
  const out: { item: T; match: Match; i: number }[] = [];
  items.forEach((item, i) => {
    const match = fuzzy(query, text(item));
    if (match) out.push({ item, match, i });
  });
  return out.sort((a, b) => b.match.score - a.match.score || a.i - b.i);
}
