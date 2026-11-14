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
