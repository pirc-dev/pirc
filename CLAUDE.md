# CLAUDE.md

Guidance for working in this repository.

## What this is

PiRC: remote control for pi coding-agent sessions, as an independent product
(pi extension, relay, clients). `docs/design.md` is the source of truth for
scope and decisions; read it before changing anything substantial, and update
it when a decision is made or changed.

## Rules

- **An independent product.** Nothing here may assume a particular deployment:
  no host names, private addresses, VPNs or secret stores of any one
  installation. Configuration comes from outside. The publisher's own
  identifiers are the product's, not an installation's, and may appear,
  such as the Apple developer team, the Firebase project and its app
  config, `pirc.dev`, `push.pirc.dev` and the company's contact address. Test fixtures use neutral names, not
  the owner's machines.
- **Decisions are recorded.** A choice that changes scope, protocol, identity,
  trust or stack goes into `docs/design.md` with its reason, in the same
  change. Open questions stay marked as open until they are decided.
- **The protocol is defined once.** Message types live in one schema, and each
  language's types are generated from it; never hand-write a second copy.
- **Reuse is deliberate.** Code adapted from another project is recorded under
  "Reuse and attribution" in `docs/design.md`, keeps that project's copyright
  notice, and is listed in `NOTICE` once there is one. Prefer writing our own
  where the saving is small.
- **pi's API is the constraint.** Before designing a feature around pi, check
  what pi's extension API actually offers in the installed version; the
  feasibility table in the design records what has been verified, and which
  calls are available only to command handlers.
- **A page change is seen working.** Beyond the checks, run the web app
  locally and look at the change in a browser: `docs/testing.md` says how,
  with no passkey needed.
