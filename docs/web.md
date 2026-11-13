# PiRC's web app

PiRC's first own client: a web app for a phone or a laptop, decided
2026-10-25 (design section 12, step 12), and built since. This document
records what was decided and why, and is its specification; installing it
is in `docs/self-hosting.md`.

## 1. Shape

Two parts in `web/`, released with the relay (`pirc-web-X.Y.Z.tar.gz`) or
built from any commit with `sh/build.sh web`, and deployed on their own; a
deployment can follow the repository's main branch (docs/design.md,
section 12, step 9):

- **The server**, a backend for the browser (BFF): a Node service that holds
  one connection to the relay as an ordinary client, with its own key. It
  serves the page, signs browsers in, keeps the live state of every host
  and session, and passes commands on.
- **The page**: the browser app, built into static files the server serves.
  It talks only to the server, never to the relay.

Reasons: an always-running server can send notifications while no browser is
open (section 6), one subscription serves every tab, the browser holds no
relay key and no protocol code, and the relay stays free of browser
concerns (origins, static files).

**For self-hosting only.** The server reads every payload in plaintext, as
the relay could in the first version (design section 5.1). With end-to-end
encryption, which arrives with the hosted relay, the server would be an end
and see everything, so a hosted relay gets a client designed for that
instead.

**Licence**: AGPL-3.0 (`web/LICENSE`), the copyright Justino Ltd's, since
2026-11-07.

## 2. Access

Whoever is signed in has full access: every host and session, which in
practice is a shell on every host (design section 6). One relay is one
account, so there are no users or permissions; they come with the hosted
relay. The server manages the relay's devices through its own relay
connection: approving or rejecting hosts that ask to join (since
2026-10-29), listing hosts and clients, renaming and removing them, and
issuing tokens for new ones (since 2026-10-31, design section 5.3). A
token passes through the server to the page and is kept by neither; the
server's log names only its role and label. It will not remove its own
key, which every browser shares.

**Signing in is a passkey**, asked for again after 30 minutes idle.

