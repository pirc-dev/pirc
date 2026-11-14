# Security

Report a security problem privately, by email to security@pirc.dev, not in
an issue. Say what is affected (the relay, the extension, the web app, the
apps or the push gateway), the version, and how to reproduce it if you can.

Fixes go into the latest release only, so check that the problem is still
there in it. Each release's notes say what it fixes.

## What PiRC trusts

These are by design, not vulnerabilities; [`docs/design.md`](docs/design.md)
(sections 5.1 and 6) has the reasons.

- **A client is a shell on every host.** A phone, a browser or the web
  app's server, once joined to your relay, can prompt pi on every host the
  relay admits, and pi runs its tools with the permissions of whoever
  started it. That is what PiRC is for. Where pi runs is your choice: in a
  sandbox, in a virtual machine, or under your own account, accepting the
  risk. A lost phone is removed with `pirc-relay remove`, or from another
  client, and the relay disconnects it within a second.
- **Whoever runs your relay can read everything.** Messages are not
  end-to-end encrypted: TLS, WireGuard or Tailscale protect them in
  transit; the relay's code never reads or logs them, but whoever runs it
  could. On a rented server, so could whoever runs the server. The web app's server reads every message, to
  draw the page, so run it where you run the relay. Join someone else's
  relay only if you would let them read your sessions. End-to-end
  encryption between client and host arrives with the hosted relay.
- **PiRC's push gateway**, `push.pirc.dev`, learns which relay's address
  woke which phone, and when, and nothing about a session: the relay
  sends it only an opaque handle, and the notification it sends carries
  fixed text.
  A relay works without it, but its phones are then not woken.

## Checking a release

From 0.3.7, each release's tag, `vX.Y.Z`, is signed with ssh by a key
listed in [`allowed_signers`](allowed_signers). In a clone:

```sh
git -c gpg.ssh.allowedSignersFile=allowed_signers verify-tag vX.Y.Z
```

prints `Good "git" signature for igor@soarez.org`. The file comes from the
same repository as the tag, so it proves only that a key it lists made
the tag; GitHub marking the tag Verified, against the keys on the
publisher's account, is a second source. A release's downloads are built
from its tag: check them with its `SHA256SUMS` (`shasum -a 256 -c
SHA256SUMS`). The extension's own repository, pirc-extension, does not
sign its tags: to install a checked extension, install it from the
release's `pirc-extension-X.Y.Z.tar.gz` once it matches (the guide's "The
extension" says how).
