# PiRC

Remote control for [pi](https://github.com/earendil-works/pi) coding-agent
sessions. Run pi on your machines as you do now, and follow and drive those
sessions from your phone or a browser: read the conversation as it streams,
send prompts and photos, answer pi's questions, stop a turn, start a new
session, and get a notification when a session finishes or needs you.
The website is [pirc.dev](https://pirc.dev).

PiRC attaches to pi; it does not run pi for you. Run pi in tmux or herdr
and PiRC also shows where each session runs and can open new ones beside
it.

## How it works

```
 pi + PiRC extension ─┐                 ┌─ PiRC app (iOS, Android)
 pi + PiRC extension ─┼──►  relay  ◄────┼─ web app (self-hosted)
 pi + PiRC extension ─┘                 └─ …
```

- **The pi extension** puts every pi session on the machine on a relay.
- **The relay** is the one place every machine and every client connects
  to, each dialling out, so nothing needs to reach your machines. Each
  registers with it once. One relay is one account: every client it admits
  sees every machine it admits.
- **The clients**: PiRC's app for iPhone, iPad and Android, and a web app
  you run yourself.

In this version the relay can read what passes through it: messages are
not yet end-to-end encrypted. Run it yourself, on a machine you trust.

## Getting started

The shortest way needs one machine with Docker and a public DNS name, with
ports 80 and 443 open. Without Docker, on macOS, or on a private network
such as Tailscale, follow [`docs/self-hosting.md`](docs/self-hosting.md)
instead.

1. **Start the relay and the web app.** In `docker/`, in a clone of this
   repository checked out at the latest
   [release](https://github.com/pirc-dev/pirc/releases)'s tag, run the
   commands in
   [With Docker Compose](docs/self-hosting.md#with-docker-compose). The
   last one prints a link: open it and make a passkey. The web app is now
   your first client.
2. **Install the extension** on every machine that runs pi, from npm:

   ```sh
   pi install npm:pirc-extension@X.Y.Z
   ```

   Use the latest release's version. Installed from git before, `pi remove
   git:github.com/pirc-dev/pirc-extension` first.
3. **Join each machine.** In pi, run `/pirc enrol wss://<your name>`. The
   machine appears at the top of the web app's session list, asking to
   join. Approve it once its key matches the one `/pirc status` shows in
   pi.
4. **Add your phone.** In the web app's Settings, "Add an app" shows a
   code. Scan it with PiRC's app ([`app/README.md`](app/README.md)).
   The iPhone and iPad app is on the
   [App Store](https://apps.apple.com/app/id6830395005), and the Android
   app on [Google Play](https://play.google.com/store/apps/details?id=dev.pirc.app).

Phones are woken through PiRC's push gateway, `push.pirc.dev`. It learns
which relay woke which phone, and when, and nothing about your sessions
([`SECURITY.md`](SECURITY.md)).

## Status

Early: the protocol is `v1alpha1` and may still change;
each release, tagged `vX.Y.Z`, has the relay and the web app to download
and the extension to install with pi. [`docs/roadmap.md`](docs/roadmap.md) says
what comes next, and [`docs/design.md`](docs/design.md) what is decided
and why.

## Documents

- [`docs/self-hosting.md`](docs/self-hosting.md): the relay and the
  extension, installed, upgraded and backed up.
- [`docs/web.md`](docs/web.md): the web app.
- [`app/README.md`](app/README.md): the mobile app, built from source.
- [`docs/gateway.md`](docs/gateway.md): the push gateway.
- [`docs/design.md`](docs/design.md): the design, its decisions and the
  plan.
- [`docs/testing.md`](docs/testing.md): checking a change to the web app.

## Development

Needs Node 24 (with corepack) and Go 1.24; Flutter for the mobile app.

- `sh/check.sh` runs every check: Buf format, lint and breaking; code
  generation; Go vet and tests; that the push gateway links no AGPL code;
  TypeScript, and the web page's build; a Go/TypeScript wire round trip;
  the TypeScript unit tests; the mobile app's, when Flutter is on `PATH`,
  and its notification extension's, when Swift is; and two end-to-end
  tests (the relay, an interactive pi in tmux with the
  extension and a scripted fake model, and a test client; then the web
  app's server, used as a browser uses it), which need `pi` and `tmux`.
  Run it before pushing; GitHub runs it on every push too, with the
  mobile app's checks on macOS.
- `sh/generate.sh` regenerates the protocol's code from `proto/`; the
  output is not committed.

Layout: `proto/` (the protocol), `relay/` (the relay and the push
gateway, in Go), `protocol/` (generated TypeScript types), `e2e/` (the hosted account's
device list and its check, in TypeScript), `relay-client/` (login and
reconnection, shared by every TypeScript peer), `extension/` (the pi
package), `web/` (the web app), `app/` (the mobile app, Flutter),
`cases/` (test cases the clients share: the web and mobile apps' client
logic, notifications, and the hosted account's pieces), `test/` (the
end-to-end harness).

Issues are welcome; pull requests are not taken for now
([`CONTRIBUTING.md`](CONTRIBUTING.md)).

## Licence

Copyright Justino Ltd. Three licences, by part:

- **MIT** (`LICENSE`): the pi extension (`extension/`), the code it shares
  with clients (`proto/`, `protocol/`, `relay-client/`, `cases/`), the
  push gateway (`relay/cmd/pirc-gateway`, `relay/internal/gateway`) and
  everything else without a licence of its own.
- **AGPL-3.0 only**: the relay (`relay/cmd/pirc-relay`,
  `relay/internal/server`, `relay/internal/registry`,
  `relay/internal/hosted`) and the web app (`web/`).
- **GPL-3.0 only**: the mobile app (`app/`).

Each AGPL and GPL directory has its licence as `LICENSE`. `NOTICE` lists the
third-party code that releases carry, whose licences are in
`third_party/`. The name PiRC and its icon are covered by
[`TRADEMARKS.md`](TRADEMARKS.md), not by the licences.
