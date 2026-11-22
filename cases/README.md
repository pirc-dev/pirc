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
- `e2e/`: the hosted account's shared pieces (`docs/e2e.md`). These files
  are what any implementation of its checks must pass; TypeScript's runs
  them in `sh/check.sh`. See "End to end" below.
- `noise/`: published Noise test vectors, copied unchanged (see "Noise"
  below).
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

## End to end

`e2e/framed.json` holds `framed` and its 8-byte number (`docs/e2e.md`,
section 2); `e2e/list.json` the device list's check (section 3), the
phone's list maker to exact bytes, and RFC 8032's test 1 for the raw
Ed25519 verify; `e2e/sealed.json` a computer's sealing of a session's
announcement and notice, to exact bytes with the nonces given, and their
opening (section 5); `e2e/names.json` opening the devices' names, and the
phone's names maker to exact bytes (section 3); `e2e/channel.json` Noise
for a channel and a join (sections 4 and 6; see "Noise" below). They are written from fixed seeds by
`e2e/test/gen.ts` alone, never by hand, and `sh/check.sh` fails if they
differ from what it writes; the runners' checks of each file's shape are
a second guard. To write them:

```sh
node --experimental-transform-types --no-warnings e2e/test/gen.ts
```

A file is `{"about", "cases": [...]}`. Bytes are hex; numbers that may
pass 2^53 are decimal strings. Each case names its `check` and the parts
it `needs` (`first-mode`, `self`, `make-list`, `seal`, `announcement`,
`notice`, `names`, `make-names`); a runner states the
parts it has, runs every case needing only those, and checks how many it
ran against the file. `expect` is the result exactly, with its reason,
counter and SHA-256 of the body, the ordering value and the opened text
where the check returns them, or `{"throws": true}` for a caller's
mistake. A seal or make case's `expect` holds the copies in the list's
order of recipients and the recipient keys skipped, and a seal case's
also, when there are copies, the text each copy opens to, for the recipients' secret keys it
gives; `go` is the relay's result
where Go's `crypto/ed25519` accepts a signature libsodium refuses. The
TypeScript runner is `e2e/test/cases.test.ts`; the relay's Go
runner, of `framed.json` and `list.json`, is
`relay/internal/hosted/list_test.go`; the app's Dart runner, of
`framed.json`, `list.json`, `sealed.json` but its sealing, and
`names.json`, is `app/test/e2e_cases_test.dart`, and
`app/integration_test/e2e_cases_test.dart` runs it on a phone or
simulator; the iOS notification extension's Swift runner, of `framed.json`,
`list.json` but the maker, and the notices' opening in `sealed.json`, is
`app/ios/PircNotices/Tests/PircNoticesTests/E2eCasesTests.swift`, run by
`sh/notices.sh`.

## Noise

`noise/` holds published test vectors for the two Noise suites PiRC uses
(`docs/e2e.md`, sections 4 and 6), as their projects publish them, one
file per project: `cacophony.json` has `Noise_IK_25519_ChaChaPoly_SHA512`
and `Noise_XXpsk3_25519_ChaChaPoly_SHA512`, with their handshake hashes;
`snow.json` has `Noise_IK_25519_ChaChaPoly_SHA512`, without one. A file is
`{"about", "source", "commit", "licence", "vectors": [...]}`, the source
a link to the file at that commit; snow's MIT licence is
`noise/snow.LICENSE`. The vectors' handshake messages carry payloads,
which PiRC's never do, so a runner gives them to the Noise core directly,
past the check of a handshake message's fixed length. Every message
alternates between the two sides, the initiator's first, the handshake's
then the transport's.

`e2e/channel.json` holds what PiRC builds on Noise. A case's `check` is
`prologue` (IK's prologue from an account ID, to its `bytes`), `IK` or
`XXpsk3`. An IK or XXpsk3 case has `parties`, each with its `role`
(`initiator` or `responder`), its X25519 `staticKey` and `ephemeralKey`
(secret keys), and, for IK, an `accountId` from which the prologue is
built as the public API builds it, or a `prologue` of the test's own; an
IK initiator also has the computer's `responderKey`, and an XXpsk3 party
its `prologue` and `psk`. Its `steps` run in order, each a call of one
party:

```
{"party", "call": "write", "bytes"}            a handshake message, to exact bytes
{"party", "call": "read", "bytes"}             a handshake message read
{"party", "call": "send", "plaintext", "bytes"}   a transport message
{"party", "call": "receive", "bytes", "plaintext"}
```

In place of the result, `"fails": <reason>` (`length`, `dh`, `decrypt` or
`dead`) or, for a send, `"throws": true`, a caller's mistake. The write or
read that ends a party's handshake has `done`: the `handshakeHash`, the
other side's `remoteStatic`, and whether it is `confirmed`: an IK
responder's is not until a message from the initiator decrypts, nor an
XXpsk3 initiator's until one from the responder does (only that shows the
responder holds the PSK), and a receive that succeeds confirms it. Only
the IK responder may not send before. After a failure or a throw, every
later call of that party is in the file, giving `dead`. A party's steps
need nothing of the other's, so an implementation of one side runs
them alone. A case `needs` `ik-responder` when it has an IK responder,
`own-prologue` when an IK party has a prologue of its own, and `xxpsk3`
for XXpsk3.

The TypeScript runner is `e2e/test/noise.test.ts`, and
`e2e/test/noise-webcrypto.test.ts` runs both files again with every
static key in Node's WebCrypto (`e2e/test/webcrypto.ts`, which a browser
can run too). The app's Dart runner, of both, every case of
`channel.json` with each party in its role (the IK responder and XXpsk3
through their test entry points), is `app/test/noise_cases_test.dart`,
and `app/integration_test/e2e_cases_test.dart` runs it on a phone or
simulator.
