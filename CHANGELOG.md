# Changelog

What each release changes for people running PiRC. A release is the
relay, the web app and the pi extension, built from one commit
(`docs/self-hosting.md`); what the apps gain from it is said with it.
Upgrade the relay first, then the rest (Upgrading, in the guide). A
release that needs its parts upgraded together says so here.

## Unreleased

- The web app no longer stays on its logo for good when the server is out
  of reach as it opens (no network, a deploy): it says so, and tries again
  every few seconds and as soon as it is shown again.
- In the web app, closing an image opened full screen from a message no
  longer offers going back or forking from that message; with Enter, the
  image stayed open and the offer came over it.

## 0.3.13 (2026-11-21)

- New agent works when pi runs in herdr. It failed every time with
  "write EPIPE": herdr answers one request per connection, and the
  extension asked its second on the first. The session list now also
  shows herdr's workspace and tab names, which it never did.
- The web app's default look is Native, the phone apps' own, first in
  Settings → Look; a browser that chose another look keeps it.

## 0.3.12 (2026-11-18)

- A phone can leave a relay: the relay now takes a client's own key off
  its list when that client asks to leave. The iOS and Android apps use
  it from 1.0.2, in Settings → Relay → Leave this relay, along with
  Settings → Relay → Change address, so a phone follows a relay that
  moves to another port or name without joining again. Before, the only way
  out was reinstalling the app.
- `pirc-web enrol <relay-url>` without a token points the web app at its
  relay's new address; restart it after. The guide's "Moving the relay
  to a new address" says what to do for each part.

## 0.3.11 (2026-11-17)

- The web app keeps following a session whose computer reconnects to the
  relay within a few seconds, as when the relay restarts; before, its
  chat stopped updating, though messages still reached pi. The iOS and
  Android apps get the same fix in their next store build.
- What an extension tells you in pi's terminal (its notifications, such
  as pi-automode's "Auto mode blocked bash: …") now shows in the chat
  too, where it happened: info quietly, warnings and errors in their
  colour. The iOS and Android apps show them from their next store
  build. Needs this release's extension.

## 0.3.10 (2026-11-17)

- Dismiss on a question asked before pi started on your message (some
  extensions ask then) also stops that message from running; before, the
  question closed and the message ran anyway.

## 0.3.9 (2026-11-17)

- The web app opens a long session quickly: it loads the latest 100
  messages and tool calls, and earlier ones as you scroll up, keeping your
  place. What it loads is sent compressed.
