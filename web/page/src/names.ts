// What a session is called on screen, and where it runs (core/names.ts),
// with dates in the browser's language.
import { ago as agoIn } from "../../core/names.ts";

export { details, folder, title, where, windowOf } from "../../core/names.ts";

const day = (at: number, weekday: boolean) =>
  new Date(at).toLocaleDateString(undefined, weekday ? { weekday: "short" } : { day: "numeric", month: "short" });

// How long ago, shortly: "now", "5m", "3h", "Mon", "12 Oct".
export const ago = (at: number, now: number) => agoIn(at, now, day);
