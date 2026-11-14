# pirc-extension

The [pi](https://github.com/earendil-works/pi) extension of
[PiRC](https://pirc.dev): it puts every interactive pi session on a PiRC
relay, so that you can follow and drive it from a phone or another
client. You need a relay of your own; PiRC's self-hosting guide covers
running one,
[`docs/self-hosting.md`](https://github.com/pirc-dev/pirc/blob/master/docs/self-hosting.md).

This repository holds releases only: the extension built into one file
(`pirc.js`); `loader.js`, which loads it; and `pi-parts.js`, which hands it
the parts of pi it draws images with. Its source is in PiRC's repository,
[pirc-dev/pirc](https://github.com/pirc-dev/pirc), where issues go too.

## Install

It is tested with pi 1.0.0 and the current pi on every change, and expects
pi 1.0.0 or later in 1.x; outside that, `/pirc status` says so.

pi installs it from this repository with `git` and `npm`. Pin it to a
release:

```sh
pi install git:github.com/pirc-dev/pirc-extension@vX.Y.Z
```

To upgrade, upgrade your relay first, then install the newer tag the same
way. `pi update` keeps a pinned install where it is. Installing without a
tag follows this repository's default branch, and
`pi update git:github.com/pirc-dev/pirc-extension` then moves it to the
latest build, possibly ahead of your relay.

## Enrol

In pi:

```
/pirc enrol wss://<relay-address>:<port>
```

The footer reads "pirc: awaiting approval" until the host is approved: in
PiRC's web app, which lists the hosts asking to join, or on the relay,
where `pirc-relay pending` lists them and `pirc-relay approve <key>` admits
one. Compare the key with the one `/pirc status` shows here: the label is
whatever the host claims.

Or, to skip the approval, issue a host token on the relay first
(`pirc-relay add-host --label <name>`) and give it to the command:
`/pirc enrol wss://<relay-address>:<port> <token>`.

`/pirc status` shows the connection, and `/pirc reconnect` reconnects.
The enrolment is saved in `~/.config/pirc/host.json` (or the file
`PIRC_CONFIG` names), with the host's key beside it in `host.key`; every pi
process on the host uses the same key. `PIRC_RELAY` overrides the relay
URL, and `PIRC_TOKEN` supplies a registration token, so a host can be
enrolled without the command; a relay URL without a token asks for approval.

If the relay's certificate is self-signed or from a private CA, set
`NODE_EXTRA_CA_CERTS` to the CA's PEM file in the environment pi starts in.

## Where pi runs

Clients name a session by the terminal it runs in. In tmux, that is the
tmux session and window (found through `$TMUX_PANE`); in
[herdr](https://herdr.dev), the workspace and tab (through its socket).
The names are checked again whenever pi does something: a prompt, a turn
starting or ending, a client's request. So a window renamed while pi sits
idle shows its new name after pi's next turn.

For any other terminal, or to name sessions your own way, another pi
extension can say where pi runs:

```ts
pi.events.emit("pirc:place", { kind: "zellij", group: "work", window: "api" });
pi.events.emit("pirc:place", { display: "deploys" }); // shown as it is
pi.events.emit("pirc:place", {});   // show nothing
pi.events.emit("pirc:place", null); // back to PiRC's own detection
```

Fields: `kind`, `group` (a tmux session, a workspace), `groupNumber`,
`window` (a window, a tab), `windowNumber`, `pane` and `display`, each
optional; names are cut to 128 bytes. A place given this way stands until
the next one, so the extension can update it whenever it likes.

## Questions

A dialog another extension shows in pi's terminal (`ctx.ui.select`,
`confirm`, `input`) is asked of PiRC's clients too, and whichever answers
first wins: an answer from a client closes the terminal's dialog. An
editor or a custom dialog is shown to clients as waiting, and answered
only in the terminal. This wraps pi's `ui` object, which pi does not
document; if a pi version stops allowing it, `/pirc status` says so.

## Opening new agents

A client can stop a pi, and open a new one beside it: in tmux, a window
after pi's; in herdr, a tab in its workspace, named as the client asks. The
new pi runs in the folder the client chose, with this pi's `PI_*` and
`PIRC_*` settings. Elsewhere,
or to open it your own way, another pi extension can give the launcher:

```ts
pi.events.emit("pirc:launcher", {
  name: "kitty",
  // command is the pi to run; env, the variables to add; name, the
  // window's ("" for none).
  launch: async ({ cwd, command, env, name }) => { /* open it */ },
});
pi.events.emit("pirc:launcher", false); // no launching from this pi
pi.events.emit("pirc:launcher", null);  // back to PiRC's own
```

## Licence

MIT; see `LICENSE`. The bundle includes third-party code, listed in
`NOTICE`, under the licences in `third_party/`.
