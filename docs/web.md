# PiRC's web app

PiRC's web client, for a phone or a laptop (design section 12, step 12).
This document is its specification: what it does and why. Installing it is
in `docs/self-hosting.md`.

## 1. Shape

Two parts in `web/`, released with the relay (`pirc-web-X.Y.Z.tar.gz`) or
built from any commit with `sh/build.sh web`, and deployed on their own:

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
a self-hosted relay can (design section 5.1). With end-to-end
encryption, which arrives with the hosted relay, the server would be an end
and see everything, so a hosted relay gets a client designed for that
instead.

**Licence**: AGPL-3.0 (`web/LICENSE`), the copyright Justino Ltd's.

## 2. Access

Whoever is signed in has full access: every host and session, which in
practice is a shell on every host (design section 6). One relay is one
account, so there are no users or permissions; they come with the hosted
relay. The server manages the relay's devices through its own relay
connection: approving or rejecting hosts that ask to join, listing hosts
and clients, renaming and removing them, and issuing tokens for new ones
(design section 5.3). A
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
- **Signing out**: Settings → This browser → Sign out ends this
  browser's session (`/api/logout`) and turns off its notifications,
  which would otherwise outlive the sign-in (section 6): what a computer
  that is not one's own needs. The passkey stays, to sign in again.
- `pirc-web list` shows the passkeys and `pirc-web revoke` deletes one,
  ending its sessions. Removing the server's key on the relay cuts off
  every browser at once.
- **Limits**: request bodies of 64 KiB while signing in and 1 MiB after,
  but for a prompt, which may carry its images and files (about 25 MiB); 20
  pairing or sign-in attempts a minute per address, behind a proxy the
  client's as the proxy gives it, from a proxy listed in
  `PIRC_WEB_TRUSTED_PROXIES` only (`server/proxy.ts`); HSTS on HTTPS.

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

Modelled on comparable apps (chat front ends, agent and coding-agent
remote UIs, terminal and notebook UIs):

- **Commands** are HTTP requests: `POST` for a prompt, stop and the
  actions; each answers `{ok, result}` or `{ok, code, message}`, with
  `id`, the event stream's position when the answer came. For a change
  (model, thinking level, rename) the session broadcasts its new state
  before answering, so the position is past the effect; a prompt is
  answered as it is taken, before its messages arrive. The commands, their
  bodies and their results are listed once, in `web/core/api.ts`, which
  the server's routes and the page's calls are both built from; a reply of
  another kind than the command's is answered `PI_FAILED`.
- **A request ID from the page**: the page makes one for each
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
- **Starting**: the page first asks whether it is signed in. While the
  server is out of reach (no network, a deploy), the splash says so and
  asks again every 3 seconds, and at once when the page is shown again.
- **Ordering**: the page applies a command's result once the stream has
  reached its `id`.
- What the server sends is shaped for the screen ("session X is working",
  "append this text to message M"), not raw PiRC frames.
- Messages are defined once, in TypeScript shared by the server and the
  page.
- Served over HTTP/2: browsers allow only 6 streams per name over HTTP/1.1.
  A proxy in front must not buffer the stream. The stream is written
  directly, not with Hono's own helper, which sets a header HTTP/2 forbids
  and so brings the server down; the end-to-end test runs over TLS and
  HTTP/2 for that reason.
- **Bounds**: the server keeps the last 5000 events, or 16 MiB, for pages
  catching up; a page that stops reading (a phone gone off the network
  without closing) has its stream ended after 2000 unread events, and
  catches up when back. A chat keeps its latest 1000 items on the server.
  A compaction's command waits at most 15 minutes.
- **A chat's latest items first**: a page is sent a chat's
  latest 100 items, in its snapshot and in a reset on the stream, and asks
  for those before them, 100 at a time (`/api/chat/<id>/older`), as its
  reader nears the top; what was on screen stays where it was. A long
  chat's 1000 items can be 1.3 MB of JSON, and seconds of drawing on a
  phone. A change to an item the page has not loaded is marked `old`, and
  the page leaves it for when it loads that item; an answer made before
  such a change is asked for again, and one that comes after the chat was
  reset is dropped. A reset whose items follow on from those the page has
  loaded keeps them, so a reader scrolled up keeps their place. A failed
  load says why, with a button to try again. The snapshot and older items
  are compressed (gzip or brotli, as the browser takes); the event stream
  is not, which would hold events back.
