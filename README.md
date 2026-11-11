# PiRC

Remote control for [pi](https://github.com/earendil-works/pi) coding-agent
sessions. Run pi on your machines as you do now, and follow and drive those
sessions from your phone or a browser: read the conversation as it streams,
send prompts and photos, answer pi's questions, stop a turn, start a new
session, and get a notification when a session finishes or needs you.

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

You need a machine to run the relay on, reachable by your other machines
and your phone, with a TLS certificate or a private network such as
WireGuard or Tailscale.

1. **The relay**: download it from the
   [releases](https://github.com/pirc-dev/pirc/releases), for Linux or
   macOS, and run it as a service, as
   [`docs/self-hosting.md`](docs/self-hosting.md) says.
2. **The extension**, on every machine that runs pi:
   `pi install git:github.com/pirc-dev/pirc-extension@vX.Y.Z`, with the
   latest release's tag. Then, on the relay,
   `pirc-relay add-host --url <relay-url> --label <name>` prints the
   `/pirc enrol` line to run in that pi. (A machine can also ask to join
   with `/pirc enrol <relay-url>` alone, and be approved on the relay or
   in a client.)
3. **Your phone**: `pirc-relay add-client --url <relay-url> --label phone`
   prints a `pirc://join` link and its QR code. Scan it with PiRC's app,
   built from [`app/README.md`](app/README.md) until it is in the App
   Store and Google Play. Once one client has joined, it can invite the
   others.
4. **The web app**, if you want one: [`docs/web.md`](docs/web.md).

Phones are woken for notifications through PiRC's push gateway,
`https://push.pirc.dev`, which passes no content: the phone then reads its
relay and writes the notification itself
([`docs/gateway.md`](docs/gateway.md)).

## Status

Early, and in daily use. The protocol is `v1alpha1` and may still change;
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
gateway, in Go), `protocol/` (generated TypeScript types), `relay-client/`
(login and reconnection, shared by every TypeScript peer), `extension/`
(the pi package), `web/` (the web app), `app/` (the mobile app, Flutter),
`cases/` (test cases shared by the web and mobile apps), `test/` (the
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
  `relay/internal/server`, `relay/internal/registry`) and the web app
  (`web/`).
- **GPL-3.0 only**: the mobile app (`app/`).

Each of those directories has its licence as `LICENSE`. `NOTICE` lists the
third-party code that releases carry, whose licences are in
`third_party/`. The name PiRC and its icon are covered by
[`TRADEMARKS.md`](TRADEMARKS.md), not by the licences.
