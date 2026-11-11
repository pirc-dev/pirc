# Roadmap

Everything that may come next: first what is planned, in order, then the
rest, most valuable first within each part. Decisions, and the reasons for
them, are in `design.md` (section 12) and `web.md` (section 6); an item
taken up is decided there and stays listed here until it is done.

## Next, in order

Nothing at present: managing the relay's devices from the web app, the
last item, was done on 2026-10-31.

## Web app

1. **The rest of the Triage design** (the mock-up's, not yet built):
   swiping a row left for Seen and Reply (gestures need care beside the
   browser's own back swipe); suggested answers, now that pi's
   questions reach the app; the time each thinking block took (pi does not send it).
   Not taken from its build: the inbox of waiting sessions on top, which
   did not prove useful, and the layouts that differ from Quiet's (a
   compact centred chat header, the model picker as a tall sheet, a glyph
   beside each sheet row), so that both looks stay one page.

2. **Offline sessions readable**: a host that has gone away (a laptop
   asleep) keeps its sessions in the list, marked offline, readable for a
   few days; in the web app and the mobile app together (`design.md`,
   section 12, step 13).

## Smaller

1. **herdr's launcher run against a real herdr.** Built from herdr 0.7.5's
   socket API documentation (`layout.apply`) and tested against a stand-in
   only (`design.md`, section 4).
2. **Stopping a pi that no longer answers**, through another pi on the
   same machine (its tmux pane or herdr tab); today a pi stops only itself.
3. **Pairing attempts logged.** Three pairing links made for devices were
   never used, and the web app's server cannot say why: it logs neither a
   failed attempt nor its reason.
4. **Past sessions open elsewhere marked.** The Resume list does not say
   that a session is open in another pi process; resuming it shows it open
   twice (`design.md`, section 4).
5. **The web app's server recognised among the clients.** The relay could
   send each key's software in `RegisteredKey`, so that both apps can
   recognise the web app's server and warn before removing it, since every
   browser signs in through it; only for both apps together.
6. **A test notification from the app's Settings**, as the web app's, which
   needs a relay request to send one; skipped for now (the owner's choice,
   2026-11-06), since real notifications already show the path works.

## Later

1. **PiRC's mobile app** (`design.md`, section 12, step 13): written new,
   iOS and Android; the adapter it replaces was retired 2026-11-07. Its
   notifications are decided: a push that carries nothing, through a
   gateway at pirc.dev.
   Flutter; a core first (joining, the list and the chat, prompt, stop,
   questions, notifications), in the Native look; decided 2026-11-02.
2. **Hosted relay** (step 14): several tenants, end-to-end encryption,
   device-signed registration.
3. **Open** (step 15): licence, public repository, pirc.dev, store
   listings; planned 2026-11-07, for self-hosters first, ahead of the
   hosted relay.

## Done

- A self-hoster's first phone joins without another client:
  `pirc-relay add-client --url <relay-url>` prints the `pirc://join` link
  and its QR code, `add-host --url` the `/pirc enrol` line (`design.md`,
  section 5.3), 2026-11-07.

- The adapter for the Remote Pi app retired; PiRC's own apps replace it
  (`design.md`, section 12, step 15), 2026-11-07.

- A message sent while pi compacts is held by the extension and sent
  when the compaction ends, as pi's own terminal does, instead of being
  refused (`design.md`, section 8), 2026-10-31.

- Tokens for new devices from the web app: a machine's as the
  `/pirc enrol` line, an app's as a `pirc://join` link and QR code
  (`design.md`, section 5.3), 2026-10-31.

- Removing a device from the web app, a host or a client but not the
  app's own server; a removed host's extension stops asking to join until
  `/pirc enrol` is run there again (`design.md`, section 5.3), 2026-10-31.

- The relay's devices in the web app's Settings, hosts and clients,
  online or not, and renaming one, there or with `pirc-relay label`; a
  host's live sessions show the new name at once (`design.md`, section
  5.3), 2026-10-31.

- The rest of the Quiet, Native and Cockpit designs: headers that fold on
  scroll (Native's translucent), search matches underlined in the list,
  code blocks with their file, and keys on a computer (j/k, n, Esc),
  printed on Cockpit's buttons (`web.md`, sections 5 and 6), 2026-10-30.

- Images in prompts from the web app, shown as thumbnails in the chat
  (`web.md`, section 6), 2026-10-30.
- Context and cost in the chat's header (`web.md`, section 5),
  2026-10-30.
- Keys on a computer: Enter sends and Shift+Enter makes a new line where
  there is a mouse or trackpad (`web.md`, section 6), 2026-10-30.
- Drafts kept: what is being written in a chat survives leaving it or
  reloading, per device (`web.md`, section 6), 2026-10-30.
- Code in replies: highlighted (Quiet in greys, the other looks in their
  colours), with Copy on each block, and Copy on each finished reply
  (`web.md`, sections 5 and 6), 2026-10-30.
- Better tool cards: how long a tool ran (live while it runs), a
  command's exit status, and an edit's diff (`web.md`, section 6),
  2026-10-30.
- pi's questions answered from the web app: an extension's select,
  confirm and input, also in pi's terminal, whichever answers first
  (`design.md`, section 8), 2026-10-30.
- Notifications by web push when a turn finishes, unless a page shows
  that chat (`web.md`, section 6), 2026-10-30.
- Starting and stopping agents from the web app: a new pi beside a
  running one, through tmux, herdr or another extension's launcher; stopping
  a pi (`design.md`, section 4), 2026-10-29.
- Approving new hosts in the web app, by any registered client
  (`design.md`, section 5.3), 2026-10-29.
- pi's session tree: going back to a message, with or without a summary,
  and switching branches (`design.md`, section 4), 2026-10-28.
- The Native and Cockpit looks (`web.md`, section 5), 2026-10-27.
- Fork and clone; past sessions and resume; reload (`design.md`,
  section 4), 2026-10-27.
- From Triage, in both looks: the composer's Queue/Steer switch, folded
  tool calls, the list and the chat side by side on a laptop, cost and
  context in the actions sheet (`web.md`, section 5), 2026-10-26.
- The Quiet design (`web.md`, section 5), 2026-10-26.
- What changed, in the session list, and "New messages" when scrolled up
  (`web.md`, section 5), 2026-10-26.