- **New versions**: a page left open keeps running the version it
  loaded, and nothing else reloads a page already open, so a deploy would
  reach nobody who kept the app open. So the page asks for its own HTML (`/`, never cached) when shown again, when its stream opens, and
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
13). It is Flutter, so its Dart version is written
to pass the same cases, and they behave the same. They are at the root,
not in `web/`, since they belong to neither client.

## 5. Stack

- **Server**: Hono on Node 22 or later, bundled with esbuild into one
  file, as the extension is; `relay-client` for the relay.
- **Page**: React, TypeScript, Vite and Tailwind, with our own components,
  using Radix's unstyled parts only where accessibility is hard to get right
  (menus, dialogs).
- **Four looks, chosen in the app: "Native" (the default), "Quiet",
  "Triage" and "Cockpit"**, each from a mock-up of its own. Quiet is
  type and hairlines, colour kept for status: the agent's replies in
  Literata, a serif drawn for long reading on screens; the interface in
  Atkinson Hyperlegible Next; code, paths and tool calls in JetBrains Mono.
  Triage is cards and soft status tiles on a grey page, one blue accent
  for what can be done, set in Geist and Geist Mono. Triage's mock-up had
  an inbox of cards on top ("Waiting for you"), which did not prove useful
  and is left out: every look lists sessions by host and group. Native makes the app feel shipped with the
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
  Reason: separate sets of components would build every feature and fix
  more than once, and each set would miss fixes the others had. The price:
  each change to the page is dressed and looked at in every look.
- **How far Triage is dressed.** Every screen wears it: the list's rows
  and groups on cards, status tiles, the chat's blue bubbles and tool
  cards, the sheets' rows on cards, the model picker, sign-in with the
  four statuses as its mark, the connection line and a table full screen.
  Where the two designs differed in layout rather than dress, one layout
  serves both: the chat's header keeps Quiet's two lines, and the model
  picker stays full screen on a phone rather than a tall sheet. Left out:
  the glyph beside each sheet row. Reason: a second layout per screen is
  where two looks would start to drift into two apps.
- **Native and Cockpit, against their mock-ups**, as Triage, on the same
  rule: one layout and one behaviour for every
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
  message, which the list does not show. A tool's time and syntax colours
  in code are taken (section 6), as are Cockpit's keys and Native's
  folding title, both below.
- **The choice is kept in the browser**, per device, as which hosts are
  open is; it is set in Settings (below).
  Native is the default and first in the picker, as the phone apps' look.
  A browser that chose a look keeps it.
- **The session's actions are a sheet** from the bottom: model, thinking
  level as one row of seven ("min" and "med" shortened, so that it fits a
  phone), cost and context (what it has cost and how full the context is,
  shown in the row as the sheet opens; the row gives the details),
  compact, rename and new session, the last two asked in the sheet itself
  rather than in the browser's dialogs. Sheets, the model picker and a
  table full screen are each a step in the history, so going back closes
  the top one.
- **Context and cost in the chat's header** (`42% · $0.31`),
  at the end of the title's line, which gives way to it. The page asks pi
  for them when the chat opens, after each reply and when the model
  changes. Reason: how full the context is decides when to
  compact or start afresh, and would otherwise be three taps away. The sheet's row still
  gives the details.
