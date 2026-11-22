# Roadmap

Everything that may come next: first what is planned, in order, then the
rest, most valuable first within each part. Decisions, and the reasons for
them, are in `design.md` (section 12) and `web.md` (section 6); an item
taken up is decided there, and leaves this list once it is built.

## Next, in order

Nothing at present.

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

1. **Stopping a pi that no longer answers**, through another pi on the
   same machine (its tmux pane or herdr tab); today a pi stops only itself.
2. **Pairing attempts logged.** When a pairing link goes unused, the web
   app's server cannot say why: it logs neither a failed attempt nor its
   reason.
3. **Past sessions open elsewhere marked.** The Resume list does not say
   that a session is open in another pi process; resuming it shows it open
   twice (`design.md`, section 4).
4. **The web app's server recognised among the clients.** The relay could
   send each key's software in `RegisteredKey`, so that both apps can
   recognise the web app's server and warn before removing it, since every
   browser signs in through it; only for both apps together.
5. **A test notification from the app's Settings**, as the web app's, which
   needs a relay request to send one; not planned for now, since real
   notifications already show the path works.

## Later

1. **Hosted relay** (step 14): several tenants, end-to-end encryption,
   device-signed registration.
2. **Open** (step 15): licence, public repository, pirc.dev, store
   listings, for self-hosters first, ahead of the hosted relay.
3. **A daemon on the host, optional**: installed on request, so that a
   client can start a new session on a host while no pi, and so no
   extension, is running there. Today a new pi can only be opened beside a
   running one, through its terminal (`design.md`, section 4), and
   `design.md` lists a daemon as out of scope (section 1) and says "There
   is no daemon" (section 4); taking this up means deciding those two
   statements first: what the daemon is allowed to start, how it joins the
   relay under the host key, and how it is installed, started at login and
   removed on Linux and macOS.
