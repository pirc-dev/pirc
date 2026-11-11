// The client logic's functions, called by the name a case in
// cases/functions/ gives them, with its arguments (cases/README.md).
import { fromJson, type JsonObject, type JsonValue } from "@bufbuild/protobuf";

import { SessionMessageSchema } from "@pirc/protocol";

import { diffLines, type Part, runs, signature, took } from "../core/chat.ts";
import { fuzzy, rank } from "../core/fuzzy.ts";
import { imageKey } from "../core/images.ts";
import { ago, details, folder, title, where, windowOf } from "../core/names.ts";
import { compare, nextWaiting, Starts } from "../core/order.ts";
import { answered, type Pending, quiet, settle, userIds } from "../core/pending.ts";
import { cut, news, notification } from "../core/notices.ts";
import { outcome } from "../core/results.ts";
import { applyToChat, type ChatItem, type ChatView, lastOf, type SessionView, type ViewEvent } from "../core/view.ts";

type Args = JsonValue[];

const sessions = (v: JsonValue) => v as unknown as SessionView[];
const items = (v: JsonValue) => v as unknown as ChatItem[];
const starts = (v: JsonValue) => new Map(Object.entries(v as Record<string, number>));
const order = (v: JsonValue) => compare(starts(v), title);
// A pending message with the user messages it was sent after as a list.
const pending = (v: JsonValue): Pending => {
  const p = v as unknown as Pending & { before: string[] };
  return { ...p, before: new Set(p.before) };
};
const pendingOut = (p: Pending | undefined) => p && { ...p, before: [...p.before] };
// A part of a run by its item's ID, or its folded tools' IDs.
const part = (x: Part) => ("tools" in x ? { tools: x.tools.map((t) => t.id) } : { item: x.item.id });

const functions: Record<string, (a: Args) => unknown> = {
  applyToChat: ([chat, e]) => applyToChat(chat as unknown as ChatView, e as unknown as ViewEvent),
  lastOf: ([items]) => lastOf(items as unknown as ChatItem[]),
  folder: ([cwd]) => folder(cwd as string),
  title: ([s]) => title(s as unknown as SessionView),
  windowOf: ([s]) => windowOf(s as unknown as SessionView),
  details: ([s]) => details(s as unknown as SessionView),
  where: ([s]) => where(s as unknown as SessionView),
  // A date past a day as "weekday <at>" or "date <at>".
  ago: ([at, now]) => ago(at as number, now as number, (t, weekday) => `${weekday ? "weekday" : "date"} ${t}`),
  fuzzy: ([query, text]) => fuzzy(query as string, text as string),
  rank: ([query, texts]) => rank(query as string, texts as string[], (t) => t).map(({ item, match }) => ({ item, match })),
  imageKey: ([mimeType, data]) => imageKey(mimeType as string, Buffer.from(data as string, "base64")),
  outcome: ([m]) => outcome(fromJson(SessionMessageSchema, m as JsonObject)),
  // Each list given to one Starts in turn, and what each update returned.
  starts: ([lists]) => {
    const s = new Starts();
    return (lists as JsonValue[]).map((l) => Object.fromEntries(s.update(sessions(l))));
  },
  // The sessions' IDs in the list's order, given the working ones' starts.
  order: ([st, list]) => sessions(list).slice().sort(order(st)).map((s) => s.id),
  nextWaiting: ([list, news, st, open]) =>
    nextWaiting(sessions(list), new Set(news as string[]), order(st), (open as string | null) ?? undefined)?.id,
  userIds: ([list]) => [...userIds(items(list))],
  // The keys of the pending messages left.
  settle: ([ps, list]) => settle((ps as JsonValue[]).map(pending), items(list)).map((p) => p.key),
  answered: ([p, ok, error, unsure]) =>
    pendingOut(answered(pending(p), ok as boolean, (error as string | null) ?? undefined, unsure as boolean)),
  quiet: ([list]) => quiet(items(list)),
  runs: ([list]) => runs(items(list)).map((r) => r.map(part)),
  signature: ([it]) => signature((it ?? undefined) as unknown as ChatItem | undefined),
  took: ([ms]) => took(ms as number),
  diffLines: ([diff]) => diffLines(diff as string),
  cut: ([text, n]) => cut(text as string, n as number),
  notification: ([s]) => notification(s as unknown as SessionView),
  // The IDs of the sessions to notify, and the numbers shown.
  news: ([shown, list, since]) => {
    const r = news(shown as Record<string, number>, sessions(list), (since as number | null) ?? undefined);
    return { notify: r.notify.map((s) => s.id), shown: r.shown };
  },
};

// A result in the cases' form: JSON, undefined fields dropped, undefined
// itself null.
export function call(fn: string, args: Args): JsonValue {
  const f = functions[fn];
  if (!f) throw new Error(`no function named ${fn}`);
  const r = f(args);
  return r === undefined ? null : (JSON.parse(JSON.stringify(r)) as JsonValue);
}