- **Cost and context in the session list**: each row has what the session has cost (`$1.84`, its whole
  total, as pi's footer) and a small meter of its context, grey, in the
  working colour above 70% and the asking colour above 90%, as in pi,
  before the time; the figures in its title. They come in the session's
  announcement (session.proto, from extension 0.3.3), which the extension
  sends again after each of pi's messages; a row from an older extension has
  neither. Reason: which sessions are filling up or dear is a reason to
  open one, and would otherwise show only inside it.
- **The composer, while pi works** (from Triage): Stop on a line of its
  own, by how long the turn has run, and away from the send button; and
  Send, the same button as when pi is idle, which steers. Held on a touch
  screen, right-clicked, or opened with the menu key, Send offers "Send
  now" (pi reads it after the step it is on) or "Queue" (pi reads it when
  the whole task is done); the box's hint says "Steer, or hold to queue".
  Enter and Cmd/Ctrl+Enter steer, Alt+Enter queues, as in pi. The apps
  are the same, a long press (or a secondary click) opening a sheet with
  the two. Reasons: neither Steer nor Queue cuts into pi's work, only
  Stop does, and Steer, what Enter does in pi's own terminal, is what is
  usually meant, so it is what Send does; a Steer/Queue switch beside a
  button that said which and Stop was three controls for one message,
  and a choice to set before each send. Queueing behind a hold is how
  messaging apps keep other ways to send (Telegram's, iMessage's), and
  the message shows as "Queued" or "Steering" in the chat once sent, so
  what was chosen is never hidden. Stop stays its own button, not Send
  turned into Stop as in chat apps where one cannot write while a reply
  comes: here one can, and Stop would vanish while writing. Stop next to
  Send would be one slip from the wrong one. An empty Send is grey in
  every look, as a disabled button.
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
- **On a tablet or a laptop, the list and the chat side by side** (from
  700 px wide and 500 high: an iPad mini upright, but not a phone on its
  side), the open session marked in the list. The list's column is 380
  wide, as far as the chat keeps 400; dragging its edge (or its arrow
  keys) makes it 280 to 560, and a button at the start of the chat's
  header (Settings', or the empty pane's) hides and shows it, both kept
  in the browser. Reason: an upright tablet had the phone's layout, and
  a laptop's list could not make room. Rejected: 1024, which left
  every iPad but the 13-inch upright with the phone's. Both stay in the page at
  every width, hidden or not, so that turning a tablet or resizing a window keeps the
  chat's draft and pending messages and the list's search. Beside the
  list the chat has no back button, and its actions sit by its title.
- **Headers fold on scroll** (from the Quiet and Native mock-ups). The list's header scrolls away; once it has passed, a bar
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
- **Keys on a computer** (from the Cockpit mock-up): j and k
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
  which has its own answers and takes the focus when the message box it
  replaces had it. Reasons: a letter alone can be pressed by
  mistake or by voice control, hence the switch; the mock-up's status
  line was not taken, Settings being where the app's other settings are.
- **Search stays at the top of the list**, held there while the list
  scrolls under it. Triage had it at the bottom of a phone's screen, in
  the thumb's reach; but at the top it is in one place at every width,
  where lists usually keep it, and with no inbox it is the first thing on
  the home screen. A result marks what matched in its title and in where
  it runs, underlined in bold, as the model picker does; a match only in its folder, model or latest message marks
  nothing, as those are not shown.
- **Settings is a screen of its own**, at
  `/settings`, opened by a button at the right of the session list's
  title (or ?): on a phone it takes the screen as a chat does; on a
  laptop it is where a chat would be, the list beside it, and the button
  closes it again. Back, or Esc, returns to the chat or list it was
  opened from. First "This browser": notifications (a switch, with a
  line saying why when it cannot be used, and a test), the look (one
  segmented control) and, on a computer, the keys (a switch, and the
  keys listed). Then "Hosts" and "Clients" (design section 5.3): every host and
  every client registered with the relay, a dot for online, this app's
  own server first among the clients as "This web app", every browser
  signing in through it, and "Notifications on" for an app the relay
  wakes through the push gateway; one tapped opens a sheet to rename it, its
  whole key shown, and below, to remove it, after a confirmation saying
  what that does (not offered for the app's own server). Under each
  section, "Add a host" or "Add an app": a name, then a one-time token
  shown once, as the `/pirc enrol` line to copy for a host, or as a QR
  code and `pirc://join` link for the app. The word "device" is not
  used. Not connected to the relay, each section says so
  instead of a list that
  could be stale. Reasons: a footer under the last session would be out
  of sight on a long list and unlike the rest of the page; a sheet would
  be enough for a few switches but sits far from the button on a laptop
  and would not hold what is to come, sign-in settings such as how long a
  sign-in lasts. Not taken: a card
  on the list asking a phone to turn notifications on.
- **Fonts are part of the page**, from Fontsource's packages (SIL Open
  Font License 1.1), not loaded from Google: the CSP allows the page's own
  files only, and opening the app should not tell anyone else. Every
  look's fonts are in the page, but only their `@font-face` rules load
  with it: a browser fetches a font's file when it first sets text in it,
  so a look not chosen downloads nothing. Native names the system's
  fonts, which need no file.
- **The icon** is a terminal prompt sending a signal, set on one colour;
  the master is `web/page/logo.png`, from which `sh/app-icons.sh` makes
  the mobile app's.
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
- **Hosts and groups start open.** One folded stays folded, kept in the
  browser (on the phone, in the app), so that a list first seen, as after
  adding a computer, shows its sessions rather than a closed heading.