- Answering pi's questions, such as pi-automode's permission asks, in
  the web app: the question takes the message box's place while it
  waits, its text laid out as written, with code as code. Yes, No and a
  list's options can carry a note for pi, which the model reads together
  with what follows from your answer. Dismiss now closes the question and
  stops pi, where before it was a second No; it works even when the
  extension that asked gave pi no way to stop it. The command a question
  holds up says "Waiting for you", and a session that asks is marked "?"
  in the accent colour. The list counts each session once, so its counts
  add up. Needs this release's extension. With pi 1.0.0, a turn stopped
  by Dismiss shows as a failed model call ("This operation was
  aborted"); from pi 1.5 it shows as stopped.
- In the iOS and Android apps, from their next store build, a question pi
  asks takes the message box's place until it is answered: its text laid
  out as written, a note for pi that goes with your answer, full-width No
  and Yes, and Dismiss, which closes it and stops pi. The tool call it is
  about says "Waiting for you". A question is shown in blue with "?", not
  as an error, and the session list counts each session once.

## 0.3.8 (2026-11-15)

- The extension is on npm, as `pirc-extension`, and in pi's package
  gallery: `pi install npm:pirc-extension@X.Y.Z` installs it with `npm`
  alone, no `git` needed. It is published from the release's own archive;
  `SECURITY.md` says how to check it. From git before, run
  `pi remove git:github.com/pirc-dev/pirc-extension` first: installed both
  ways, the copy pi loads second now does nothing but say which install
  to remove, where until now both loaded and pi lost the `/pirc` command.
- The web app's session header has two lines under the title: where the
  session runs and the last part of its folder, then its model, provider
  and thinking level, with the context used and the cost at the right. The
  full folder is in the session's menu.
- The iOS and Android apps' session header has the same two lines, from
  their next store build.

## 0.3.7 (2026-11-15)

- The extension is tested with pi 1.0.0 and the current pi on every
  change, and expects pi 1.0.0 or later in 1.x; outside that,
  `/pirc status` says so.
- The guide and the extension's README say what installing the extension
  without a tag means: the next thing published runs on your machine at
  `pi update`, unread. Pin it to a release.
- The extension's repository on GitHub gets releases only: its default
  branch no longer moves with each change, so an install without a tag
  runs the latest release, not the latest build.
- Release tags are signed, from this release on, by a key listed in
  `allowed_signers`; `SECURITY.md` says how to check one with
  `git verify-tag`.

## 0.3.6 (2026-11-14)

- Fixed: in the Docker Compose setup, the relay or the web app could take
  Caddy's fixed address, 172.30.88.2, if it started first, and Caddy then
  failed with "Address already in use". Docker now hands out addresses
  from the upper half of the subnet only; take this release's
  `docker/compose.yaml`.
- The self-hosting guide has a Tailscale quickstart: the relay and the
  web app behind `tailscale serve`, reached from the tailnet only, with
  its certificate.

## 0.3.5 (2026-11-14)

- Container images of the relay and the web app,
  `ghcr.io/pirc-dev/pirc-relay` and `ghcr.io/pirc-dev/pirc-web`, for
  amd64 and arm64, built from this release's own downloads, with
  provenance; and a Docker Compose setup behind Caddy, which gets the
  certificate (`docker/`, and "With Docker Compose" in the guide).
- Fixed: behind a proxy that terminates TLS, the web app counted every
  browser's sign-in attempts as the proxy's, so one client could lock
  everyone out for a minute. Set `PIRC_WEB_TRUSTED_PROXIES` to the
  proxy's address; the Compose setup does.
- The extension is tested with pi 1.5.2 as well as 1.0.0.
- `SECURITY.md` says what PiRC trusts by design.
- An iOS app built from source under another bundle ID no longer asks
  for notifications, which only the publisher's app can receive.

## 0.3.4 (2026-11-14)

- Fixed, in the web app's server: Hono 4.13.18 and @hono/node-server
  2.1.8, for GitHub's advisories on them that reach it: a backslash in a
  request path read as a separator when serving the page, an unhandled
  connection reset that could stop the server, and some routes skipping
  middleware.
- The iOS app's team, bundle ID and App Group are set in one file, for
  building it under your own Apple account (`app/README.md`, "Building it
  yourself, on iOS").

## 0.3.3 (2026-11-13)

- The session list shows each session's cost and how much of its context
  is used, in the web app and the apps. Hosts send them from this
  release's extension on; with an older one, the list shows none.
- A message sent while pi works steers by default, as Enter does in pi:
  pi reads it after the step it is on, and only Stop interrupts.
  Alt+Enter queues it for when the whole task is done.
- The repositories are public.

## 0.3.2 (2026-11-12)

- The macOS relays are signed with PiRC's Developer ID and notarised by
  Apple: macOS asks once, then opens them.
- Fixed: a host given a wrong token in `/pirc enrol` asked to be approved,
  instead of saying the token was refused.
- An app built from source has no paywall.

## 0.3.1 (2026-11-12)

- Notifications show replies and questions as plain text, without
  Markdown's marks.
- `pirc-web enrol` says at once, with the reason, when the relay cannot
  be reached, its certificate is not trusted, or the token is wrong.
- The relay makes its registry when it starts, loads its certificate and
  takes its address before saying it listens; the other commands refuse
  a data directory without a registry, naming it.
- The guide, in the order it is followed, after a walk through it on a
  clean machine.

## 0.3.0 (2026-11-11)

- The first public release: the relay for Linux and macOS, the web app
  and the pi extension, with `SHA256SUMS`.
