# Changelog

What each release changes for people running PiRC. A release is the
relay, the web app and the pi extension, built from one commit
(`docs/self-hosting.md`); what the apps gain from it is said with it.
Upgrade the relay first, then the rest (Upgrading, in the guide). A
release that needs its parts upgraded together says so here.

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