- **The counts at the top narrow the list**: tapping "asking", "done" or
  "working" shows only those sessions, under their hosts and groups, all
  unfolded (folding them then lasts until the filter changes), and the
  search looks only among them; tapping it again, or "in all", shows every
  session. The filter lasts while the list is shown, and goes when its
  count is down to none, so that the list is never left empty by it. The
  same in the phone apps. Reason: finding the session that waits for the
  reader is what the list is for, and the counts already looked like
  buttons.
- **The most recent session comes first**, as in
  Claude's apps, whatever its status: under a host, in a tmux session or
  herdr workspace, among sessions in neither, and in search results' ties.
  A working session's time is the message that started its turn, so that
  its replies do not move it; the others' is their latest message, so a
  turn that ends moves its session to the top. Hosts, and the groups in
  a host, keep their order. Rejected: grouping by window in the
  terminal's order, which names only the first of a window's sessions,
  and ordering by status (done, then working, then idle), which puts the
  status before the time.
- **Statuses in herdr's words and symbols**: `◐` working (amber), `✓`
  done, finished since last open (teal), `○` idle (green). The colors are
  darkened in light mode, where herdr's light palette is too faint on
  white. A session asking a question, herdr's blocked, is marked `?` in
  the accent colour, as something waiting for the reader rather than an
  error, before the others.
- **Tables scroll sideways on a narrow screen** rather than squeezing
  their columns until words break. Each column keeps a readable width,
  the first stays in view while the rest scroll under it, and the edge
  that hides more is shaded. One wider than the screen can open full
  screen, which shows most tables whole with the phone turned sideways;
  going back closes it.
- **Scrolled up, the chat says when there is more.** It follows the end
  only while the reader is there; scrolled up, a button goes back to it,
  and says "New messages" when something came meanwhile.

Reasons: the stack with the most ready-made parts for
chat-style rendering (markdown, code highlighting, long lists). React's cost
with token-by-token streaming is known and handled by keeping finished
messages from re-rendering.

## 6. What it does, and notifications

**At its core:**
- the hosts and their sessions, live, with which are working;
- a session's history, then its live stream: markdown, code, tool calls
  (collapsed) and thinking;
- prompt and stop;
- the actions of design step 8: model, thinking level, compact, new
  session, `/cost`, `/context`;
- the connection's state, and catching up after the phone sleeps;
- the passkey sign-in;
- installable as an app, with a manifest and a service worker.

**Notifications** by web push, when a session finishes its turn. The
server keeps the push keys (VAPID) and the browsers' subscriptions and
sends through the browser vendors' push services, which see only
encrypted content; the server's machine needs to reach them (outbound
HTTPS). On iOS, push works only for an app added to the home screen (iOS
16.4 and later).

- **Which turns**: every turn that ends, wherever its prompt came from
  (the terminal or a client), so that a task started at the desk tells
  the phone it is done. Not a turn stopped on purpose (an abort), nor a
  session that ends while working. Not when a page is showing that chat,
  on any device: a page holds an event stream for the chat it shows, and
  closes its stream while hidden, so an open stream means the chat is on
  a screen. Later, perhaps: quiet while pi's tmux window is on screen with
  recent typing, which needs the extension to say so.
