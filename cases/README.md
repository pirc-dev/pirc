# Shared test cases

What every client of the relay must do with the same input, as data: the
web app's client logic (`web/core`) and the mobile app's Dart port of it
both run these files, so the two behave the same (`docs/web.md`, section 4;
`docs/design.md`, section 12, step 13). A change to the client logic
changes the cases, and every client is made to pass them again.

- `exchanges/`: recorded exchanges with the relay. Frames in, and the
  frames sent, view events, replies and state that must follow.
- `functions/`: the client logic's pure functions, arguments in, result
  out.
- `notices/`: notifications, in the same form as `functions/`: which
  sessions have a notice not yet shown, and the title and body written
  from it (`web/core/notices.ts`). The iOS notification extension's Swift
  passes these too.

The TypeScript runners are in `web/test` (`exchange.ts` and
`exchanges.test.ts`; `functions.ts` and `functions.test.ts`, for both
`functions/` and `notices/`), run by
`sh/check.sh`; the mobile app's Dart runner is `app/test/cases_test.dart`,
run by `sh/app.sh`. `web/test/record.ts` writes a file's expected parts from its
inputs, by running the TypeScript; read what it wrote before keeping it,
since it records what the code does, right or wrong:

```sh
node --experimental-transform-types --no-warnings web/test/record.ts cases/exchanges/x.json
```

## Exchanges

A file is `{"about": "...", "steps": [...]}`, each step one of:

```
{"state": "ready"}            the relay connection's state changes
{"seed": {"sessionId", "chat"}}   a chat kept from before (Client.seed)
{"in": <frame>}               a frame arrives from the relay
{"wait": 3000}                that many milliseconds pass
{"ask": {"id", "body"}, "as": "p"}   a request to a session
{"sent": [<frame>...]}        the frames sent since the last "sent"
{"events": [<event>...]}      the view events since the last "events"
{"reply": {"as": "p", "is": <message>}}   a request's answer
{"snapshot": <snapshot>}      the session list as it is now
{"chat": {"id", "is": <chat>}}   a chat as it is now
```

The inputs are "state", "seed", "in", "wait" and "ask"; the rest are checks. After
the last step, no frame may have been sent and no event raised that a
check did not see.

- Frames are Protocol Buffers' JSON form (64-bit integers as strings),
  except that a Routed frame's payload is given decoded, as "message" (a
  SessionMessage), and a session entry's as "announcement" (a
  SessionAnnouncement).
- An "ask" body is a SessionMessage in JSON; its "id" is the session's.
- Request IDs are "id-1", "id-2"... in the order the client makes them.
- Time starts at 0 and moves only by "wait"; a timer due within a wait
  fires in order of when it is due.
- Events, snapshots and chats are the view's JSON (`web/core/view.ts`),
  with absent fields left out.

## Functions

A file is `{"about": "...", "cases": [{"fn", "about", "args", "is"}]}`:
calling `fn` with `args` gives `is`. A result that is absent (undefined)
is `null`, and absent fields are left out. The functions:

| fn | args | from |
|---|---|---|
| `applyToChat` | a chat, a view event | `view.ts` |
| `lastOf` | a chat's items | `view.ts` |
| `folder` | a path | `names.ts` |
| `title` | a session | `names.ts` |
| `windowOf` | a session | `names.ts` |
| `details` | a session | `names.ts` |
| `where` | a session | `names.ts` |
| `ago` | a time, now; a date past a day as `"weekday <at>"` or `"date <at>"` | `names.ts` |
| `fuzzy` | a query, a text | `fuzzy.ts` |
| `rank` | a query, a list of texts; each item is its own text | `fuzzy.ts` |
| `imageKey` | a media type, the bytes in base64 | `images.ts` |
| `outcome` | a SessionMessage in JSON | `results.ts` |
| `starts` | lists of sessions, given in turn to one `Starts`; each update's result | `order.ts` |
| `order` | working sessions' starts, sessions; their IDs in the list's order | `order.ts` |
| `nextWaiting` | sessions, the IDs with news, starts, the ID open or `null`; an ID | `order.ts` |
| `userIds` | a chat's items | `pending.ts` |
| `settle` | pending messages, a chat's items; the keys of those left | `pending.ts` |
| `answered` | a pending message, ok, an error or `null`, unsure | `pending.ts` |
| `quiet` | a chat's items | `pending.ts` |
| `runs` | a chat's items; each part as `{"item": id}` or `{"tools": [ids]}` | `chat.ts` |
| `signature` | an item or `null` | `chat.ts` |
| `took` | milliseconds | `chat.ts` |
| `diffLines` | a unified diff | `chat.ts` |

| `cut` | a text, a length in code points | `notices.ts` |
| `notification` | a session; its notice's title and body, or `null` | `notices.ts` |
| `news` | the numbers shown by session ID, sessions, since or `null`; `{"notify": [ids], "shown"}` | `notices.ts` |

`order` and `nextWaiting` order by `compare` with `title` (`names.ts`). A
pending message's `before`, a set, is a list of IDs.

Positions in a text, and lengths cut to, count UTF-16 code units, as both
JavaScript's and Dart's strings do. Sessions equal in time and window are
ordered by title in the platform's collation (`localeCompare`), which may
differ between languages; no case depends on it.
