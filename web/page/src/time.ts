// The time now, kept up to date while a component shows it.
import { useEffect, useState } from "react";

// Re-renders every half minute, for times shown as "ago", or as often as
// asked.
export function useNow(every = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}