- **What it says**: the session's title and host, and the first 120
  characters of pi's reply, or "Failed:" and the error. It shows on the
  lock screen even when the sign-in has lapsed; the phone's own setting to
  hide previews when locked is the way to keep it off there. One per
  session: a later one replaces the earlier (the notification's tag and
  the push's topic), and a push service keeps one for a phone that is off
  for a day at most. Tapping it opens the chat.
- **In each browser**: turned on in Settings (section 5), which
  asks the browser's permission, subscribes it and sends a test
  notification; turned off there. A subscription belongs to the passkey
  signed in when it was made, so revoking a passkey stops its devices'
  notifications; one a push service says has ended is forgotten. They are
  kept in `push.json` in the data directory, with the server's push key:
  losing it means turning notifications on again on each device.
- **Questions too**: a question pi asks for an extension (design.md,
  section 8) notifies as a finished turn does, its body "Asks:" and the
  question, unless a page shows the chat; one asked before the server
  first saw the session does not.
- **From the host's notice**, shared with the mobile app: which turns and
  questions notify, and the reply's first 120 characters, are worked out
  by the extension, which puts the latest notice in the session's
  announcement; the server, like the app, writes the notification from it
  with code in `web/core`, and alone keeps quiet while one of its pages
  shows the chat (design.md, section 12, step 13). Browsers get web push
  from the server. A new number is news (a session first seen is not; one
  back after its host dropped is not first seen, so a notice raised while
  it was away notifies), its text cut by the host to 120 code points; a
  session from a host whose extension predates notices, which never
  carries one, notifies by the rules above, worked out here from the chat.
- **Written here, not a library**: the encryption (RFC 8291) and the
  push key's token (RFC 8292) are about a hundred lines on Node's crypto,
  tested against the RFC's example.

**Beyond that, each with its own change below the web app:**

- **Fork and clone**: tap one of your messages to fork from there; Clone
  is in the session's actions.
- **Resume and past sessions**: Resume in the session's actions lists
  this folder's saved sessions, with a switch to every folder's.
- **Reload**: Reload in the session's actions.
- **pi's session tree**: tap one of your messages to go back to before
  it, with or without a summary of what came after; Branches in the
  session's actions switches to another branch.
- **Approving hosts in the app**: a machine asking to join shows above
  the session list, approved or rejected in a sheet after comparing its
  key.
- **Starting and stopping agents**: + on a tmux session or herdr
  workspace, or New agent in a session's actions, opens a pi beside it in
  a folder chosen or typed, its window named after the folder unless a
  name is typed, then its chat; Stop pi in the actions.
- **pi's questions** (`design.md` section 8): a dialog an extension shows
  in pi's terminal shows in the app too, answered there or in the
  terminal. The question takes the composer's place while it waits, under
  "pi asks", its text kept as written, indented and bracketed blocks as
  code and "Name: value" lines as a label and value; a yes or no and a
  select's options go with an optional note for pi, "Dismiss and stop"
  closes the question and stops pi's turn, an input's text is the
  answer, and one only pi's terminal can answer says so, with where pi runs and Stop; the tool call
  it holds up says "Waiting for you". `?` in the accent colour marks a
  session that asks, in the list and the chat, and the list's counts
  count each session once, asking before working before done, so that
  they add up.
- **Tool cards**: a tool's time, counting while it runs and shown from a
  second up; a command's exit status beside it when it failed; an edit's
  diff in place of its arguments.
- **Code**: highlighted, with Copy on each block and on each finished
  reply (below).
- **Drafts**: what is being written in a chat is kept in the browser, per
  device as read marks are, for a week and for the hundred chats written
  in most recently; sending clears it.
- **Images and files in prompts** (below).

**Code in replies**: highlighted by highlight.js's
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
(as the Quiet mock-up drew it).

**Images in prompts**: up to four in a message,
chosen with the button beside the box, pasted, or dropped anywhere on the
page. The page shrinks each to fit 2000 by 2000 pixels (pi's own limit,
so pi does not shrink it again) and sends it as a JPEG, or as a PNG where
that is under 1.5 MB (most screenshots); a small PNG, GIF or WebP that
fits already goes as it is. Each is at most 2 MiB, so a prompt with four
stays well within one relay frame; the server refuses more, larger, or
another type (SVG, which a browser would run as a page, included). They
travel inline in the prompt, so the extension needs no change for them.
Reason: a phone photo is 4 to 12 MB, which takes seconds over mobile data
and would need every limit raised, and pi would shrink it anyway;
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

**Files in prompts**: any other file, for a session whose requests include
`attachment_chunk` (design.md, "A client's files"); for any other session
the button beside the box takes images only, and a file dropped or pasted
is refused with why. A message's files come to 10 MiB at most, the
extension's cap, and 20 files; the composer shows each as a chip with its
name and size, removable, and says why a file that would pass the cap was
not added. An image stays an image, shrunk as above; one the browser
cannot draw goes as a file. A message may be files alone. The page sends
them to the server in the prompt's JSON, base64, as images go, within the
prompt's body limit; the server sends each file's bytes to the session
first, in `AttachmentChunk`s of 512 KiB from offset 0, then the prompt
naming them, each file's id the request's ID and its place, so a retry
restarts the same ids. A retry of a prompt the session accepted sends no
pieces again, since the session answers it from what it kept. Reason:
base64 in JSON costs a third more on the wire, at most about 13 MiB, and
keeps one request per message, retried whole, with nothing kept on the
server between requests; an upload of its own would need storage, ids and
expiry here for no gain at this size.

A message's files show as chips in its bubble, sent or still pending, by
name and size, from History (`UserMessage.attachments`); they do not
open, since only their names come back. The session list names a message
of files alone by its file, or as "N files"; images come first.