- **Adding a passkey**: on the server's machine, `pirc-web pair` prints a
  one-time link, valid for 10 minutes, with its token after `#` so that no
  server log holds it. Opening it creates a passkey on that device (Face ID,
  Touch ID, a fingerprint or the device's PIN) and the server stores its
  public key. A passkey that syncs (iCloud Keychain, Google Password
  Manager) works on the person's other devices with no new link.
- **Each sign-in**: the browser signs the server's challenge with the
  passkey; the server checks it and sets a session cookie.
- **The session cookie** is a random 256-bit secret, `__Host-` prefixed,
  `HttpOnly`, `Secure`, `SameSite=Strict`; the server keeps only its hash.
  It ends 30 minutes after the person last did something: a command, or
  using the page, which says so at most once a minute. The page loading a
  snapshot or following the event stream by itself does not count, so a
  page left open asks for the passkey again. Sessions are kept in memory:
  restarting the server (after a certificate renewal, say) signs everyone
  out.
- **Every request** must name the app's host (else 421) and must not come
  from another site (`Sec-Fetch-Site`, else 403), except opening the page
  itself (a `GET` outside `/api` that the browser marks as navigating to a
  document): a link elsewhere, a bookmark page or a notification must be
  able to open the app, and the page does nothing until it asks the API,
  which is same-origin. A `POST` must carry the
  app's own `Origin` (else 403), which browsers send. Everything under
  `/api` but signing in needs a live session (else 401). Without one the
  server serves only the page, which shows the sign-in. These checks stop a
  website open in the same browser, or a name made to point at the server
  (DNS rebinding), from driving sessions through it.
- **The event stream** checks the sign-in before every batch of events and
  at its 15-second heartbeat, so a lapsed or revoked sign-in stops it at
  once, however busy the session.
- `pirc-web list` shows the passkeys and `pirc-web revoke` deletes one,
  ending its sessions. Removing the server's key on the relay cuts off
  every browser at once.
- **Limits**: request bodies of 64 KiB while signing in and 1 MiB after,
  but for a prompt, which may carry its images (about 12 MiB); 20
  pairing or sign-in attempts a minute per address; HSTS on HTTPS.

Passkeys are tied to the app's host name, so it should be a name that can
follow the server if it moves: moving to another name means making every
passkey again.

Reasons: a passkey needs nothing remembered, cannot be phished or guessed,
and the server keeps only public keys of them. The server's data directory
does hold its own relay key (`client.key`), which is the account's access:
back it up as a secret. Rejected: a
password (phishable, weaker), a link alone with no passkey (whoever holds
the device is in), the network as the only gate (every machine on it is
in), client certificates (fiddly to install on iOS) and a separate sign-on
service (a whole service for one person).

**HTTPS is required** for passkeys, installing the app and notifications;
serving it only on a private network is recommended. A self-signed or
private-CA certificate must be trusted by every device, so a certificate
from a public CA for a name on the private network is the easier route.

## 3. Browser and server

Decided 2026-10-25, after a survey of comparable apps (chat front ends,
agent and coding-agent remote UIs, terminal and notebook UIs):

- **Commands** are HTTP requests: `POST` for a prompt, stop and the
  actions; each answers `{ok, result}` or `{ok, code, message}`, with
  `id`, the event stream's position when the answer came. For a change
  (model, thinking level, rename) the session broadcasts its new state
  before answering, so the position is past the effect; a prompt is
  answered as it is taken, before its messages arrive. The commands, their
  bodies and their results are listed once, in `web/core/api.ts`, which
  the server's routes and the page's calls are both built from; a reply of
  another kind than the command's is answered `PI_FAILED`. (2026-10-28)
- **A request ID from the page** (2026-10-28): the page makes one for each
  message it sends (a UUID) and sends it again with a Retry, and the
  server passes it on as the request's ID, making one itself only when
  the page gives none. A retry of a prompt pi already has is then not run
  again (design.md, section 7), and a retry still in flight waits for the
  same answer. pi's copy of the message carries the ID, so the page
  matches it to what it sent by ID, and by text only for a copy without
  one (a prompt template pi expanded).
- **Updates** are one Server-Sent Events stream per page: every event has
  a sequence ID, and a heartbeat comment goes every 15 seconds.
- **Catching up**: after a drop the browser reconnects with
  `Last-Event-ID`, and the server replays from a buffer of recent events;
  past the buffer, the page reloads the current state with a snapshot
  request. The page reopens the stream when it becomes visible again
  (`visibilitychange`, `pageshow`), since mobile browsers drop connections
  in the background, sometimes without telling the page.
- **Ordering**: the page applies a command's result once the stream has
  reached its `id`.
- What the server sends is shaped for the screen ("session X is working",
  "append this text to message M"), not raw PiRC frames.
- Messages are defined once, in TypeScript shared by the server and the
  page.
- Served over HTTP/2: browsers allow only 6 streams per name over HTTP/1.1.
  A proxy in front must not buffer the stream. The stream is written by
  hand: Hono's own helper sets a header HTTP/2 forbids, which killed the
  server; the end-to-end test runs over TLS and HTTP/2 for that reason.
- **Bounds**: the server keeps the last 5000 events, or 16 MiB, for pages
  catching up; a page that stops reading (a phone gone off the network
  without closing) has its stream ended after 2000 unread events, and
  catches up when back. A chat keeps its latest 1000 items, on the server
  and the page alike. A compaction's command waits at most 15 minutes.
- **New versions** (decided 2026-10-27): a page left open keeps running
  the version it loaded, and nothing reloads a page already open, so a
  deploy reached nobody who kept the app open. The page now asks for its
  own HTML (`/`, never cached) when shown again, when its stream opens, and
  every 15 minutes on screen, at most once a minute; when the built files
  it names differ from its own, it reloads. It waits while anything would
  be lost: a draft, a message not yet settled (a refused one until it is
  dismissed), a chat scrolled up, a search, an open sheet or model picker,
  a sign-in under way; it looks again every 5 seconds. It reloads at most once for
  a given version, so a page still served the old one does not loop.

Reasons: on a phone that sleeps, a command sent as a request fails at once
and can be retried, where one sent into a half-dead WebSocket waits for a
timeout; and the stream needs no library and every command can be tried
with `curl`. Opencode's server, the nearest comparable, has the same split.
Rejected: one WebSocket with JSON (keeps a command and its updates in one
order, but needs reply matching, heartbeats and a send queue of its own),
WebSocket with protobuf (no gain for one person's small messages, and
unreadable in a browser's tools). A WebSocket would be right for fast
traffic both ways, such as a terminal in the browser.

## 4. Client logic

The code that keeps the host and session list current, loads a session's
history and merges live events into it (asking again after a gap), and
matches replies to requests lives in its own folder, `web/core`, with no
code that only Node can run. So do the rules every client's screens
follow: the list's order and the next session waiting (`order.ts`), a
sent message shown until pi's copy of it appears (`pending.ts`), and how
the chat groups tool calls (`chat.ts`), and what a session is called
and where it runs (`names.ts`, dates written in the client's language),
and which notices to show and what their notifications say
(`notices.ts`, from the notice the host puts in each announcement);
the page keeps only what touches
React or the browser. All of it is tested by shared cases kept as data
in `cases/` at the repository's root: recorded exchanges (relay frames in,
the expected state of sessions and history out) and its pure functions'
results. `cases/README.md` describes them.

Reason: the mobile app talks to the relay itself (design section 12, step
13). It is Flutter (decided 2026-11-01), so its Dart version is written
to pass the same cases, and they behave the same. They are at the root,
not in `web/`, since they belong to neither client.

## 5. Stack

- **Server**: Hono on Node 22 or later, bundled with esbuild into one
  file, as the extension is; `relay-client` for the relay.
- **Page**: React, TypeScript, Vite and Tailwind, with our own components,
  using Radix's unstyled parts only where accessibility is hard to get right
  (menus, dialogs).
- **Four looks, chosen in the app: "Quiet" (the default), "Triage",
  "Native" and "Cockpit"** (Quiet and Triage 2026-10-26, Native and
  Cockpit 2026-10-27). All four came from four directions drawn on
  2026-10-26. Quiet is
  type and hairlines, colour kept for status: the agent's replies in
  Literata, a serif drawn for long reading on screens; the interface in
  Atkinson Hyperlegible Next; code, paths and tool calls in JetBrains Mono.
  Triage is cards and soft status tiles on a grey page, one blue accent
  for what can be done, set in Geist and Geist Mono. Each was live alone
  for a while; the owner liked both. Triage's inbox of cards on top
  ("Waiting for you") did not prove useful and is gone: both looks list
  sessions by host and group. Native makes the app feel shipped with the
  phone: the system's grouped grey with white cards, a round tinted badge
  for each status where a messaging app puts a face, its blue, and the
  system's own font (San Francisco on Apple's, Roboto on Android), so it
  downloads none. Cockpit is the pane beside tmux: Catppuccin (Latte in
  light, Mocha in dark), IBM Plex Sans for prose and JetBrains Mono for
  anything one would type in a terminal (names, places, times, tools),
  counts as status symbols ("✓3 ◐4 · 19"), tool calls and code in bordered
  boxes.
- **One page in every look.** The screens and their behaviour are
  shared; a look is only how they are dressed, never what the list or a
  chat contain. `look.ts` puts `data-look` on the root element before the
  first render, with `data-shape` for the shape it builds on: Native
  dresses Triage's cards ("cards"), Cockpit Quiet's page ("page").
  `index.css` holds every palette, light and dark by the system's
  setting, under one set of names given to Tailwind as colours and fonts
  (each look's own names mapped onto Quiet's). Classes prefixed `cards:`,
  a Tailwind variant, apply to both card looks; `triage:`, `native:` and
  `cockpit:` to one look, after `cards:`. A component differs by look
  only where its markup must: the mark on the sign-in screens, and
  Native's round send arrow.
  Reason: two separate sets of components would build every feature and
  fix twice, and the two designs, built side by side for one day, had
  already each missed fixes the other had. The price: each change to the
  page is dressed and looked at in both.
- **How far Triage is dressed.** Every screen wears it: the list's rows
  and groups on cards, status tiles, the chat's blue bubbles and tool
  cards, the sheets' rows on cards, the model picker, sign-in with the
  four statuses as its mark, the connection line and a table full screen.
  Where the two designs differed in layout rather than dress, one layout
  serves both: the chat's header keeps Quiet's two lines, and the model
  picker stays full screen on a phone rather than a tall sheet. Left out:
  the glyph beside each sheet row. Reason: a second layout per screen is
  where two looks would start to drift into two apps.
- **Native and Cockpit, reconciled with their mock-ups** (2026-10-27), as
  Triage was, on the same rule: one layout and one behaviour for every
  look. Every screen wears each, including what the mock-ups did not
  draw (forking from a message, Clone, the window headings). Taken: the
  palettes, fonts and shapes above; Native's badges, pills for a group's
  counts, filled search field, inset cards, white chat with grey tool
  cards and round arrow to send when idle, and the app's icon as the
  mark on sign-in; Cockpit's symbol counts, mono names, groups
  set one step in under their host, bordered tool and code boxes, labels in the accent for
  a reply's headings, and "pirc_" as the mark. Not taken, because each
  changes what the app shows or does rather than how: Native's filter
  (All, Needs you, Working) and its back button's count of finished
  sessions; Cockpit's summary of every session in each chat's header,
  its tmux-like status line, and a cost meter in the notice. Not taken
  because they are a second layout: Native's thinking level as a
  pull-down, Rename as an alert and New session as an action sheet, and
  the coloured icon beside each sheet row; Cockpit's three equal composer buttons (the composer is the
  shared one, with Queue/Steer and Stop apart). Not possible yet: a
  thinking block's time (pi does not send it), and previews of the latest
  message, which the list no longer shows. A tool's time and syntax
  colours in code came later (2026-10-30, section 6), and so did, from
  the roadmap, Cockpit's keys and Native's folding title, both below.
