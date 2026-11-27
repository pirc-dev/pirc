// What the window is, by a media query, followed as it changes.
import { useEffect, useState } from "react";

// A phone on its side: too little height for the chat's header in full, or
// a message box that grows far.
export const SHORT = "(orientation: landscape) and (max-height: 499px)";

export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const change = () => setOn(m.matches);
    change();
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, [query]);
  return on;
}
