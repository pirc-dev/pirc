// Choosing a session's model: every model the host offers, by provider,
// and a search box that ranks them fuzzily against name, provider and ID.
// Full screen on a phone, a dialog on anything wider.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { rank } from "../../core/fuzzy.ts";
import type { ModelChoice } from "../../core/results.ts";
import type { ModelView } from "../../core/view.ts";
import { Icon } from "./icons.tsx";
import { Marked } from "./Marked.tsx";
import { useHold } from "./update.ts";

const key = (m: ModelView) => `${m.provider}/${m.id}`;

// What the search reads: the name, then provider/ID. The two lines a row
// shows are this text's two parts, so a match's positions highlight both.
const label = (m: ModelView) => m.name || m.id;
const searched = (m: ModelView) => `${label(m)} ${key(m)}`;

function tokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1000)}k`;
}

export function ModelPicker(p: {
  models: ModelChoice[] | undefined;
  current: ModelView | undefined;
  pick: (m: ModelView) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useHold(true);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // With nothing typed, by provider, each provider's in the host's order.
  const byProvider = useMemo(() => {
    const ms = p.models ?? [];
    const first = new Map<string, number>();
    ms.forEach((c, i) => first.has(c.model.provider) || first.set(c.model.provider, i));
    return ms.map((c, i) => ({ c, i })).sort((a, b) => first.get(a.c.model.provider)! - first.get(b.c.model.provider)! || a.i - b.i).map((x) => x.c);
  }, [p.models]);
  const results = useMemo(() => rank(query, byProvider, (c) => searched(c.model)), [query, byProvider]);
  const current = p.current && key(p.current);

  // Start on the current model, so that the arrows move from it.
  useEffect(() => {
    if (query) return;
    const i = results.findIndex((r) => key(r.item.model) === current);
    setActive(Math.max(i, 0));
  }, [results, current, query]);
  useEffect(() => input.current?.focus(), []);
  useLayoutEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (!query) return;
      setQuery("");
    } else if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, results.length - 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" && results[active]) p.pick(results[active].item.model);
    else return;
    // Handled here: Escape that clears the search does not also close.
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-scrim sm:items-start sm:pt-[10vh]" onClick={p.close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a model"
        className="flex h-dvh w-full flex-col bg-paper sm:h-auto sm:max-h-[75vh] sm:max-w-lg sm:rounded-[22px] sm:shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-[1fr_auto_1fr] items-center border-b border-rule pt-[env(safe-area-inset-top)] pr-5 pl-2">
          <button className="min-h-11 justify-self-start px-2 text-[15px] cards:font-medium cards:text-accent native:text-[17px] cockpit:text-link" onClick={p.close}>Cancel</button>
          <h2 className="font-read text-lg cards:font-[650] native:text-[17px] native:font-semibold cockpit:font-mono cockpit:text-base cockpit:font-bold">Model</h2>
        </div>
        <label className="mx-5 mt-1 flex h-11 flex-none items-center gap-2.5 border-b border-rule text-ink3 focus-within:border-ink focus-within:text-ink cards:mx-3 cards:mt-2.5 cards:mb-1 cards:h-[42px] cards:gap-2 cards:rounded-full cards:border cards:bg-card cards:px-4 cards:focus-within:border-accent cards:focus-within:text-ink3 cards:focus-within:ring-3 cards:focus-within:ring-accent-soft native:mx-4 native:h-[38px] native:rounded-[11px] native:border-0 native:bg-wash native:px-2.5 native:focus-within:ring-0 cockpit:mx-3.5 cockpit:mt-2.5 cockpit:mb-1 cockpit:h-10 cockpit:gap-2 cockpit:rounded-lg cockpit:border cockpit:bg-card cockpit:px-3 cockpit:focus-within:border-accent">
          <Icon name="search" />
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
            placeholder={p.models ? `Search ${p.models.length} models` : "Loading models…"}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            role="combobox"
            aria-expanded="true"
            aria-controls="model-results"
            aria-activedescendant={results[active] ? `model-${active}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink3 native:text-[17px] cockpit:font-mono cockpit:text-sm"
          />
        </label>
        <ul ref={list} id="model-results" role="listbox" className="flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {p.models && results.length === 0 && <li className="px-5 py-6 font-read text-ink2">No model matches “{query}”.</li>}
          {results.map(({ item: c, match }, i) => {
            const m = c.model;
            const positions = new Set(match.positions);
            const name = label(m);
            const provider = !query && m.provider !== results[i - 1]?.item.model.provider;
            return (
              <Fragment key={key(m)}>
                {provider && <li role="presentation" className="px-5 pt-4.5 pb-1 text-[11.5px] font-semibold tracking-[0.14em] text-ink2 uppercase cards:px-4 cards:text-[12.5px] cards:tracking-[0.06em] cards:text-ink3 native:text-[13px] native:font-normal native:tracking-[0.03em] native:text-ink2 cockpit:px-4 cockpit:font-mono cockpit:font-bold cockpit:tracking-[0.08em] cockpit:text-ink3">{m.provider}</li>}
                <li
                  id={`model-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onClick={() => p.pick(m)}
                  onMouseMove={() => i !== active && setActive(i)}
                  className={`flex min-h-[50px] cursor-pointer items-baseline gap-2.5 border-t border-rule px-5 py-2.5 cards:px-4 cockpit:px-4 ${i === active ? "bg-wash" : ""}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[15.5px] native:text-base ${key(m) === current ? "font-semibold cards:text-accent cockpit:text-accent" : ""}`}><Marked text={name} offset={0} positions={positions} /></span>
                    <span className="block truncate font-mono text-xs text-ink2">
                      <Marked text={key(m)} offset={name.length + 1} positions={positions} />
                      {(c.reasoning || c.images) && <span className="font-ui text-ink3"> · {[c.reasoning && "reasoning", c.images && "images"].filter(Boolean).join(" · ")}</span>}
                    </span>
                  </span>
                  {key(m) === current
                    ? <span className="flex-none text-xs font-semibold tracking-[0.1em] text-done uppercase">✓ current</span>
                    : c.contextWindow > 0 && <span className="flex-none text-[13px] text-ink2 tabular-nums">{tokens(c.contextWindow)}</span>}
                </li>
              </Fragment>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
