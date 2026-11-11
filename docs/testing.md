# Checking a change in the web app

The checks and the end-to-end tests (README) cover the server and the
client logic, but not what the page shows. For a change to the page, also
look at it working in a browser, against a local PiRC with a scripted model,
before pushing. This is how.

## 1. Start a demo

```sh
node --experimental-transform-types --no-warnings web/test/demo.ts [port]
```

Run it in the background; it runs until interrupted. It builds the page
from this tree, then starts a relay, one interactive pi with the extension
in a tmux server of its own, and pirc-web on `http://localhost:<port>`
(7402 by default). When it is ready it prints:

```
PiRC demo ready
  sign in: http://localhost:7403/  (opens http://localhost:7402, signed in; ...)
  or pair: http://localhost:7402/pair#...
  pi:      tmux -L pirc-e2e-<pid>-pi capture-pane -p -t '=pirc-e2e-<pid>-pi:'
  stop:    interrupt this process; it removes everything it started
```

- **sign in**: opening this link signs the browser in, with no passkey.
  The demo has already paired a passkey in software and signed in with it,
  as the end-to-end test does; the link, served on the next port, sets that
  sign-in's cookie and goes to the page. It lapses after 30 minutes without
  a request; restart the demo for a new one.
- **or pair**: a pairing link, for checking the passkey screens themselves.
  A browser automated over the Chrome DevTools Protocol can make the
  passkey with a virtual authenticator (`WebAuthn.enable`, then
  `WebAuthn.addVirtualAuthenticator` with `ctap2`, `internal`, resident
  keys and user verification, on the tab, before opening the link). It
  lasts only as long as the protocol connection that added it.
- **pi**: what pi's terminal shows, to compare with the page.

The page's origin is `localhost`, which passkeys and cookies require, so
the browser must reach the demo as `localhost`: run the demo on the
browser's machine, or forward both ports to it (`ssh -L`).

To check a page change again, interrupt the demo and start it again: it
builds the page only when it starts.

## 2. Drive the model

The model is scripted (`extension/test/fake-model.ts`). What it does depends
on the words in the last message, checked in this order:

| Message contains | Reply |
|---|---|
| `table` | a five-column table, to check narrow screens |
| `tool` | a bash tool call, then text once its result comes back |
| `medium` | text streamed over about a second |
| `slow` | text streamed over twenty seconds: time to queue, steer or stop |
| `wait` | two seconds of nothing, then short text, as a slow model |
| anything else | short text, streamed at once |

## 3. Look

With browser automation tools (such as Chrome DevTools MCP): open the sign-in
link, resize to a phone's width (about 400 × 760), take snapshots to find
elements, and screenshots to see them. Changes that move are easier to
catch in a screenshot taken straight after the action.

- **Snapshot again after anything changes the composer.** The Send, Queue,
  Steer and Stop buttons are replaced as pi starts and stops working, so
  an element ID from an older snapshot fails with "did not become
  interactive".
- The demo leaves nothing behind when interrupted (SIGINT or SIGTERM): its
  processes, its tmux server and its temporary folder go. Interrupting it
  with SIGKILL leaves them; the tmux server is then removed with the `-L`
  name it printed.
- Each run's sign-in cookie replaces the last one's, since cookies ignore
  the port.

## 4. The gallery: every screen and state, with made-up content

The demo has one session and a scripted model, so some screens are hard to
reach with it: a list of many hosts and groups, a refused message, a model
that failed, a chat still loading. The gallery shows them with made-up
content, with no relay, pi or sign-in:

```sh
cd web/page && ../node_modules/.bin/vite --port 5179 --strictPort --host 127.0.0.1
```

then open `http://127.0.0.1:5179/gallery.html?screen=<screen>`, where
`<screen>` is `list` (the default), `empty`, `chat` (a finished reply),
`working` (pi at work, every kind of item), `loading`, `ended`, `signin`,
`pair` or `splash`; add `&banner=reconnecting`, `refused` or `connecting`
for the connection line, and `&look=quiet`, `triage`, `native` or
`cockpit` for the look (kept, as the switch in Settings keeps it);
`screen=settings` opens Settings, with made-up devices to rename and
remove and a made-up token to add one (a name with "refuse" in it is
refused, renaming to it, removing one under it, or asking a token for
it), and `&notify=off`, `on`, `blocked` or
`unsupported` makes up this browser's notifications for it. At a laptop's width (1024
px or more) the list and the chat are side by side, as in the app; a
session opened from the list shows the made-up chat. Its requests are answered by `src/gallery.tsx`:
the session actions and the model picker work, and a message with
"refuse" in it is refused. The gallery is never part of the built page.
Look at every look, both colour schemes (Chrome DevTools can emulate
either) and both widths, a phone's and a laptop's.

## 5. The shared test cases

The client logic (`web/core`) is checked against cases kept as data in
`cases/`: recorded exchanges with the relay, and its pure functions'
arguments and results. The mobile app's Dart port runs the same files.
`cases/README.md` describes their form. To add one, write its inputs and
let `web/test/record.ts` fill in the rest, then read what it wrote:

```sh
node --experimental-transform-types --no-warnings web/test/record.ts cases/functions/view.json
```

A change to `web/core` that changes a case's result is a change to every
client: say so to whoever keeps the other one.
