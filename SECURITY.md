# Security

Report a security problem privately, by email to security@pirc.dev, not in
an issue. Say what is affected (the relay, the extension, the web app, the
apps or the push gateway), the version, and how to reproduce it if you can.

Fixes go into the latest release only, so check that the problem is still
there in it. Each release's notes say what it fixes.

What PiRC promises, and what it does not yet, is in
[`docs/design.md`](docs/design.md): in this version messages are not
end-to-end encrypted, so whoever runs a relay can read what passes through
it. That is known, not a vulnerability.