- **The choice is kept in the browser**, per device, as which hosts are
  open is; it is set in Settings (below).
  Quiet is the default, as the look that was live.
- **The session's actions are a sheet** from the bottom: model, thinking
  level as one row of seven ("min" and "med" shortened, so that it fits a
  phone), cost and context (what it has cost and how full the context is,
  shown in the row as the sheet opens; the row gives the details),
  compact, rename and new session, the last two asked in the sheet itself
  rather than in the browser's dialogs. Sheets, the model picker and a
  table full screen are each a step in the history, so going back closes
  the top one.
- **Context and cost in the chat's header** (`42% · $0.31`, 2026-10-30),
  at the end of the title's line, which gives way to it. The page asks pi
  for them when the chat opens, after each reply and when the model
  changes. Reason: how full the context is decides when to
  compact or start afresh, and was three taps away. The sheet's row still
  gives the details.
- **Cost and context in the session list** (2026-11-13), as dingger
  shows them: each row has what the session has cost (`$1.84`, its whole
  total, as pi's footer) and a small meter of its context, grey, in the
  working colour above 70% and the asking colour above 90%, as in pi,
  before the time; the figures in its title. They come in the session's
  announcement (session.proto, from extension 0.3.3), which the extension
  sends again after each of pi's messages; a row from an older extension has
  neither. Reason: which sessions are filling up or dear is a reason to
  open one, and was only inside it.
- **The composer, while pi works** (from Triage, 2026-10-26): Stop on a
  line of its own, by how long the turn has run, and away from the send
  button; a small Steer/Queue switch on that line (2026-11-03), what each
  does in its tooltip; and one send button that says which. Steer is the
  default (since 2026-11-13; Queue before), and Cmd/Ctrl+Enter
  sends as the button would, so it steers unless Queue is chosen, while
  Alt+Enter queues, as in pi; the
  choice holds for the turn, and each turn starts on Steer. Reason: Stop next to Steer was one
  slip from the wrong one. Queue was the default while a steer was taken
  to cut into pi's work, but in pi neither does: a steer is read after
  the step pi is on (the reply and its tool calls), a queued message once
  the whole task is done, and only Stop interrupts. Steer is what Enter
  does in pi's own terminal, and the tooltips now say that ("after the
  step it is on", "when the whole task is done") rather than "interrupt
  now". The price of the switch is a line of
  height on a phone. Before, Queue,
  Steer and Stop sat in one row and Cmd/Ctrl+Enter steered. Until
  2026-11-03 the switch had a line of its own, each side with a line
  under it ("after this turn", "interrupt now"), which took too much
  room; now it shares Stop's line, safe beside it since choosing sends
  nothing, and on a phone's width that line drops the word "Working",
  its sign and the time saying as much.
- **Enter sends on a computer** and Shift+Enter makes a new line; on a
  touch screen Enter is a new line and the button sends. Cmd/Ctrl+Enter
  sends everywhere. A computer is told by its mouse or trackpad (the
  primary pointer is fine), as browsers cannot say whether there is a
  hardware keyboard. Reason: on a computer Enter sending is what every
  chat does, while a phone's return key is the only way to a new line.
  An iPad with a keyboard but no trackpad gets the phone's behaviour, and
  Cmd+Enter still sends there.
- **Tool calls one after another read as one log**, and two or more in a
  row that finished well fold into one line ("✓ 3 tools grep, read,
  edit") that opens to them; one running is open, showing its output so
  far, and one that failed stays in sight. Reason: an agent's turn is
  mostly tool calls, and the reply is what is read.
- **On a laptop, the list and the chat side by side** (from 1024 px
  wide), the open session marked in the list. Both stay in the page at
  every width, so that turning a tablet or resizing a window keeps the
  chat's draft and pending messages and the list's search. Beside the
  list the chat has no back button, and its actions sit by its title.
- **Headers fold on scroll** (2026-10-30, from the Quiet and Native
  mock-ups). The list's header scrolls away; once it has passed, a bar
  of one line holds the list's title and its counts at the top, with the
  search held under it, and tapping the bar goes back to the top. The bar
  takes no room of its own, so nothing moves when it shows. On a phone
  the chat's header lies over the chat and folds to one line (back,
  status, title, context and cost, actions) while the reader is back in
  the chat: neither at its end, where one arrives and writes, nor at its
  top; the line under the title (where it runs, its folder, model,
  thinking) returns at either. The chat starts below the unfolded header,
  so folding moves nothing and never stops a scroll under way. Native
  dresses both as its system's translucent bars, the list's title
  centred. Not on a laptop's chat, where the header is already two
  lines. Reason: a phone's height is the chat's, and folding only while
  reading back keeps the details where the reader writes.
- **Keys on a computer** (2026-10-30, from the Cockpit mock-up): j and k
  move through the rows of the list and Enter opens one; n opens the next
  session waiting for the reader (those asking a question, then those
  finished since last open, each in the list's order, round again); Esc
  stops pi in the open chat, as in pi's terminal. In every look, since
  they are what the app does; Cockpit alone prints them on its buttons
  (esc on Stop, ⏎ on Send), and every look lists them in Settings, with a
  switch to turn them off; ? opens Settings, and Esc leaves it. Only where there is a mouse or
  trackpad (as Enter sending is), never while typing in a field, with a
  modifier held, or while a sheet is open, which Esc closes instead. Esc
  in the message box leaves it, and only a second Esc stops pi, so that
  Esc pressed from habit while writing does not stop a turn (the reason
  Stop moved away from Steer, above); nor while pi asks a question,
  which has its own answers. Reasons: a letter alone can be pressed by
  mistake or by voice control, hence the switch; the mock-up's status
  line was not taken, Settings being where the app's other settings are.
- **Search stays at the top of the list**, held there while the list
  scrolls under it. Triage had it at the bottom of a phone's screen, in
  the thumb's reach; but at the top it is in one place at every width,
  where lists usually keep it, and with no inbox it is the first thing on
  the home screen. A result marks what matched in its title and in where
  it runs, underlined in bold, as the model picker does (since
  2026-10-30); a match only in its folder, model or latest message marks
  nothing, as those are not shown.
- **Settings is a screen of its own** (decided 2026-10-31), at
  `/settings`, opened by a button at the right of the session list's
  title (or ?): on a phone it takes the screen as a chat does; on a
  laptop it is where a chat would be, the list beside it, and the button
  closes it again. Back, or Esc, returns to the chat or list it was
  opened from. First "This browser": notifications (a switch, with a
  line saying why when it cannot be used, and a test), the look (one
  segmented control) and, on a computer, the keys (a switch, and the
  keys listed). Then "Hosts" and "Clients" (since 2026-10-31, design
  section 5.3; one "Devices" section until 2026-11-03): every host and
  every client registered with the relay, a dot for online, this app's
  own server first among the clients as "This web app", every browser
  signing in through it, and "Notifications on" for an app the relay
  wakes through the push gateway (2026-11-04); one tapped opens a sheet to rename it, its
  whole key shown, and below, to remove it, after a confirmation saying
  what that does (not offered for the app's own server). Under each
  section, "Add a host" or "Add an app": a name, then a one-time token
  shown once, as the `/pirc enrol` line to copy for a host, or as a QR
  code and `pirc://join` link for the app. The word "device" is not
  used (2026-11-03). Not connected to the relay, each section says so
  instead of a list that
  could be stale. Reasons: the three
  were a footer under the last session, out of sight on a long list and
  unlike the rest of the page; a sheet was enough for three switches but
  sits far from the button on a laptop and would not hold what is coming,
  sign-in settings such as how long a sign-in lasts. Not taken: a card
  on the list asking a phone to turn notifications on.
- **Fonts are part of the page**, from Fontsource's packages (SIL Open
  Font License 1.1), not loaded from Google: the CSP allows the page's own
  files only, and opening the app should not tell anyone else. Every
  look's fonts are in the page, but only their `@font-face` rules load
  with it: a browser fetches a font's file when it first sets text in it,
  so a look not chosen downloads nothing. Native names the system's
  fonts, which need no file.
- **The icon** was generated on 2026-10-25 with Google's Gemini image
  model (gemini-nano-banana-2.1, through OpenRouter), from a brief for a
  terminal prompt sending a signal, then cropped and set on one colour;
  the master is web/page/logo.png.
- **What hosts send is shown as text**: markdown is rendered without raw
  HTML, under a CSP with no inline script, and its links open in a new
  tab, so that a host's reply cannot take the app somewhere else.
- **Something moves from Send to the end of the reply.** A sent message
  shows at once, faded, until pi's own copy of it replaces it: "Sending…",
  then, sent mid-run, "Queued" or "Steering", and sent while pi compacts,
  "Queued" until it finishes. Refused, it stays with the
  reason, Retry and Edit; still queued when pi goes idle, after a Stop,
  it says pi put it back in its own input box. While pi works and nothing
  streams (waiting for the model, between tool calls), dots at the end
  say so. These live in the page only, so a reload forgets them.
- **The session list names sessions as pi does** (design section 4):
  pi's name for it, else its first message, else its folder, with when it
  last had a message; no preview of that message, which search still
  finds. Each has its window's or tab's name above its own. One that has
  finished since it was last open is marked, as are the host and group
  headings over it. What was read is
  kept in the browser only, and a session first seen there counts as read,
  so that a first visit marks nothing.
- **A host, or a group, has a page of its own** (`/h/<host>`,
  `/h/<host>/<group>`): its name in the list opens it, and the rest of its
  line folds it as before. A host's page keeps its sessions grouped by tmux
  session or herdr workspace; a group's lists its sessions alone. Each has
  its own counts and searches only what it shows; back goes up a level, and
  a chat goes back to the list it was opened from.
- **The most recent session comes first** (decided 2026-10-27), as in
  Claude's apps, whatever its status: under a host, in a tmux session or
  herdr workspace, among sessions in neither, and in search results' ties.
  A working session's time is the message that started its turn, so that
  its replies do not move it; the others' is their latest message, so a
  turn that ends moves its session to the top. Hosts, and the groups in
  a host, keep their order. Replaced: grouping by window in the
  terminal's order, which named only the first of a window's sessions,
  and dingger's order (done, then working, then idle), which put the
  status before the time.
- **Statuses in herdr's words and symbols**, as dingger shows them:
  `◐` working (amber), `✓` done, finished since last open (teal), `○` idle
  (green). The colors are darkened in light mode, where herdr's light
  palette is too faint on white. herdr's `×` blocked (red) marks a
  session asking a question (since 2026-10-30), before the others.
- **Tables scroll sideways on a narrow screen** rather than squeezing
  their columns until words break. Each column keeps a readable width,
  the first stays in view while the rest scroll under it, and the edge
  that hides more is shaded. One wider than the screen can open full
  screen, which shows most tables whole with the phone turned sideways;
  going back closes it.
- **Scrolled up, the chat says when there is more.** It follows the end
  only while the reader is there; scrolled up, a button goes back to it,
  and says "New messages" when something came meanwhile.

Reasons: the author's usual stack, with the most ready-made parts for
chat-style rendering (markdown, code highlighting, long lists). React's cost
with token-by-token streaming is known and handled by keeping finished
messages from re-rendering.

## 6. First version, then notifications

**First version:**
- the hosts and their sessions, live, with which are working;
- a session's history, then its live stream: markdown, code, tool calls
  (collapsed) and thinking;
- prompt and stop;
- the actions of design step 8: model, thinking level, compact, new
  session, `/cost`, `/context`;
- the connection's state, and catching up after the phone sleeps;
- the passkey sign-in;
- installable as an app, with a manifest and a service worker.

**Then, notifications** by web push, when a session finishes its turn
(done 2026-10-30). The server keeps the push keys (VAPID) and the browsers'
subscriptions and sends through the browser vendors' push services, which
see only encrypted content; the server's machine needs to reach them
(outbound HTTPS). On iOS, push works only for an app added to the home
screen (iOS 16.4 and later).

- **Which turns** (decided 2026-10-30): every turn that ends, wherever its
  prompt came from (the terminal or a client), so that a task started at
  the desk tells the phone it is done. Not a turn stopped on purpose (an
  abort), nor a session that ends while working. Not when a page is
  showing that chat, on any device: a page holds an event stream for the
  chat it shows, and closes its stream while hidden, so an open stream
  means the chat is on a screen. Later, perhaps: quiet while pi's tmux
  window is on screen with recent typing, which needs the extension to say
  so.
- **What it says** (decided 2026-10-30): the session's title and host, and
  the first 120 characters of pi's reply, or "Failed:" and the error. It
  shows on the lock screen even when the sign-in has lapsed; the phone's
  own setting to hide previews when locked is the way to keep it off
  there. One per session: a later one replaces the earlier (the
  notification's tag and the push's topic), and a push service keeps one
  for a phone that is off for a day at most. Tapping it opens the chat.
- **In each browser**: turned on in Settings (section 5), which
  asks the browser's permission, subscribes it and sends a test
  notification; turned off there. A subscription belongs to the passkey
  signed in when it was made, so revoking a passkey stops its devices'
  notifications; one a push service says has ended is forgotten. They are
  kept in `push.json` in the data directory, with the server's push key:
  losing it means turning notifications on again on each device.
- **Questions too** (decided 2026-10-30): a question pi asks for an
  extension (design.md, section 8) notifies as a finished turn does, its
  body "Asks:" and the question, unless a page shows the chat; one asked
  before the server first saw the session does not.
- **Moving for the mobile app** (decided 2026-10-31): which turns and
  questions notify, and the reply's first 120 characters, move into the
  extension, which puts the latest notice in the session's announcement;
  the server, like the app, writes the notification from it with code in
  `web/core`, and alone keeps quiet while one of its pages shows the chat
  (design.md, section 12, step 13). Browsers keep web push from the
  server as now. Done 2026-11-03: the server notifies from the host's
  notice, a new number being news (a session first seen is not; one
  back after its host dropped is not first seen, so a notice raised
  while it was away notifies), its
  text cut by the host to 120 code points; a session from a host whose
  extension predates notices, which never carries one, notifies by the
  rules above, worked out here from the chat.
- **Written here, not a library**: the encryption (RFC 8291) and the
  push key's token (RFC 8292) are about a hundred lines on Node's crypto,
  tested against the RFC's example.

**After that, each with its own change below the web app:** fork and
clone (done 2026-10-27: tap one of your messages to fork from there; Clone
is in the session's actions), resume and past sessions (done 2026-10-27:
Resume in the session's actions lists this folder's saved sessions, with a
switch to every folder's), reload (done 2026-10-27: Reload in the
session's actions), pi's session tree (done 2026-10-28: tap one of your
messages to go back to before it, with or without a summary of what came
after; Branches in the session's actions switches to another branch),
approving hosts in the app (done 2026-10-29: a machine asking to join
shows above the session list, approved or rejected in a sheet after
comparing its key), starting and stopping agents (done 2026-10-29: + on a
tmux session or herdr workspace, or New agent in a session's actions,
opens a pi beside it in a folder chosen or typed, its window named after
the folder unless a name is typed, then its chat; Stop pi
in the actions), pi's questions (done 2026-10-30: a dialog an extension
shows in pi's terminal shows above the composer too, answered there or in
the terminal; × marks a session that asks, in the list and the chat),
better tool cards (done 2026-10-30: a tool's time, counting while it runs
and shown from a second up; a command's exit status beside it when it
failed; an edit's diff in place of its arguments), code (done 2026-10-30:
highlighted, with Copy on each block and on each finished reply, below),
drafts (done 2026-10-30: what is being written in a chat is kept in the
browser, per device as read marks are, for a week and for the hundred
chats written in most recently; sending clears it), and images in prompts
(done 2026-10-30, below).

**Code in replies** (decided 2026-10-30): highlighted by highlight.js's
grammars through `rehype-highlight`, beside react-markdown, only where the
reply names the language (guessing it is slow and often wrong). It is a
third of the page's size again, so it is fetched the first time a code
block shows, and blocks are highlighted once it has come; the page itself
stays as it was. Each look colours the tokens from its own palette, so
light and dark follow: Quiet keeps to greys, by weight and shade, as its
mock-up; the others use their accent, done, working and link colours.
Copy on a code block copies the code; Copy under a reply that ends a turn
copies the reply as the Markdown it was written in. A block shows its file
beside its language when the reply names one after the opening fence
(```` ```ts src/a.ts ````, `title="…"`, `file=` or `filename=`, or
```` ```ts:src/a.ts ````), or names only a file, whose extension is then
the language; a long path loses its start, so that the file's name shows
(added 2026-10-30, as the Quiet mock-up drew it).

**Images in prompts** (decided 2026-10-30): up to four in a message,
chosen with the button beside the box, pasted, or dropped anywhere on the
page. The page shrinks each to fit 2000 by 2000 pixels (pi's own limit,
so pi does not shrink it again) and sends it as a JPEG, or as a PNG where
that is under 1.5 MB (most screenshots); a small PNG, GIF or WebP that
fits already goes as it is. Each is at most 2 MiB, so a prompt with four
stays well within one relay frame; the server refuses more, larger, or
another type (SVG, which a browser would run as a page, included). They
travel inline in the prompt, as the Remote Pi app's did through the
adapter (retired 2026-11-07), so the extension needed no change.
Reason: a phone photo is 4 to 12 MB, which over mobile data took seconds
and needed every limit raised, and pi would have shrunk it anyway;
shrinking in the browser also turns HEIC into something pi reads.
Images are not kept with a draft.

A message's images show as thumbnails that open full screen, whoever
sent them (the app, pi's terminal, another client). The server keeps
them in memory as they come with the messages, by a key made from their
content so that history fetched again keeps one copy, 32 MB for all
sessions, the least recently shown going first; one gone, or left out of
a message for size, shows as a placeholder. Reason: what was sent is part
of the conversation, and the images reach the server anyway. When the
session's model is known not to take images, the composer says so.
