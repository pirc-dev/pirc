# PiRC design

Status: **draft**. Started 2026-10-17; reviewed 2026-10-20 (section 13).
Sections marked **Open** are not decided; everything else is a proposal until
the table below says it is decided.

## 1. What PiRC is

Remote control for pi sessions. A person runs pi on one or more machines; PiRC
lets them see and drive those sessions from a phone, and later from a browser
or a desktop app: read the conversation as it streams, send prompts and images,
and do what they would otherwise do at the terminal -- switch model, rename,
compact, start a new session, fork or clone it, resume a past one, reload
pi's resources, check cost.

**In scope**

- Remote control of interactive pi sessions, one person's or one team's.
- Clients on iOS and Android first; web and desktop later.
- A relay that clients and hosts each register with once, instead of pairing
  every client with every host.

**Out of scope**

- Agent-to-agent messaging or any agent mesh.
- Running or supervising pi sessions on the host (daemons, schedulers, a
  desktop IDE). PiRC attaches to pi sessions; it does not own them. Keeping a
  session alive across a closed terminal is the job of tmux or similar. A
  client may stop a pi, and open a new one beside a running pi (decided
  2026-10-29, section 4), but through that pi and its terminal: tmux or
  herdr owns the new window, and nothing of PiRC's runs without a pi.
- Agents other than pi.

## 2. Decisions

| Topic | State | Decision |
|---|---|---|
| Name | decided | PiRC; domain pirc.dev |
| Hosting | decided | a private repository until it is good enough to open, then public. 2026-11-07: on GitHub, in its own organisation, `pirc-dev`, not the owner's account, starting from one commit of the tree as it is then, which the private repository's main branch also starts from, its history archived (section 12, step 15) |
| Scope | decided | section 1 |
| Upstream relationship | decided | a new project, not a fork; adapted code is attributed (section 11) |
| Licence | decided | 2026-11-07: open source by part, the copyright Justino Ltd's: MIT for the extension, the code it shares with clients, the push gateway and the rest of the tree; AGPL-3.0 for the relay and the web app; GPL-3.0 for the mobile app; the names under a trademark policy (section 12, step 15). Before that: MIT but for the adapter (retired 2026-11-07) and the web app, proprietary for now (2026-10-25). Adapted MIT code keeps its notice and is listed in `NOTICE` |
| Distribution | decided | the extension published as a pi package in its own public repository from step 9, ahead of this one: its default branch follows this repository, releases are tags. Since 2026-10-25 only the extension is released; the relay, the adapter and the web app are built from any commit (`sh/build.sh`), and a deployment may follow the main branch. The adapter not published; no container image yet (section 12, step 9). 2026-11-07: the adapter retired (section 12, step 15). 2026-11-08: the relay and the web app released again, on GitHub, for self-hosters to download (section 12, step 15) |
| Session identity | proposed | section 4 |
| Where a session runs | decided | 2026-10-25: the extension announces the terminal pi runs in (tmux session and window, herdr workspace and tab), detected built in or given by another pi extension through `pirc:place`. 2026-10-27: clients title a session by pi's name for it, else its first message, else its folder, and list them below the tmux session or herdr workspace, the most recent first, each under its window's or tab's name (section 4). 2026-10-29: clients stop a pi, and open a new one beside a running pi through its tmux, herdr, or a launcher another extension gives through `pirc:launcher` (section 4) |
| Account model | decided | one relay is one account; the relay registers clients and hosts, and every client sees every host (section 5) |
| Relay visibility | decided | plaintext payloads in the first version; envelope and payload kept apart, the relay never reads or logs payloads; end-to-end encryption arrives with a hosted relay (section 5.1) |
| Transport security | decided | TLS by default; plaintext only by an explicit relay setting, for networks that already encrypt (section 5.1) |
| Host enrolment, revocation | decided | section 5.3, 5.5: a one-time token, or (2026-10-24) approval by the relay's operator of a host that connects without one; tokens built in relay v0 (section 12, step 4), approval in 0.1.3. Approval on the client too, by any registered client: in the web app since 2026-10-29 (section 5.3). Renaming, removing and issuing tokens on the client too, decided 2026-10-31 and built in the web app the same day (section 5.3) |
| First client | decided | the unmodified Remote Pi app, through an adapter (section 10). Retired 2026-11-07: PiRC's own web and mobile apps replace it, and the Remote Pi app is no longer supported (section 12, step 15) |
| Protocol definition | decided | one schema, types generated per language (section 7) |
| Transport | decided | WebSocket, every party dialling out to the relay (section 7) |
| Extension language | decided | TypeScript: pi's extension API and types are TypeScript |
| Web app | decided | 2026-10-25: PiRC's first own client, a web app with a backend for the browser (BFF) that is an ordinary client of the relay, built from any commit and deployed on its own; passkey sign-in; for self-hosting only (`docs/web.md`, section 12, step 12). 2026-11-02: it stays so; the hosted relay later gets a web client that is its own client of the relay (section 12, step 13) |
| Mobile app | decided | 2026-11-02: an Ed25519 key per phone, on that phone only; released by Face ID or the PIN, on by default; a second, read-only key for notifications; recent chats kept on the phone; a core first (joining, the list and the chat, prompt, stop, questions, notifications), replacing the Remote Pi app; the Native look (section 12, step 13) |
| Client toolkit | decided | 2026-10-25: React and TypeScript for the web app. 2026-11-01: Flutter for the mobile app, with `web/core` ported to Dart and kept in step by test cases both run; nothing is adapted from Remote Pi's (section 12, step 13) |
| Notifications on phones | decided | 2026-10-31: a push that carries nothing wakes the phone, which reads the session list from the relay and writes its own notification from the notice the host put in the announcement; pushes go through a gateway at pirc.dev, open to every relay (section 12, step 13) |
| Relay language | decided | Go (section 9) |
| Schema and encoding | decided | Protocol Buffers, binary frames, with the Buf toolchain (section 7) |
| Images in pi's terminal | decided | 2026-11-06: a client's images are shown in pi's own chat, after their message, as pi draws a tool's images, by a custom entry that does not reach the model or clients (section 8) |
| Model persistence | decided | a model chosen remotely is the session's: resuming the session brings it back, but pi's default for new sessions is unchanged, since the extension API cannot change it (section 8) |

## 3. Background: Remote Pi

[Remote Pi](https://github.com/jacobaraujo7/remote_pi) (MIT, Jacob Moura) does
the same job and is the reason for most of the choices here. As of its commit
9db49035 (2026-10-11):

- **Its mobile app, relay and pi extension are frozen.** Of 236 commits since
  2026-09-01, 220 are in Cockpit, its desktop client (which has its own server
  and SSH transport), and none touch the mobile app, relay or pi extension. The
  extension is typed against pi 0.79 while pi is at 1.0.
- **An agent's identity is its display name.** Mesh addresses are
  `<cwd>@<name>` and the app's relay room is derived from `(cwd, name)`, with
  the name saved per folder. So two sessions in one folder collide (`name#2`),
  and a rename moves the conversation to a new room. Its sync of pi's session
  name into that identity was added (commit 211335f6) and removed again in PR
  #57 (commit 3dc880cd); the author's experience was that other extensions set
  temporary session names that became permanent identities (the reason is not
  in the commit messages).
- **Pairing is per host.** Each host learns each client's key by QR code;
  owner-key sync between a person's devices works only within one ecosystem
  (iCloud Keychain or Android Block Store).
- **The agent mesh dominates the extension.** Its mesh, daemon, MCP and
  session-broker modules are about 8,500 of 16,900 non-test source lines, and
  a 5,400-line `index.ts` ties them to the remote-control path.
- **Types are hand-written in three languages** (TypeScript, Dart, Rust), so
  every protocol change is three changes.
- **What is good:** the Flutter app's UI layer (~11,400 lines: chat, markdown,
  tool-call cards, model picker, voice and image input). Its view models import
  the data layer directly, so reuse is judged screen by screen. And the relay's
  generic peer registry and rooms.

## 4. Identity

Proposed:

- **A session is identified by pi's session ID**, not by its name or folder.
  pi keeps the ID across resume: opening a session file takes the ID from the
  file's header; IDs are UUIDv7. A session's start time is the header's
  `timestamp`, written once. Both confirmed by running pi (2026-10-20).
- **A pi process can change session.** `/new`, `/resume`, `/fork` and `/clone`,
  at the terminal or through PiRC, replace the process's session with another
  ID (`session_shutdown`, then `session_start` with `reason` `new`, `resume` or
  `fork` and the previous session file). The extension ends one session on the
  relay and announces the other, and the announcement says which session it
  replaced, so a client can follow a process from session to session.
- **A pi process has an instance ID**: random, made when the extension's module
  is first evaluated, so it survives session changes (pi re-runs the
  extension's factory on a replacement but does not re-evaluate its module).
  Every announcement carries it.
- **The name is display only**: `getSessionName()`, followed through pi's
  `session_info_changed` event. Renames, by the person or by an extension, cost
  nothing: no new room, no lost conversation.
- **Every announcement carries the session's latest notice** (built
  2026-11-03, for notifications, section 12, step 13): what a client that
  notifies would tell the person of. The extension raises one when a turn
  ends, other than by an abort (`FINISHED`, with the reply's text, or
  `FAILED`, with the error), and when pi starts showing a question
  (`QUESTION`, its title and message; one already showing when the session
  started raises none). The reply and the question are made plain text
  first, since a notification shows no markup (2026-11-12; until then their
  Markdown showed as written): the marks of headings, quotes, lists, rules
  and tables dropped, a link and an image as their text, emphasis and code
  without their marks, a heading followed by a colon. The text has runs of
  whitespace made one space and is cut to 120 Unicode code points, "…" included, so that no character is
  split; the client writes the title and the rest. Its number is the time
  it was raised, in milliseconds, one past the last if the clock went back,
  so it goes up across pi processes too (a restart, or `/resume` back to
  the session), where a counter would start again and a phone that keeps
  the last number it showed would miss what came next. Each process raises
  notices for its own turns only. The extension keeps a session's notice,
  as it keeps its sequence numbers, when it comes back to it in the same
  process, and across a reload of the extension.
- **A host** is one machine running the extension, with its own key, stored
  at a configurable path and written once, atomically, at enrolment. Every pi
  process on the host runs its own copy of the extension and opens its own
  connection to the relay under the host key; the relay's unit is the
  triple (host key, session ID, instance ID). There is no daemon (section 1).
- **A client** is one app install or browser, with its own key.
- **An account** groups the hosts and clients of one person (see section 5).

Within this:

- **A forked or cloned session (decided 2026-10-24): the client follows the
  process.** `/fork` and `/clone` keep the pi process and move it to a new
  session, as `/new` and `/resume` do; a client lists live processes, so
  the fork continues in the same entry, showing the new session, and the
  parent is no longer live unless another process resumes it, or a client
  resumes it from the list of past sessions.
- **Fork and clone from a client (decided 2026-10-27).** Two actions, as
  pi's own commands: `Fork` before one of the user's messages, named by its
  entry ID, which leaves that message out, and `Clone` of the session as it
  is. They run through PiRC's commands `/pirc:fork <entry>` and
  `/pirc:clone`, as `NewSession` runs through `/pirc:new` (section 8), and
  are answered the same way, when pi shuts the old session down (reason
  `fork`). The extension checks first everything pi's fork would refuse,
  since pi exits on its error (section 8). pi does not hand an extension the
  forked message's text, but a client has it: the web app puts it back in
  its input box, as pi's terminal does (pi puts it in its own editor too).
  The web app offers a fork from tapping one of the user's messages, and
  Clone in the session's actions. The adapter (retired 2026-11-07) had
  neither: the Remote Pi app asked for no such thing.
- **Past sessions and resume from a client (decided 2026-10-27).** A client
  asks a live session for the sessions pi has saved (`ListPastSessions`), as
  pi's `/resume` lists them: those started in the session's folder by
  default, or every folder's when asked, newest change first, the session
  itself left out, cut to fit one frame. Each carries its file's path, pi's
  session ID, folder, name, first prompt, times and message count. `Resume`
  names one by path and moves the process to it, through `/pirc:resume
  <path>`, answered when pi shuts the old session down (reason `resume`);
  the session is announced with origin `RESUME`. Only a session that list
  would hold is taken, since pi exits on most errors its switch meets
  (section 8). Resuming a session from another folder moves pi to that
  folder, as pi's `/resume` does. A session open in another pi process may
  be resumed too, and is then shown open twice (above). The web app has
  Resume in the session's actions: this folder's sessions, with a switch to
  every folder's. The adapter had neither.
- **Reload from a client (decided 2026-10-27).** `Reload` does what pi's
  `/reload` does: pi reads its extensions, skills, prompt templates,
  themes and context files again, and the session carries on, as at the
  terminal (section 12, step 5: requests meanwhile get `BUSY`, and the
  session is announced again when it is back). It runs through
  `/pirc:reload` and is answered `Accepted` when pi shuts the session down
  for the reload, as a replacement is answered when its shutdown comes,
  not when the reload is done: after an update the new code takes the
  session over, and what the old code waits for is not handed across.
  The web app has Reload in the session's actions. The adapter had
  neither.
- **pi's session tree from a client (decided 2026-10-28).** pi's `/tree`
  moves a session to another point of its tree, in the same file: at one
  of the user's messages, to just before it, and pi puts its text back in
  its editor; at any other entry, to just after it. What it leaves stays in
  the file as a branch, to come back to. `NavigateTree` names an entry,
  and with `summarize` pi first summarises the branch left, with its
  default instructions, as a branch summary entry at the new point, which
  clients show as a card, as they show a compaction (pi's text starts with
  a preamble of its own, kept: it is what the model reads). `ListTree`
  gives the branches: the current one first, then every other path to an
  entry with nothing after it, newest first, each by its first prompt
  after it leaves the current branch, its last message, its time and its
  message count; one with no message of its own there (a model change made
  after going back) is left out. It runs through `/pirc:tree <entry>
  [summarize]`, since `navigateTree()` is open only to command handlers, and
  is answered when the command has run, not by a shutdown: the session
  stays. It is refused `BUSY` while the agent works (pi refuses an
  extension's move then, where its own `/tree` stops the turn first) or
  compacts; while pi summarises, the session is announced compacting, as
  pi counts a branch summary as compacting; a prompt sent meanwhile is
  held, as one sent during a compaction is (section 8).
  Any move in the tree, a client's or one made at pi's terminal, is
  broadcast as a `BranchChanged` event, and a client asks for history
  again, since the conversation it has is no longer the session's. The web
  app offers going back, with or without a summary, beside the fork from
  tapping one of the user's messages, and puts the message back in its
  input box; Branches in the session's actions lists the others, to switch
  to one, again with or without a summary. Custom instructions for the
  summary are not offered yet. The adapter had neither, and did not follow
  a move made at pi's terminal: the app's room showed the old conversation
  until it was opened again.
- **Where a session runs (decided 2026-10-25).** People run pi in tmux, in
  herdr, or in other multiplexers, and there the names they gave their
  windows and tabs are what tells one agent from another; a folder and a
  model do not. The announcement carries a `place`:
  - **Structured**: the multiplexer (`tmux`, `herdr`, or another an
    extension names), the group (tmux session, herdr workspace), the window
    (tmux window, herdr tab) and the pane's label, each with its number
    where it has one; or **a display string** alone, for a place whose
    structure the extension does not know.
  - **Built in**, detected from the environment: tmux by `$TMUX_PANE` (one
    `tmux display-message` for the names), herdr by `HERDR_ENV` (its socket:
    `pane.current` for the pane's workspace and tab, then their labels). Other
    multiplexers (zellij, wezterm, kitty) are left to extensions.
  - **Given by another pi extension**, through pi's inter-extension events:
    `pirc:place` with fields replaces the built-in detection for that
    process until the next event, an empty place shows nothing (the way to
    turn it off), and `null` hands back to the built-in detection. So the
    customisation lives in extensions, not in PiRC's configuration: a few
    lines in a person's own extension, or in herdr's pi integration upstream.
  - **When it is checked**: on activity only (the session starting or
    changing, a prompt, a turn starting or ending, a reconnect, a request from
    a client), never on a timer, and announced only when it changed. An idle
    session whose window is renamed shows the old name until it next does
    something; an extension that gives the place can update it whenever it
    likes.
  - **Clients** (until 2026-10-27; see the next item) title a session by its window or tab name, or the display
    string, with pi's session name, folder and model beneath; without a
    place, as before. The web app lists sessions flat under their host for
    now; grouping them by tmux session or herdr workspace is wanted later,
    and the structure is there for it. The adapter named a new room
    `<host>: <window or tab>`.
  - **Names and windows (2026-10-27).** A tmux window or herdr tab can
    hold several panes, each with its own pi, so it cannot name a session.
    Clients title a session by pi's own name for it (`/name`, `--name`, or
    an extension's), else by the first line of its first message, as pi's
    own session list does, else by its folder; the extension announces
    that first line (`first_prompt`), since a client's history can start
    later. The web app lists a host's sessions by tmux session or herdr
    workspace, the most recent first, each with its window's or tab's name
    above its own (since 2026-10-27, replacing a heading over a window's
    sessions in the terminal's order, which read as naming only the first). The
    adapter (retired 2026-11-07) named a new room `<host>: <name>` the same
    way, but with the window before the folder: a new session's room was
    named before its first message, and the app kept a room's first name.
    Rejected: pi's name on a line under the window's (the window would
    still look like the session's name).
  Rejected: a display string only (clients could not group), a setting in
  `host.json` for a custom command (customisation belongs in extensions),
  polling every few seconds (a loop in every pi process for a rare case),
  tmux hooks (they would change the person's tmux configuration).
- **Stopping and starting agents (decided 2026-10-29).** A client can end
  a pi process, and open a new pi beside one that runs, so that agents are
  started and stopped from a phone; it works on any machine with a
  connected pi, and how the new pi opens can be changed per process.
  - **Stop** (`Stop`): the pi stops itself, with pi's own `shutdown()`, as
    quitting it at its terminal does; refused while pi is working. It is
    answered first, then pi exits a moment later; a client counts the
    session ending before the answer as stopped. A window whose command was
    pi closes; a shell it ran from stays. A pi that no longer answers
    cannot be stopped this way: that would need another pi on the machine,
    left for later.
  - **Launch, beside a running pi** (`Launch`): the client asks a pi to
    open another in its own tmux session or herdr workspace, which it can
    reach (its tmux server through `$TMUX`, herdr through its socket), so
    machines that mix terminals need no setting, and a machine with no
    connected pi offers nothing. Rejected for the first version: choosing
    any terminal on a machine, or a new tmux session.
  - **The launchers**, built in: tmux, a new window after pi's, in the
    background (`new-window -d -a`, on the window of `$TMUX_PANE`); herdr, a
    new tab in pi's workspace, not focused (its `layout.apply`, from its
    0.7.5 documentation; not yet run against a real herdr). herdr's is
    tried first, as for the place. Nothing is built in for a plain
    terminal emulator, which has no general way to open a window.
  - **Given by another extension**, the way `pirc:place` gives the place:
    `pirc:launcher` with `{ name, launch({ cwd, command, env, name }) }` replaces
    the built-in launcher for that process, `false` turns launching off,
    and `null` hands back. The announcement says the launcher's name
    (`launcher`), and clients offer a new agent only where a pi has one.
  - **The new pi** runs this pi's own runtime and entry point (pi from the
    `PATH` if that cannot be found), with no arguments: a new session. It
    gets this pi's `PI_*` and `PIRC_*` variables, so that it uses the same
    agent folder and relay, but not `PIRC_TOKEN`, nor `PI_CODING_AGENT`,
    which pi sets for what it runs, and `PIRC_LAUNCH`, the request's ID,
    which it announces (`launch_id`) so that the client that asked opens
    its chat once it connects.
  - **The folder**: the client offers the pi's own first, then those of the
    machine's other live and saved sessions (from `ListPastSessions`), or a
    path typed in; a leading `~` is the home directory, and one that is
    not an existing folder is refused (`INVALID`). A past session is
    resumed from the new pi's menu, not at launch.
  - **The window's name** (decided 2026-10-30): the client names the new
    tmux window or herdr tab (`Launch.name`), by default after the
    folder's last part, which the person can change; tmux would otherwise
    name it after its command, `node` where pi runs under node. Naming it
    turns tmux's automatic renaming off for that window, as naming a
    window by hand does; an empty name leaves it to the terminal. A
    launcher from another extension gets the name to use or ignore.
- How a client shows **one session open in two pi processes**. pi has no lock
  on session files. Run on 2026-10-20: two processes appending to one file
  leave it valid line by line, but each writes its own branch from the same
  parent and sees only its own; reopening the file follows the branch written
  last, and the other survives only as a side branch in pi's tree. PiRC shows
  them as two live entries (distinct instance IDs, same session ID), marked
  as open twice; prompting either is allowed.

## 5. Registration and trust

Decided 2026-10-18, except where marked. The model comes in two stages.

- **Self-hosted relay, first.** Open source; a person (or a team) runs their
  own relay, on a private network such as WireGuard or Tailscale or on a
  server of their own. **One relay is one account.** Clients and hosts each
  register with the relay once, each with its own key, and every registered
  client sees every session on every registered host. There are no other
  tenants.
- **Hosted relay, later.** A relay offered to others (possibly at pirc.dev)
  holds many accounts. It brings multi-tenancy, end-to-end encryption and
  device-signed registration (below), none of which the first version needs.

The questions, as settled:

1. **What the relay may see.** First version: **payloads in plaintext**. The
   protocol keeps a routing envelope (account, host, session ID, instance ID, frame type,
   size) apart from the payload from the start, and **the relay never reads
   or logs payloads**: a hard rule of its code, so no relay feature comes to
   depend on plaintext and no debug log holds a prompt. What the relay needs
   for the session list (names, folders, models) travels as payload: the host
   publishes an opaque announcement per session, and the relay stores the
   latest one and replays it to clients without reading it, so a hosted relay
   will not see session names either. End-to-end encryption between client and
   host arrives with the hosted relay, as a change to payloads only.

   **Transport security**: TLS is the relay's default. Plain `ws://` is an
   explicit relay setting, for networks that already encrypt (WireGuard,
   Tailscale), so they need no second layer.

   Reasons: on a relay you run yourself the operator is you, so end-to-end
   encryption protects little there; users of overlay networks wanted no
   second layer of encryption; and the first client (section 10) spoke
   plaintext and could not do otherwise. A self-hosted relay on a rented server
   reached over the internet is still covered by TLS. This replaces a
   decision of 2026-10-17 for end-to-end encryption from the start, made
   before the self-hosted, single-account shape and the Remote Pi app were
   settled.
2. **What an account is.** On a self-hosted relay, the relay itself: its list
   of registered client and host keys. **The relay approves registrations**
   and hosts trust its list. That is sound only because the relay is the
   person's own. On a hosted relay, the relay must not be able to add keys to
   an account (it could add its own and read everything once payloads are
   encrypted), so there the account becomes a **device-signed list**: a short
   versioned list of device keys, a new version valid only when signed by a
   device in the previous one; the relay stores and serves it but cannot forge
   it. Device keys and the key format are the same in both stages, but the
   second stage is real work: hosts must fetch, verify and enforce the list,
   keep anti-rollback state across restarts, and clients must verify hosts;
   the first device's bootstrap and recovery when every device is lost need
   designing then. Remote Pi's `mesh_versions` is a reference.
3. **How a host enrols** (approval decided 2026-10-24). Either way works:
   - **With a token.** The relay operator issues a one-time token (a relay
     command), and the host's extension is configured with the relay URL and
     that token on first run, then authenticates with its own key.
   - **By approval.** The extension is configured with the relay URL only.
     It logs in with its key and no token; once the challenge proves it
     holds the key, the relay records a request (the key, the label and
     software it gave, the address it came from, below) and answers
     `APPROVAL_PENDING`. The host asks again every 10 seconds, its footer
     reading "awaiting approval". The operator lists the requests
     (`pirc-relay pending`) and approves one by its key
     (`pirc-relay approve <key>`, at least 16 characters of it) or
     rejects it; the host's next attempt logs in.

   Enrolment decides which account a host belongs to, and so whose clients
   show its sessions and send it prompts; host keys already stop one host
   passing for another. A token proves that by having been delivered to the
   host; approval proves it by the operator comparing the key in the
   request with the one the host shows (`/pirc status`). The label proves
   nothing: it is whatever the host claims. Only hosts can ask: a client
   without a token is refused as before.

   **Reusable client tokens** (2026-11-10): `add-client --reusable`, from
   the relay's command only, gives a token that up to `--max-uses` apps
   (20 by default) can join with until it expires, each registered as its
   label with a number (`reviewers-1`, `reviewers-2`, numbered on past any
   key so labelled already), and `pirc-relay revoke <label>` ends it,
   leaving the apps it let in to be removed by those labels, after it. It
   exists for store review, which wants sign-in details that are
   "reusable" and work at any time, for several reviewers and devices:
   each store gets a link of its own, so that what each store's reviewers
   did can be told apart, and one revoked alone if abused. A label is
   needed, and no other live token may share it, since it is how the
   token is named. Tokens a client asks for (5.3, the web app's "Add an
   app") stay one-time. Every app such a token lets in is a full client,
   which on an ordinary relay could approve a computer of its own; so a
   relay can be **closed to hosts** (`--closed-to-hosts`): none asks for
   approval, and clients get no host tokens, leaving the operator's
   `add-host` the only way in for a computer. The review relay is closed,
   since its links are given to strangers.

   Anyone who can reach the relay can make a request, so they are bounded:
   16 at once (more are refused with `RATE_LIMITED`; a token still
   enrols), each dropped a day after its host last asked, rewritten at most
   once a minute however often the host asks, and logged once. A flood of
   requests can therefore crowd out a real one, but not grow the registry
   or the log, and the token path stays open. Rejecting drops the request;
   a host that keeps connecting asks again, and so does a host whose key was
   removed, which is acceptable since a key costs nothing to make, so a
   block list would stop nobody. (Once removing from a client is built,
   the extension stops asking after its key is removed; below.)

   **The address** a request records, and the relay logs, is the
   connection's own, unless that comes from a proxy the operator listed
   (`PIRC_RELAY_TRUSTED_PROXIES`, decided 2026-10-24 for 0.1.4). Then it is
   the rightmost `X-Forwarded-For` entry that is not itself a listed proxy,
   shown as "<client> via <proxy>". Entries further left were written by
   the client, and a header from anyone unlisted is ignored: trusted from
   any source, the header would let any peer that reaches the relay
   directly, or on the same private network as its proxy, claim any
   address. The list is empty by default. The address decides nothing,
   since approval goes by key; it only helps the operator recognise a
   request.

   Reasons: enrolling becomes "install, then approve" rather than carrying a
   token to the host, which suits section 5.7's "must be easy", and the
   relay half (pending keys, their limits, the protocol's answer) is what
   approval on a client needs too.

   **Approval on the client (decided 2026-10-28, built 2026-10-29).** Any
   registered client may list the hosts waiting, and approve or reject
   one, as the relay's command does: one relay is one account, and a
   client can already run anything on every host (section 6), so a
   narrower right to approve would protect nothing. In the relay's
   protocol, a client watches the list (`WatchPendingHosts`), which the
   relay sends at once and again whenever it changes, found on its
   rereading of the registry every second, so a request expiring or
   decided on the command line is sent too; it approves, under a label of
   its own or the one the host gave, or rejects, by the whole key
   (`ApproveHost`, `RejectHost`), answered with the request's ID
   (`HostDecided`, or `Error`); the relay logs who decided. The web app
   shows each waiting host above the session list ("<label> asks to
   join") and, in a sheet, its whole key beside a word to compare it with
   `/pirc status` on that machine, the address and software it came with,
   and a name for it. The Remote Pi app got none of it: the adapter did
   not offer it (section 10; retired 2026-11-07). With the hosted relay,
   accepting a host becomes a client signing the next version of the
   device list with the host's key in it.

   **Managing devices on the client (decided 2026-10-31; the list and
   all of it built in the web app the same day).** Any
   registered client may also rename, remove and invite devices, hosts and
   clients alike, for the same reason: a client that can already run
   anything on every host gains nothing it could not get by other means.
   This replaces the decision of 2026-10-28 that removing keys and issuing
   tokens stay on the command line. All of it is in the relay's protocol,
   beside approval, so that the mobile app gets it as the web app does;
   the relay logs which client did each.
   - **The list.** A client watches the registered keys (`WatchKeys`): each
     key's role, label, when it was added, whether it is connected and,
     for a client, whether it is registered for push and has a read-only
     key (section 7), sent
     at once and again whenever it changes, as the waiting hosts are.
     Today a client sees a host only through its sessions, so one offline
     or with none could be neither renamed nor removed. The web app shows
     them as two sections of Settings, Hosts and Clients, each online or
     not, its own server first among the clients as "This web app"
     (until 2026-11-03 one "Devices" section); the hosts waiting to join stay
     above the session list, where they are noticed.
   - **Renaming** (`RenameKey`, by the whole key, a label of at most 128
     bytes; `pirc-relay label KEY-PREFIX NAME` on the command line). The
     label changed is the relay's, which clients show; the host's own is
     only what it asks with. The relay takes a host's label when it logs
     in, so on rereading the registry it updates connected hosts and sends
     their live sessions again (`SessionUpdated`) under the new name.
   - **Removing** (`RemoveKey`, by the whole key), as `pirc-relay remove`
     does: the key's connections close at once (section 5.5). The relay
     refuses to remove the key that asks, so that a client cannot cut
     itself off; the web app's server holds one key for every browser,
     which this protects too. A host removed while its pi runs would ask
     to join again within seconds, so the extension stops asking once the
     relay closes it as revoked, its footer saying it was removed, until
     `/pirc enrol` is run there again. The relay closes a removed key's
     connections with WebSocket status 1008 and the reason "key
     revoked", which the shared relay connection takes as final for any
     peer; the extension also records the removal in its configuration
     file, so that a pi started later does not ask either. An extension
     older than this asks to join again. The web app's sheet for a device
     offers removal below renaming, but not for its own server, and asks
     first, saying what removing does.
   - **Tokens** (`IssueToken`: role, label, lifetime; answered with the
     token once, the relay keeping only its hash as now). A client's token
     is shown as a link and QR code carrying the relay's URL and the token,
     valid for 15 minutes as the command's are by default; the mobile app
     joins by scanning it from another client (section 5.4). A host's is
     shown as the `/pirc enrol <relay-url> <token>` line to copy, for a
     machine where nobody will compare keys. A client never stores a
     token it was given. Built 2026-10-31: `IssueToken` takes a lifetime
     of at most 24 hours, 15 minutes when unset, and is answered by
     `TokenIssued` with the token and when it expires. The link is
     `pirc://join?relay=<relay-url>&token=<token>`, both URL-encoded
     (decided 2026-10-31): a scheme of the app's own works for any
     self-hosted relay with no domain to set up, and once the app is
     installed a phone's camera opens it there; without the app, scanning
     it does nothing. The relay URL given is the one the web app's server
     reaches the relay by, which must therefore be one the new device
     can reach too. The web app's "Add a host" and "Add an app" sheets,
     below each section, ask an optional name, then show the line or
     the QR code and link once, with when it expires.

     On the command line too (2026-11-07), for a self-hoster's first
     phone, which has no other client to invite it: `pirc-relay
     add-client --url <relay-url>` (or `PIRC_RELAY_URL`) prints the same
     link on stdout, and on stderr its QR code, drawn in Unicode half
     blocks, black on white from the 256-colour palette's fixed cube so
     that a camera reads it on a dark terminal, with the standard's quiet
     zone, then when it expires; `add-host --url` prints the `/pirc enrol`
     line. Without `--url` both print the token alone, as before, since
     scripts and tests read it so. The code is rsc.io/qr's (BSD-3-Clause),
     at level M; it always uses mask 0, as do the terminal QR codes of
     qrterminal and whatsmeow, which phones read.

     Opened from outside the app (built 2026-11-07): both apps register
     the `pirc` scheme (Android's intent filter for `pirc://join`, iOS's
     URL type), so the phone's camera, or a link tapped elsewhere, opens
     the app with it. It lands on the join screen with the link filled
     in, as if pasted, and joins only when the person taps "Join with the
     link", so that no page or app can join the phone to a relay of its
     choosing; on a phone that has joined already, the app says so and
     changes nothing, since it joins one relay. A link opened while the
     app runs replaces the one in the field. Flutter's own deep linking
     is off, and the app keeps the link nowhere (Android keeps the
     intent that started the app with its task in Recents, readable by
     the system only); its saved state marks the link the app was started
     with as offered, since an activity made again after its process went
     gets that link again, and a link that comes before the app asks is
     held for it, the newest winning.

   The adapter offered none of these either (retired 2026-11-07). With
   the hosted relay each becomes a signed version of the device list.
4. **How a client joins.** The relay issues a one-time registration link or
   code, asked for on the command line or by another client (section 5.3);
   the client registers its own key with it. With the Remote Pi app,
   joining went through the adapter instead (section 10), until it was
   retired on 2026-11-07.
5. **Revocation.** The relay operator, or any client but the one removed
   (section 5.3), removes a key from the relay's list; the relay refuses
   its connections and drops it from routing.
   Phones on the Remote Pi app were revoked in the adapter (section 10),
   until it was retired on 2026-11-07.
6. **One person or several.** One account per relay; anyone registered sees
   everything. Several accounts, and any sharing or permissions, come with the
   hosted relay.
7. **Self-hosting** is the primary way to run PiRC and must be easy: a relay
   running with TLS in minutes, and the extension installed as a pi package. A
   hosted relay is a later product, not part of the first version.

## 6. Security

- **A client can run anything on every host.** A prompt reaches an agent with
  tools that run with the user's permissions. Registering a client is granting
  a shell on every registered host; a lost phone is a lost shell until it is
  revoked.
- **A self-hosted relay is trusted completely** in the first version: whoever
  controls it can read every session and add keys. That is acceptable only
  because it is the person's own (section 5).
- **Keys** live at configured paths, never in a particular installation's
  secret store; the relay's key registry is a file to back up.
- **No payload logging** on the relay; the adapter, until it was retired on
  2026-11-07, logged none beyond what the person asked for when debugging.
- **The adapter**, until it was retired on 2026-11-07, held the phones' keys
  and pairing tokens and acted as one PiRC client for all of them: its own
  key was every phone's access (section 10).
- **The web app's server** likewise holds one client key for every browser,
  and reads every payload. A browser gets in only by a passkey, made through
  a one-time link from the server's command line and asked for again after
  30 minutes idle; every request and stream checks the session cookie and
  the `Origin` (`docs/web.md`).
- **Push for the mobile app** (decided 2026-10-31, section 12, step 13):
  the publisher's push gateway, a third party even to a self-hosted relay,
  learns which relay woke which phone and when, and nothing about
  sessions. The relay holds each phone's push handle, so whoever controls
  it can wake that phone, but only with the fixed text. A phone logs in
  while locked to fetch the session list, with a second key that the
  relay allows nothing else (decided 2026-11-02); its main key is
  released only after Face ID or the device's PIN.

## 7. Protocol

Decided 2026-10-20.

**Transport: WebSocket.** Every pi process and every client dials out to the
relay, so nothing listens on hosts or phones and NAT does not matter;
`wss://` by default, `ws://` when the relay is set for plaintext (section
5.1). It works in browsers (the later web client), on iOS, Android and Dart,
and was what the Remote Pi app spoke. Rejected: gRPC streaming
(awkward in browsers, HTTP/2 not needed), WebTransport or QUIC (immature on
iOS), MQTT (a broker to run).

**Schema and encoding: Protocol Buffers**, one message per binary WebSocket
frame, not gRPC. One `.proto` definition; Go (relay), TypeScript (extension,
relay client, web app) and the mobile app's language are generated from it with the Buf
toolchain: `buf generate`, and `buf lint` and `buf breaking` in CI, since
self-hosters will run mixed versions. Protocol Buffers' standard JSON form is
used for logging and replay in development. The envelope is its own message
with the payload as `bytes`: the relay decodes only the envelope and its
control frames and passes payloads through, so end-to-end encryption later
changes nothing for it. Libraries as checked 2026-10-20: Go
`google.golang.org/protobuf` v1.36.12, TypeScript `@bufbuild/protobuf` and
`protoc-gen-es` 2.16.0, Dart `protobuf` 6.1.0 and `protoc_plugin` 25.1.0, Buf
CLI 1.74.0.

Alternatives considered:

- **FlatBuffers**: official Go, TypeScript and Dart support; its zero-copy
  reads buy nothing for frames of a few kilobytes, at the cost of builder APIs
  and weaker JSON debugging.
- **Cap'n Proto**: good in Go, but patchy in TypeScript and essentially absent
  in Dart.
- **MessagePack, CBOR**: schemaless; typed code would need a second schema
  language and its generators, weakest in Dart.
- **JSON with JSON Schema or TypeSpec**: easiest in TypeScript, but Dart only
  through third-party generators and TypeSpec has no Dart emitter.
- **Avro, Thrift, Bebop, SBE**: weak or no Dart support, fading or niche.

The Remote Pi app's protocol is not PiRC's: the adapter spoke it with
hand-written types pinned to app version 1.2.0+8, as the one exception to
"defined once" (section 10). Retired 2026-11-07, and the exception with it.

Message groups:

- **Envelope**: account, host, session ID, instance ID, frame type, size,
  and (decided 2026-10-31) whether an announcement is one to push for;
  everything else is payload (section 5.1, section 12, step 13). The last
  is `SessionAnnounce`'s `push` (built 2026-11-03): the host sets it when
  the announcement's notice (section 4) is one it has not yet sent with
  `push`, marking it sent only once the frame has gone out, so that a
  notice raised while the relay was out of reach is pushed with the first
  announcement after reconnecting, and a repeat of the same notice is not.
  The relay never passes it on to clients.
- **Push registration** (built 2026-11-03, section 12, step 13): a client
  registers with `RegisterPush`, giving the push gateway's handle for its
  phone, at most 1 KiB and opaque to the relay, and unregisters with
  `UnregisterPush`; each is answered by `PushChanged`, or an `Error` with
  the request ID (`INVALID` for no handle or one too long,
  `PERMISSION_DENIED` from a host). One registration per client key:
  registering again replaces it. It is stored with the key in the
  registry, so a restart keeps it and removing the key deletes it; the
  registered keys list says which clients are registered (section 5.3),
  but no client is sent a handle, and the relay logs a registration by
  the key's label, without the handle. `pirc-relay list` shows it too.
  Every client is treated alike: the web app's server, which notifies its
  browsers itself, never registers.
- **The read-only key** (built 2026-11-03, section 12, step 13): a client,
  under its own key, registers a second key with `RegisterReadKey`,
  answered by `KeyChanged`; one per client, registering another replacing
  it and closing the old one's connections as revoked. It logs in as a
  client with no token, and `Welcome` says `read_only`; it may then send
  only `SubscribeSessions`, everything else refused `PERMISSION_DENIED`
  with the connection left open. It is stored with its client in the
  registry and goes with it. Nothing proves the client holds it, so it may
  be no other registered key, either way round: `RegisterReadKey` is
  refused `INVALID` for any client's or host's own key or another client's
  read-only key, and a read-only key is refused `PERMISSION_DENIED` when it
  logs in with a token or as a host, and is never approved; otherwise a
  login with it would be ambiguous. The registered keys list does not show
  it apart and does not count it as its client online, but says that the
  client has one (`read_key`); `pirc-relay list` shows it in a READ
  column.
- **Handshake**: protocol version on every connection, from extension and
  client; self-hosters will run mixed versions.
- **Session lifecycle and presence**: announced (with the session it replaced,
  if any), ended, renamed; host and session online state; the per-session
  announcement the relay replays.
- **Conversation**: history on attach, then streaming of assistant text,
  thinking, tool calls and results; user prompts with images. A turn ID shared
  by live streaming and replayed history, so a client can join the two; a
  per-session sequence number, so a reconnecting client detects gaps.
  History from an entry (built 2026-11-03): a client that has a chat
  already, a phone's kept one or one caught up after a gap or a
  reconnect, gives its last saved item's entry ID (`HistoryRequest`'s
  `after_entry_id`; a chat item's own ID is not always it, its `entryId`
  is), and the extension answers with only the items after that entry's,
  `History.from_entry` set: the client keeps its chat up to that entry and
  appends them, dropping what it had after it (items not yet saved).
  When the entry is not on the session's branch (it moved in its tree),
  more than `limit` items follow it, or they do not fit one message, the
  answer is the usual last `limit` items, which replace the chat. Entry
  IDs rather than sequence numbers, which start again with a new pi
  process. `web/core` asks so whenever its chat has a saved item
  (`cases/exchanges/history-after.json`).
- **Actions**: requests with IDs and idempotency, so a retry after a reconnect
  never sends a prompt twice. Most of pi's calls return nothing (section 8), so
  a reply means "confirmed by the corresponding pi event", with a timeout.
  A prompt to an idle session is accepted once pi echoes it or starts its run,
  and answered `TIMEOUT` after 30 seconds without either; a prompt sent
  mid-run (queued by pi), an abort or an extension command is accepted once
  handed to pi, and a prompt sent while pi compacts is accepted at once and
  held by the extension until the compaction ends (section 8). A repeat of a request whose answer was an error after which
  nothing ran (`BUSY`, `TIMEOUT`, `PI_FAILED`, `INVALID`, `SESSION_GONE`) is
  run again rather than answered from the cache.
  The actions besides prompt and abort (step 8): list models, set the model,
  set the thinking level, compact, new session, fork, clone, list past
  sessions, resume, reload, move in the session tree, list its branches,
  rename, stats (cost and context use) and list commands. A change is broadcast as an event before
  its `Accepted`, so the asker sees the new state by the time it learns of
  success, including a level pi clamped; a question is answered with its
  answer (`Models`, `Stats`, `Commands`). Compact is answered when the
  compaction ends, and the announcement shows the session compacting
  meanwhile (an abort stops it); a new session is answered by the old session as pi commits to
  it, before that session ends. Compact and new session are refused
  `BUSY` while the agent works, since pi would abort the turn, and while
  pi compacts or the session is being replaced; the extension marks the
  session compacting or being replaced when it takes the request, since
  pi's own hooks come later and a second request could slip in between.
  pi's built-in commands and PiRC's own (`/pirc`, `/pirc:new`) are refused
  as prompt text: the first would reach the model as text, the second
  would let a client re-point the host or bypass those checks.
- **Requests a session takes** (decided 2026-10-28): only the extension is
  released, and each host updates when its owner chooses, while clients
  follow the main branch; a request the extension did not know was
  answered with no request ID, so the client waited 45 seconds for a
  `TIMEOUT` that misled. The announcement now lists the requests the
  session takes, by their field names in `SessionMessage`, built from the
  extension's own table of them, so the list cannot drift from the code;
  a client refuses at once, `INVALID`, one the session does not list, and
  can leave out an action it does not offer. An announcement without the
  list is from an older extension, and a client sends as it did before.
  And every request carries its ID twice, in its body and beside it,
  where an extension that finds no body it knows still reads it, and
  answers `INVALID` with it.
- **Errors**: a fixed taxonomy, timeouts included.
- **Limits**: a maximum frame size; images travel inline.

## 8. What pi allows

Verified against pi 1.0.0 (`@earendil-works/pi-coding-agent`), 2026-10-17 and
2026-10-20; the behaviour marked *run* was observed with a probe extension in
an interactive pi. `pi` is the extension API object, `ctx` the context passed to
event handlers; neither may be used after its session is replaced.

| Feature | How |
|---|---|
| Switch model | `pi.setModel()`: `false` without credentials for the provider, otherwise records a model change in the session file (so resuming the session restores it) and fires `model_select`; it never changes the default for new sessions, which only pi's `/model` picker does (`setModel(model, { persist: true })`, not offered to extensions). It also re-applies the thinking level for the new model. Models from `ctx.modelRegistry.getAvailable()` (those with credentials) |
| Thinking level | `pi.setThinkingLevel()`, `pi.getThinkingLevel()`; levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. pi clamps the level to what the model supports (upward first; a model without reasoning allows only `off`) and fires `thinking_level_select` only when the level in effect changes |
| Rename | `pi.setSessionName()`, `pi.getSessionName()`, `session_info_changed` |
| Compact | `ctx.compact({ onComplete, onError })`. It aborts a running turn first, then fails with "Nothing to compact" or "Already compacted" when there is nothing to do |
| Context use | `ctx.getContextUsage()` |
| Cost | summed by PiRC from the session's entries as pi's own `getSessionStats()` does (assistant messages, tool results, compaction and branch summaries, usage entries), which extensions cannot call |
| Send a prompt, steer, follow up | `pi.sendUserMessage()`; always pass `deliverAs`: *run*, text sent without it while the agent is streaming is dropped without an error reaching the caller |
| Extension commands, skills, prompt templates | `pi.getCommands()` lists them (no built-ins); `pi.sendUserMessage(text, { expandPromptTemplates: true })` runs them. The option defaults to `false` |
| Abort | `ctx.abort()` |
| Streaming | events `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end` |
| New session, fork, resume, tree, reload | **command handlers only** (below) |

**Session control is command-only.** `newSession()`, `fork()`,
`switchSession()`, `navigateTree()` and `reload()` exist only on the context pi passes to a
registered command's handler ("command-only because calling them from
lifecycle handlers can deadlock the runtime", `docs/extensions.md`). A remote
request arrives in a socket callback, where they are unavailable. PiRC
therefore registers internal commands (for example `/pirc:new`) and dispatches
them with `pi.sendUserMessage("/pirc:new", { expandPromptTemplates: true })`,
which pi routes to the command before any turn. Remote Pi's extension met the
same limits. *Run* (2026-10-20):

- Dispatch from a socket callback works, idle or while the agent is streaming;
  command names may contain `:`. The command does not appear in the
  transcript.
- `sendUserMessage` resolves once the command is dispatched, before the
  replacement finishes, so completion is confirmed by `session_start`.
- A replacement runs: `session_shutdown` (`reason`, `targetSessionFile`), the
  extension's factory again in the same module, `session_start` (`reason`
  `new`, `resume` or `fork`, `previousSessionFile`), then `withSession`. The
  old `pi` and `ctx` throw "stale after session replacement" from
  `withSession` on. So the extension keeps its relay connection in module
  scope, opened on the first `session_start`, and rebinds it to the newest
  `pi` and `ctx` on every `session_start`.
- A replacement while the agent is streaming aborts the turn in progress.
- **pi exits on any error an extension's `fork()` meets**: its interactive
  mode treats one as fatal ("Failed to fork session: ...") even when the
  handler catches it (*run* 2026-10-27), whereas an ordinary error thrown by
  a command handler does not. pi 1.0.0's fork throws for an unknown entry,
  for a fork before anything but a user message, and for a session not
  written to disk yet (pi writes the file with the first reply; a new
  session has entries, its model and thinking level, but no file). PiRC
  checks all three before calling it (`forkProblem`); what it cannot check
  (another extension's `session_before_fork` throwing, a failed write)
  remains.
- **The same holds for `switchSession()`** (`/resume`), but for one error:
  a session whose folder no longer exists makes pi ask at its terminal
  which folder to use instead. PiRC takes only a session pi lists, and
  refuses one whose folder is gone (`resumeProblem`). Read from pi 1.0.0's
  code, not run: a folder pi does not trust yet, holding project resources,
  makes pi ask at its terminal whether to trust it, so a client's resume
  there waits for someone at the terminal and is answered `TIMEOUT`.
- **pi gives extensions no way to list saved sessions.** `SessionManager`
  has static `list` and `listAll`, which `/resume` uses, but the extension
  cannot import pi's code: pi's loader runs only `loader.js`, which imports
  the bundle through Node, where pi's package does not resolve. The context's
  session manager is a `SessionManager`, so the extension calls them through
  its class (`ctx.sessionManager.constructor`), and answers `PI_FAILED` if a
  pi lacks them (*run* 2026-10-27, pi 1.0.0).
- **A client's images in pi's own chat** (2026-11-06, the owner's
  decision). pi's terminal draws only the text of a user message
  (`getUserMessageText` keeps its text parts), and images only in tool
  results, so a photo sent from a phone showed nowhere at pi's terminal.
  After a client's prompt with images, the extension appends a custom
  entry, `pirc:photos`, naming the user message's entry, and draws it with
  its own renderer (`registerEntryRenderer`, `photos.ts`). The renderer
  reads the images from that message, so nothing is stored twice, and
  draws each with pi-tui's `Image`, as pi draws a tool's images: where the
  terminal shows none (in tmux, in a terminal pi does not know), that is
  pi-tui's own line, `[Image: [image/jpeg] 1200x1200]`, and so it is with
  pi's `terminal.showImages` off; the width is `terminal.imageWidthCells`
  (both from `pi.getSettings()`). Images typed at pi's terminal are left as
  pi shows them. Custom entries never reach the model
  (`sessionEntryToContextMessages` gives none for them, pi 1.0.0 and
  1.3.0), nor clients: History, the session tree and turn IDs read only
  messages, compactions and branch summaries, though a prompt stopped
  before its reply leaves the entry at the end of its branch, so a branch's
  `leaf_id` can be one, which `NavigateTree` takes. pi's `/tree` hides
  them by default. *Run* 2026-11-06 on a Mac: in Ghostty the photo shows
  right after its message, live and on resume (pi 1.0.0 and 1.3.0 from
  source, 1.0.0 from the published package); in tmux, pi-tui's line, also
  after `/reload` and `/pirc:clone` (both versions, from the package). Under herdr 0.9.3 in Ghostty it shows too: herdr sets
  `TERM_PROGRAM=herdr`, which pi does not know, but its panes inherit
  `GHOSTTY_RESOURCES_DIR` from the terminal that started herdr's server,
  and pi takes kitty's protocol from that. A herdr server started
  otherwise needs `PI_IMAGE_PROTOCOL=kitty` in pi's environment, with which
  it showed as well.
- **pi saves a message only after the extensions' `message_end`
  handlers** have run (`_emitExtensionEvent`, then `appendMessage`). An
  entry appended from that handler is saved before the message, and on
  resume pi draws it above. The photo entry is appended once the message is
  saved (at the next event, or 10 ms after, as the extension already waits
  for an entry ID), while the message is still the session's last entry;
  pi then draws it after the message, on resume in the file's order and
  live where it is appended, or before a reply that already streams.
- **An entry's renderer cannot ask pi to redraw.** Kitty's protocol takes
  only PNG, and pi converts other images first (`convertToPng`), which is
  asynchronous. The extension starts the conversion at the message's
  `message_end`; a PNG ready after pi drew the entry is drawn by setting
  the extension's footer status again as it is, which always redraws
  (`Host.redraw`). Converting first and appending after was considered
  and dropped: the append would follow an await, by when pi may have
  saved more, and the photo would land after that.
- **pi draws a chat before the extension has its session** when it
  replaces the session (`/resume`, `/fork`, `/clone`, `/new`, and PiRC's
  own) and on `/reload` (`renderBeforeBind`), and drops an entry whose
  renderer gives it nothing. So the renderer gives every photo entry a
  component that finds its message only when drawn, through whichever load
  of the extension has the session, drawing nothing until then; the
  extension redraws once it has the session. pi takes the renderer of the
  first load that registered one.
- **pi-tui is pi's own, from `pi-parts.js`.** The bundle cannot import
  pi's packages by name (above). pi's loader resolves them for a file with
  a static import of one; a file with none, such as `loader.js`, Node
  imports itself, where they do not resolve (*run* 2026-11-06, pi 1.0.0's
  bundled build, the extension given as a package folder, as pi installs
  one; a reviewer's run giving `loader.js` itself as the file saw pi's
  loader take it either way). `loader.js` stays as it is: given static imports, pi's
  loader would also take over its import of the bundle, which ignores the
  URL's query, and an update would not run until pi restarted (the
  end-to-end test caught it). So the published package has a first entry,
  `pi-parts.js`, which imports pi-tui and pi's package whole and leaves
  pi-tui and `convertToPng` on `globalThis` for the bundle, at every load,
  `/reload` included: the very modules pi draws with. pi's bundled build
  gives extensions the pi-tui inside its bundle, which holds pi's measured
  cell size, its image settings and, in fullscreen, where each kitty image
  is placed. pi loads a package's entries in order, each awaited. Failing
  that, the bundle imports them by name, which works from source, then
  from the running pi's install, found from pi's entry point (`pi.ts`): a
  copy of pi-tui of its own, which draws the photo but knows none of that,
  and `dist/utils/image-convert.js`. The log says which (`photos:`); what
  could not be loaded pi's screen says once a process, plainly. Without
  pi-tui no entry is drawn; without the conversion, a non-PNG image under
  kitty is pi-tui's line.
- **`reload()` tells its caller nothing.** It runs pi's `/reload`, which
  declines with a warning on pi's screen while the agent streams or pi
  compacts, and shows a failure there too, catching it: the call returns
  either way. PiRC refuses a reload while the agent works or compacts
  (`BUSY`), and answers when `session_shutdown` comes with reason
  `reload`, else `TIMEOUT`; a failure after that shows only at pi's
  terminal. *Run* 2026-10-27 (pi 1.0.0): the session stays, is announced
  again, and takes prompts after.
- **`navigateTree()` keeps the session** and returns once the move is
  made, summary included; `session_tree` comes before it returns. Unlike
  fork, its errors are thrown to the command handler, which catches them,
  and pi carries on. While the agent streams it throws ("Wait for the
  current response to finish"), where pi's own `/tree` aborts the turn
  first. From an extension, pi re-renders its chat and puts a user
  message's text in its editor if that is empty, as its `/tree` does.
  *Run* 2026-10-28 (pi 1.0.0), in the extension's end-to-end test.

**Replies are events.** Only `setModel` returns a result. `sendUserMessage`,
`compact`, `setSessionName` and `setThinkingLevel` return nothing, and
`sendUserMessage` reports errors through the runner's error listeners rather
than by throwing. An action is confirmed by the event it causes:
`agent_start` or the echoed user message, `session_compact`,
`session_info_changed`, `model_select`, `thinking_level_select`,
`session_start`. pi refuses a prompt while it compacts, with no model
selected, or without credentials for the model by throwing from a promise no
extension sees (`agent-session.js`, `prompt()`); its own screen shows the
error. PiRC answers the second itself (`PI_FAILED`) and the third by the
timeout. A prompt sent while pi compacts, from `session_before_compact` until
`session_compact` or `session_compact_failed`, is accepted and held, as pi's
own terminal holds what is typed meanwhile ("Queued message for after
compaction"; extensions cannot add to that queue). When the compaction
ends, finished, failed or cancelled, the held prompts go to pi in order,
each as the steer or follow-up it was sent as, after pi's hook has returned,
since pi clears its compaction only then. Into a run still going (pi
compacts mid-run when the context fills) they all go at once; to an idle
pi the first starts a run and the rest follow once it has started, since pi
queues only what comes mid-run, or after 30 seconds if it never does. They
are dropped if the session ends first; the client sees it end. Until
2026-10-31 such a prompt was refused `BUSY`, which left it to the person to
send again once pi had finished. *Run* 2026-10-31 (pi 1.0.0), in the
extension's end-to-end test.

**Not possible: pi's built-in slash commands.** pi has 24 (`settings model
tree thinking scoped-models export import share bug copy name session changelog
hotkeys fork clone trust login logout new compact resume reload quit`; its docs
add `/llama` when the llama.cpp router is configured), and they run only in its
terminal interface; no API dispatches them. PiRC maps the useful ones to the
calls above as typed actions. Some have no remote meaning (`hotkeys`, `login`,
`settings`). The rest are refused when a client sends them as prompt text
(`INVALID`, naming the action to use where there is one), since pi would
otherwise send them to the model; the list is copied into the extension,
because pi does not export it. A text such as `/cost`, which is no pi
command, reaches the model as pi's own terminal would send it.

**Answering another extension's dialogs, through pi's internals (decided
2026-10-30).** `ctx.ui.select`, `confirm`, `input` and `editor` are blocking
calls answered by pi's own interface, and pi's API gives another extension
only `ui_prompt_start` and `ui_prompt_end` (kind and title). But pi 1.0.0
gives every extension the same, writable `ui` object, so PiRC wraps its
methods (`extension/src/questions.ts`): each dialog still shows in the
terminal, and is announced to clients as a question (`Question` in the
session's announcement); whichever answers first wins. A client's answer
(`Answer`) closes the terminal's dialog through the `signal` pi's dialogs
take, as Escape would, and the extension gets the client's answer instead.
`editor()` takes no signal, so an editor, and a `custom()` dialog, are only
shown to clients, as what the session waits for. The wrapping keeps pi's
own methods on the object, so a newer load of the extension (`/reload`)
wraps them, not the older load's wrappers; it is redone when pi makes a new
`ui` object. Where it fails (a pi whose object cannot be changed),
questions go unanswered from clients and `/pirc status` says so. Chosen
over showing questions only, or waiting for pi to add a hook, because a
session stuck on a question is the case a phone most needs to handle; the
reliance on pi's internals is the cost, and the tests pin it. A question
asked before a run starts (in `before_agent_start`, say) holds the prompt
that started it: the prompt's deadline waits while a question is asked,
in the extension and in the web app's server. A question also notifies
(`web.md`, section 6).

**What a tool's result says beyond its output** (2026-10-30, `ToolResult`):
how long it ran, from pi's `durationMs` on the result where pi records it
(its agent core from 1.4), else timed by the extension from
`tool_execution_start` to the end, live only; a command's exit status,
read from the line pi's bash tool appends to a failure's output
("Command exited with code N"), 0 when it succeeded, none when it timed
out or was stopped, since pi keeps the code itself only for programmatic
callers; and an edit's unified diff, from the `patch` in pi's edit
details.

**Tool approval** is possible (a `tool_call` handler can block a call), but the
pi session waits while a phone decides. Not in the first version.

**Lifecycle rules for the extension**: open the relay connection on the first
`session_start`, not when the extension loads, and keep it for the life of the
process; on `session_shutdown`, end that session on the relay (idempotently);
do nothing outside interactive mode (`ctx.mode === "tui"`), so `pi -p` runs
never appear as sessions.

pi's RPC mode (`--mode rpc`) has much of this as commands, `get_session_stats`
included, but it drives a headless pi, not an interactive one, so it is a
reference for PiRC rather than its integration point.

## 9. Components and stack

- **Extension** (TypeScript, distributed as a pi package): loaded into every
  interactive pi session; connects the session to the relay under the host's
  key, streams events, executes actions.
- **Relay** (Go): registration, presence, routing between clients and
  sessions. Decided 2026-10-20. The relay never reads payloads, so it needs
  only the envelope and control-frame types, which keeps the cost of a third
  language small; in return self-hosters get one static binary, and a small,
  long-running network server is what Go does best. TypeScript (one language
  for everything before the app) was the close alternative; Rust (slower to
  change, async complexity a single-user relay does not need), Dart (shares
  only with the app, which comes last) and Elixir (Phoenix presence fits, but
  no plain binary and few contributors) were rejected.
- **Remote Pi adapter** (TypeScript): a separate process and an ordinary PiRC
  client of the relay; presented PiRC to the unmodified Remote Pi app (section
  10). Retired 2026-11-07, PiRC's own apps having replaced it (section 12,
  step 15).
- **Web app** (TypeScript: Hono on Node for its server, React for the page):
  PiRC's first own client (`docs/web.md`). Its server, the BFF, is one
  client of the relay for every browser signed in to it.
- **Mobile app** (Flutter, decided 2026-11-01): after the web app; iOS and
  Android. Published under PiRC's own name, bundle IDs and icon. It talks to
  the relay itself, with the web app's client logic as its specification.
- **Push gateway** (Go, decided 2026-10-31, built 2026-11-03 as
  `pirc-gateway` in the relay's module, run by the publisher at
  `https://push.pirc.dev`): a small
  stateless service at pirc.dev that holds the app's Apple and Google push
  credentials and sends the pushes that wake phones for any relay
  (section 12, step 13; `docs/gateway.md`).

## 10. Remote Pi app compatibility

**Retired 2026-11-07.** The owner uses PiRC's own web and mobile apps, the
Remote Pi app is no longer supported, and `adapter/` and `docs/adapter.md`
are removed; both are in the repository's history (section 12, step 15).
What follows is the design as it stood.

Decided 2026-10-18: **the first client is the unmodified Remote Pi app**,
pinned to version 1.2.0+8, so the backend can replace Remote Pi's relay and
extension before PiRC has an app of its own, with nothing changed on the
phone. PiRC's own protocol is not bent around it: an **adapter** beside the
relay speaks the Remote Pi app's protocol, acts as one PiRC client, and
translates. It is meant to be thrown away once PiRC's own app exists, so it is
built for observed use first and grown from the gaps found in dogfooding, not
from Remote Pi's whole message catalogue.

**How it works.** The adapter presents **one virtual host** (one Remote Pi
"Pi key") whose rooms are the pi processes on every registered host; to the
app it is a Remote Pi relay with that one host on it. A person sets the
adapter's URL in the app's settings, then pastes a
`remotepi://pair?t=...&epk=...&n=...&rm=...` link (the app's "Paste code
instead"; it has no deep links). The link carries no `r`: the app never
switches relay for a link, and fails the pairing when `r` differs from its own
(checked in the app's source, 2026-10-22; an earlier reading here was wrong).
The app lists every room a paired host announces and tracks liveness per
room, so sessions coming and going under an always-online virtual host
behave: an ended session greys out and keeps its history. The full
specification, read from the app's source with citations, is
`docs/adapter.md`.

**The adapter's own registry.** The app's identity is its Owner key, which it
presents to the adapter when pairing, not to PiRC's relay. So the adapter keeps
its own list of phone keys, issues its own pairing tokens and enforces them,
and a phone is revoked there. Phones in one ecosystem share an Owner key and
cannot be revoked separately; an iPhone and an Android phone are separate.

**Rooms follow pi processes.** A room in the app is one pi process, not one pi
session: its ID derives from the process's instance ID (section 4), so when
the process changes session the room stays and points at the new session. This matches the app's own "new session", which on success wipes
the room's history and keeps the room. How the app reconciles a session change
made at the terminal is checked in adapter v0. Each new pi process is a new
room; ended rooms stay as grey tiles until deleted on the phone.

**What the adapter must reproduce**:

- the relay's `hello` / `challenge` / `auth` login with standard-base64
  Ed25519 keys, and WebSocket keepalive;
- relay control frames: `subscribe_presence`, `unsubscribe_presence`,
  `presence_check`, `subscribe_rooms`, `unsubscribe_rooms`, `rooms_check`, and
  the pushes `rooms`, `room_announced`, `room_ended`, `room_meta_updated`,
  `peer_online`, `peer_offline`, `presence`;
- routed `{peer, room, ct}` frames with plaintext JSON base64-encoded in `ct`,
  `peer` and `room` rewritten to the sender's;
- the token-based `pair_request` / `pair_ok` flow, and the inner `ping` /
  `pong`;
- `{relay}/mesh/...` on the same origin as the WebSocket, which the app calls
  at start and while running. The adapter **stores and returns** the blob each
  paired phone posts, with the real relay's checks (signature, increasing
  version), so a second phone of the same person, sharing its Owner key, sees
  the virtual host. Never an empty or partial blob of its own: the app deletes
  every paired host missing from a fetched blob. A blob without the virtual
  host is the person unpairing in the app, and the adapter drops that owner.

Tests check every frame the adapter sends against decoders transcribed from
the app's own parsers, and run an app simulator end to end; captured frames
from Remote Pi's relay and extension cannot show what PiRC's traffic does to
the app. A phone is the final check.

**Constraints accepted**

- **Features are the app's.** Prompt, steer, queued follow-ups, one image,
  on-device voice to text; cancel; compact, new session, model and thinking
  level. Tool calls appear as informational cards: the app no longer shows
  approve and deny, and the adapter does not gate tools. Not available: rename
  from the app's menu (local only), resuming or browsing past sessions and
  forks, cost and context meters, push notifications (the app has none), and
  extension dialogs (Remote Pi bridged only the pi-ask extension; section 8).
- **Commands as text.** The app sends `/foo` as plain text, so the adapter
  treats a leading `/` as a command: extension commands and prompt templates
  run through pi, and a few built-ins are mapped (`/name` renames on the host;
  `/cost` and `/context` answer with a text message). The list is kept short,
  because built-ins are hard-coded and change with pi. No autocomplete.
- **Never send the app anything it does not know.** An unknown live message
  type becomes an error bubble and discards the stream in progress; an unknown
  history event type loses the whole history. The adapter translates to a
  fixed set and drops the rest.
- **Thinking level `max`** does not exist in the app (it stops at `xhigh`); the
  adapter shows it as `xhigh`.
- **Room IDs** are hex, short, never `main`, and contain no `/` or `:`: they
  become file names in the app (Hive box names, case-insensitive), and `main`
  is the app's own room and its fallback when a link has no `rm`. The app shows
  no hostname per room, so the room name carries it (`host: name`). All rooms
  sit under the virtual host's single header.
- **`session_started_at`** is the session header's `timestamp`. The app stores
  it but, in 1.2.0+8, does not act on a change.
- **Relay URL**: the app accepts only `http://` or `https://` and derives the
  WebSocket from it; `http://` means plain `ws://`.
- **Identity**: the app has one Owner key per phone, synced only within iCloud
  Keychain or Google Block Store, and will not start without that sync.
- **History on the phone does not carry over** from Remote Pi: the app keys its
  cache by host key, and the virtual host's key is new.
- **Plaintext only**, which suits the first version (section 5.1).
- **Upstream ties.** The app defaults to its author's relay (changed once by
  the `r` in the pairing link), checks its author's server for updates on
  Android (fails silently), and is distributed by its author: a store update
  could break compatibility. The fallback is building the MIT source at a
  pinned commit, which on Android is an APK and on iOS needs a developer
  account and TestFlight, close to the cost of shipping PiRC's own app. If the
  store app breaks, that is the point to decide whether to bring PiRC's own
  app forward.

## 11. Reuse and attribution

PiRC is written new. Code was to be adapted from Remote Pi only where it
clearly saved work, most likely parts of its Flutter UI; decided 2026-10-25,
PiRC's own clients borrow nothing from it, to be built better rather than
adapted.

Anything adapted keeps Remote Pi's MIT copyright notice ("Copyright (c) 2026
Jacob Moura") and is listed here and in a `NOTICE` file, with the upstream
commit it came from.

| From | What | Upstream commit | Where in PiRC |
|---|---|---|---|
| -- | nothing yet | -- | -- |

## 12. Plan

Each step ends with something that can be seen working.

**Before building**

1. **Check pi's runtime behaviour** with a throwaway extension. Done
   2026-10-20; results in sections 4 and 8.
2. **Choose the relay language and the schema tool.** Done 2026-10-20: Go,
   and Protocol Buffers with Buf (sections 7 and 9).

**Backend, provable without a phone**

3. **Protocol v0**: the `.proto` schema for everything in section 7 that
   steps 4 to 6 use, history included; generated Go and TypeScript, checked
   by `sh/check.sh` (no CI yet). Drafted 2026-10-20 as `pirc.v1alpha1` in
   `proto/`, and walked through with the author; `buf breaking` applies from
   `v1`.
4. **Relay v0**: WebSocket, TLS by default and plaintext by setting, login by
   key challenge, a key registry file with `add-host` / `add-client` /
   `remove` commands printing one-time tokens, routing by envelope, presence,
   stored session announcements. Built 2026-10-20 in `relay/`:
   - `pirc-relay serve` listens on `/v1alpha1` (and `/healthz`) and refuses to
     start without `--tls-cert`/`--tls-key` unless given `--plaintext`.
   - The registry is `<data-dir>/registry.json`, the relay's only durable
     state, written atomically under a lock file so the commands and a running
     relay can change it together; tokens are stored as SHA-256 hashes and
     expire (15 minutes by default). A token is used up only after the
     challenge proves the key.
   - The relay rereads the registry every second and disconnects removed
     keys, including one removed while its login is waiting on the
     challenge. While the file cannot be read, nobody new may log in.
   - A newer connection announcing a session takes it over from an older
     one, which is assumed dead; the relay pings every 25 seconds.
   - Limits, each refused with an error rather than ignored: a peer that
     cannot keep up with its queue (256 frames or four maximum frames of
     bytes) is disconnected, without holding up anyone else; no frame the
     relay sends exceeds the maximum it announces (the session list is split
     across frames; a frame that would be too large is refused with
     `TOO_LARGE`); 32 live sessions per connection; session announcements
     of at most 64 KiB (`TOO_LARGE`; a real one is a few hundred bytes);
     256 connections still logging in, 8 of them from any one address
     (more get HTTP 503; the address is a trusted proxy's client's, section
     5.3); 5 seconds for the first frame and 10 for the whole login; 4 KiB
     per frame before login; idle HTTP connections closed after 30
     seconds; labels, software strings and session and instance IDs of at
     most 128 bytes. The registry commands print what hosts sent (labels,
     software, addresses) quoted with escapes when it holds anything not
     printable, and `approve`, `reject` and `remove` take at least 16
     characters of a key.
   - Browser origins are not checked yet; they must be before a web client.
   - Reviewed 2026-10-21 (section 13).
5. **Extension v0**, as a pi package: enrols the host, announces its sessions
   and session changes, streams events, history on attach, prompt and abort.
   Built 2026-10-22 in `extension/`, on `relay-client/` (login, keepalive and
   reconnection, for every TypeScript peer, on the `ws` library: an idle
   host writes nothing, so only pings tell it its connection died):
   - Configuration is one file, `$XDG_CONFIG_HOME/pirc/host.json` or
     `PIRC_CONFIG`: the relay URL, the key file (default `host.key` beside
     it, made once and atomically, readable by its owner only) and a label
     (default the host name). `/pirc enrol <relay-url> [token]` writes the
     relay and registers the key, or asks for approval without a token
     (section 5.3); `PIRC_RELAY` and `PIRC_TOKEN` do the same without the
     command. `/pirc status` reports, and the footer shows offline,
     awaiting approval, refused or not enrolled; online, the usual state,
     shows nothing, to spare every pi window a line.
   - One connection per pi process, on `globalThis`, since pi can load the
     extension twice into one process as separate module instances. Each
     load gets its own `pi` object, and the session is served through the
     newest, so a second load takes over rather than doubling every event.
     `/new`, `/resume` and `/fork` end the session on the relay and announce
     the next with `replaces_session_id`; `/reload` keeps it, and requests
     during it are answered `BUSY`. Sequence numbers carry on when the
     process returns to a session. Only interactive sessions (`ctx.mode`
     `tui`) appear.
   - **A reload after an update runs the new code** (2026-10-25). Two
     things kept the old code running until pi restarted. pi's `/reload`
     imports TypeScript afresh, but Node keeps every JavaScript module it
     has imported, so the published bundle, updated in place, was not read
     again (checked with pi 1.0.0's jiti, 2.7.0, in both of pi's loading
     modes). The package's entry is now `loader.js`, the same in every
     version, which imports the bundle, `pirc.js`, by a URL carrying the
     file's modification time; it is not `index.js`, where earlier versions
     had the bundle, so updating from them works too. And the connection
     on `globalThis` was made by the old code. Each load now records which
     code made the connection: a
     release by its version, a build from source as new at every load. A
     load of other code takes over: the same instance ID, sequence numbers
     carrying on, so clients see the session continue. The old connection,
     still answering `BUSY`, is closed 2 seconds after the new one has
     announced (30 at most): the relay ends the sessions of a connection
     that closes, but reads each connection on its own, so closing at once
     could end the session before the announcement was read. The old
     connection is reached through fields every version since 0.1.0 has.
     Lost: replies kept for repeated requests, and a place another
     extension gave until it gives it again.
   - **Turn IDs while streaming** (verified): pi persists a message only
     after every extension's `message_end` handler has returned, but awaits
     each event before emitting the next, and stores the message object
     itself in the entry. So at the next event the extension finds the user
     message's entry by identity, and every delta of the reply carries its
     turn ID; the last message of a run is found by a short timer. Only
     user, assistant and tool result messages are waited for: pi stores
     other roles (an extension's custom message) as other kinds of entry,
     and a message not persisted within two seconds is sent without its
     entry ID rather than holding up the stream.
   - Deltas are gathered for 50 ms, tool progress sent at most every 250 ms,
     text fields cut at 256 KiB. An item too large for a frame is sent with
     its images left out (empty `data`, a placeholder for the client) and,
     if need be, its texts cut further, so nothing is dropped unseen and
     History, trimmed from the oldest end to fit one frame (`truncated`
     set), always holds the newest item. Prompts always pass `deliverAs`
     (follow-up unless the client asks to steer) and expand commands and
     templates; confirmation is as in section 7. Replies to prompts and
     aborts are kept per session, client and request (the last 1,000), and a
     repeat while the first is unanswered waits for its answer. A prompt's
     `request_id` reaches the echoed user message by matching its text, or
     its start (pi appends notes to a prompt with images), so a prompt
     template that expands loses it.
   - The relay client gives up on a login not finished in 15 seconds,
     reconnects when the relay stops reading (16 maximum frames unsent),
     cuts labels and software strings to the relay's 128 bytes, and keeps
     errors thrown by its callers' callbacks from reaching pi.
   - Tests: unit tests of the conversions, of the session and process logic
     against a fake pi (another extension's message, the persistence
     fallback, each way a prompt is confirmed or refused, oversized items,
     idempotency per session, reload, a double load), of the relay client
     (a relay silent at login, a throwing callback), and an end-to-end test
     (the real relay; interactive pi in tmux with a scripted
     OpenAI-compatible fake model; a test client) covering announcement,
     history, streaming with turn IDs and no sequence gaps, idempotency, a
     tool call, abort, a steer and a follow-up sent mid-run, a prompt with
     an image, rename, `/reload`, a relay restart, `/new` and quitting.
   - Reviewed 2026-10-22 (section 13).
6. ~~**CLI client v0**~~: dropped 2026-10-22. It was to prove the backend
   to a person before a phone client existed; step 5's end-to-end test client
   already lists, attaches, fetches history, streams, prompts and aborts
   against real pi and the real relay, and a third client would only add
   protocol surface to keep in step. Its check on two hosts moves to step 7.
   A troubleshooting tool (list sessions, follow one) can be built from that
   test client when one is needed; it is not a plan step.

**Stock app**

7. **Adapter v0**: virtual host, pairing link and the adapter's registry, the
   relay protocol the app expects, rooms following processes, streaming chat,
   prompts, history through `session_sync`; tests against decoders
   transcribed from the app and an app simulator (`docs/adapter.md`).
   Specified 2026-10-22 from the app's source and reviewed before building
   (section 13); built the same day in `adapter/` (`pirc-adapter enrol`,
   `serve`, `pair`, `list`, `revoke`). The end-to-end test runs the real
   relay, pi and the adapter's command with simulated apps: pairing and a
   link's single use, rooms, a prompt, a tool call, a steer, cancel, an
   image, history, terminal input, a second phone through the mesh blob,
   `/new` keeping the room, unpairing in the app, and a room ending.
   Checked on a phone (Android, app 1.2.0+8) on 2026-10-22 against a
   development relay and adapter on a macOS host, reached over a private
   network in plaintext, with pi sessions on that host and on a Raspberry
   Pi: pairing by pasted link, both rooms, prompts, a steer mid-reply, and
   leaving a room mid-reply and returning; nothing found.
8. **Actions**: model, thinking level, compact, new session, rename, cost and
   context, extension commands, in the extension and in the adapter where
   the app has them; `/` commands. Specified 2026-10-23 (section 7;
   `session.proto`; `docs/adapter.md`, section 5):
   - Extension: `ListModels` from `getAvailable()`, current from
     `ctx.model`, as `ModelInfo`. `SetModel` finds the model (`INVALID` if unknown),
     awaits `pi.setModel()` (`PI_FAILED` on `false` or a throw), announces,
     then answers. `SetThinkingLevel` sets, announces the level in effect,
     then answers. Both announce even though pi's `model_select` and
     `thinking_level_select` also do, because pi fires those only on a
     change. `Compact` marks the session compacting, calls `ctx.compact()`
     and answers from its `onComplete` (after the compaction item) or
     `onError` (`PI_FAILED`, pi's reason), or `SESSION_GONE` when the
     session ends first. `NewSession` marks the session being replaced and
     dispatches an internal `/pirc:new` command, whose handler calls
     `ctx.newSession()`; it is answered at `session_shutdown` with reason
     `new`, before the old session's end is sent, `PI_FAILED` if another
     extension cancels the switch, `SESSION_GONE` if the session ends for
     another reason, `TIMEOUT` after 30 seconds. `Rename` calls
     `setSessionName()` (`INVALID` when empty) and announces. `Stats` sums the session's usage as pi does and reads
     `ctx.getContextUsage()`; `ListCommands` is `pi.getCommands()` without
     PiRC's own. The announcement gains `compacting`, and `Model` its
     display name.
   - Changes (model, thinking level, compact, new session, rename) share
     the prompt's idempotency per session, client and request; questions
     are answered afresh. A prompt naming one of pi's built-in commands is
     refused `INVALID`.
   - Adapter: the app's five actions, and `/name`, `/cost` and `/context`
     typed as text, answered with a notice in the chat.
   - Tests: unit tests of each action against the fake pi (clamping, a
     failed or cancelled switch, compaction refused while working, the
     stats sum), the extension's end-to-end test (each action against real
     pi), and the adapter's (each app action and text command through the
     app simulator, with the decoders checking every frame).
   - Built 2026-10-23. The adapter acknowledges a compaction half a second
     after it starts, so that pi's quick refusal ("Already compacted") is
     the action's error rather than a notice after `action_ok`. Checked on
     a phone (Android, app 1.2.0+8) on 2026-10-23, same setup as step 7
     with one host: the model list and a switch, a clamped thinking level,
     `/cost`, `/context`, `/name` and a refused `/tree`, a compaction and a
     Stop during one, and a new session keeping the room; nothing found.
9. **Self-hosting**: the relay packaged to run as a service, with
   configuration, TLS, upgrade and registry backup documented; the extension
   installable and updatable as a pi package; the adapter runnable as a
   service beside the relay. Done 2026-10-23. Planned and built in three
   parts, each checked before the next: the relay (with releases, licences and
   `docs/self-hosting.md`), the extension package, then the adapter.
   - **Only the extension is released** (changed 2026-10-25). It runs on
     every host, under pi, where people choose when to upgrade; the relay,
     the adapter and the web app run in one place, where whoever runs them
     can follow the main branch, and releasing them only slowed changes
     down. `sh/build.sh <part> <dir>` builds one part from any commit,
     versioned by the last tag with `-dev+<commit>`, reproducibly (Go's own
     VCS stamping is off), so a deployment can compare builds and restart
     only what changed. `sh/release.sh` builds and tests the extension
     alone. The extension's repository gets a build on its default branch
     whenever a change here changes the extension, and a tag for each
     release, so an install without a tag follows this repository. What
     follows describes releases as they were until then.
   - **Releases.** One version for the relay, the extension and the adapter
     (`0.x`, tagged `vX.Y.Z` here), built by `sh/release.sh` into `dist/`
     (git-ignored):
     - the relay as single binaries (`CGO_ENABLED=0`, `-trimpath`) for
       Linux and macOS on amd64 and arm64, the version set with
       `-ldflags -X main.version=` and shown by a new `pirc-relay version`
       (Go's own stamping would want `relay/vX.Y.Z` tags);
     - the extension and the adapter each bundled by esbuild (pinned) into
       one ES module for Node 22 (`--target=node22`), so a host needs
       neither pnpm nor the workspace. `ws` is CommonJS and `require`s
       Node's modules, which esbuild's ES output cannot, so each bundle
       starts with a `createRequire` banner (checked: without it the
       bundle throws on load); `ws`'s optional native modules stay inside
       its own `try` and fall back to JavaScript. The adapter's bundle gets
       a plain `#!/usr/bin/env node`. The version is a build-time constant
       (`--define`); run from source it is `dev`, never a silent
       `unknown`;
     - `SHA256SUMS`.

     `sh/release.sh` refuses to release from a dirty tree, and fails, never
     skips, when `go`, `pi` or `tmux` is missing: it runs both end-to-end
     tests against the built artifacts before writing the checksums. The
     harness gains overrides for that (the relay binary, the extension
     package directory, the adapter entry point), and the extension test
     loads the staged `pirc-extension` directory, so it proves the manifest
     pi will install and not only the bundle. Hosting release files for
     download waits for step 15; until then a self-hoster builds them.
   - **Licences** (section 2). `LICENSE` (MIT) at the root covers
     everything outside `adapter/`; `adapter/LICENSE` reserves all rights.
     `NOTICE` now serves two purposes: code adapted from other projects
     (section 11) and third-party code each artifact carries, with the full
     notices, since the bundles and binaries drop the source headers. The
     relay: the Go standard library and the `golang.org/x` packages it
     links (BSD-3-Clause), coder/websocket (ISC) and Go protobuf
     (BSD-3-Clause, with its `PATENTS`). The bundles: `@bufbuild/protobuf`
     (Apache-2.0 and BSD-3-Clause; its package ships no licence file, so
     the texts are written out) and `ws` (MIT). Each artifact ships with
     the files that apply to it. `README.md`'s licence section changes in
     the same commit.
   - **Relay as a service.** `serve`'s flags also read from the environment
     (`PIRC_RELAY_LISTEN`, `PIRC_RELAY_TLS_CERT`, `PIRC_RELAY_TLS_KEY`,
     `PIRC_RELAY_PLAINTEXT`, `PIRC_RELAY_MAX_FRAME_BYTES`, besides the
     existing `PIRC_RELAY_DATA_DIR`), flags winning; a boolean accepts only
     `true` or `false` and anything else is an error. The units live in
     `relay/service/`:
     - a systemd unit with a dedicated `pirc-relay` user,
       `StateDirectory=pirc-relay` and `PIRC_RELAY_DATA_DIR` set to it,
       sandboxing, configuration from `/etc/pirc-relay/env`, and the TLS
       certificate and key passed with `LoadCredential=`, since
       certificate stores are readable only by root;
     - a launchd daemon (`/Library/LaunchDaemons`, with `UserName`), so
       the relay runs without anyone logged in.

     The registry commands must run as the service's user: the lock file
     and the registry are created `0600`, and a `sudo pirc-relay add-host`
     run as root would lock the service out. So each command refuses to
     touch a data directory owned by another user, naming the owner. The
     relay reads its certificate once: a renewed certificate needs a
     restart (a renewal hook). Peers reconnect on their own within about
     half a minute (the relay client's backoff caps at 30 s).
   - **Extension package.** Published to its own public repository,
     `pirc-extension`, holding only what pi installs: `package.json`
     (`"type": "module"`, a pi manifest pointing at the bundle, pi's
     packages as `*` peer dependencies, no other dependencies), the bundle,
     `LICENSE`, `NOTICE` and a README. Its source stays here until step 15.
     A host needs `git` and `npm`, which pi uses to install a git package.
     Installed pinned to a release, `pi install git:<host>/<path>@vX.Y.Z`;
     upgraded by installing the newer tag (`pi update` never moves a pinned
     ref), after the relay. Installing without a tag follows the default
     branch and `pi update --extensions` moves it whenever a release is
     published, which is offered only as "track releases", since nothing
     stops the extension then running ahead of the relay within
     `v1alpha1`. `sh/publish-extension.sh` copies a release into a
     checkout of that repository, commits and tags it.
   - **Adapter as a service.** The bundle needs only Node 22 or later;
     `adapter/service/` has a systemd unit. It is not published.
   - **Docs.** `docs/self-hosting.md` covers:
     - installing the relay (binary, user, unit) and configuring it;
     - TLS: certificate files, or a proxy terminating TLS with
       `--plaintext` behind it, listed in `PIRC_RELAY_TRUSTED_PROXIES`
       from 0.1.4 so that requests show the host's address. A self-signed or private-CA certificate
       needs `NODE_EXTRA_CA_CERTS` in pi's environment on every host and in
       the adapter's unit, and the phone must trust it;
     - enrolling and removing hosts and clients, as the service's user;
     - upgrading: replace the binary and restart. While the protocol is
       `v1alpha1`, the relay, the extension and the adapter are upgraded
       together, relay first;
     - backup and restore. Only `registry.json` is backed up (not the lock
       or temporary files beside it); it is written atomically, so a copy
       is consistent. Restore with the relay stopped: it notices a changed
       file by time and size, and an older copy re-admits keys removed
       since then. Hosts keep their keys in `~/.config/pirc`.

     `docs/adapter.md` gains running the adapter as a service, its files
     (`client.key`, `host.key`, `adapter.json`, `registry.json`, `mesh/`,
     all written atomically) and their backup. It also notes that the
     adapter reads its certificate once too.
   - **Checked** by following the docs, with the real commands:
     - the relay and the adapter as systemd services on a Linux host;
     - the launchd daemon on a macOS host, still serving after logout;
     - `pirc-relay version` showing the release;
     - a TLS run with a self-signed certificate and a host enrolling over
       `wss://`;
     - a restore of the registry onto a fresh data directory admitting the
       hosts registered before;
     - `SHA256SUMS` verifying;
     - installing the extension at one tag and moving it to the next, and
       seeing it reconnect;
     - and the phone check of step 8 against that setup.
   - Part 1, the relay, built 2026-10-23 and checked from a snapshot
     release: installed by the guide's steps as a systemd service on a
     Raspberry Pi (arm64), beside another relay, plaintext on a private
     network; a registry command run as root refused, and run as the
     service's user working; `pirc-relay version` showing the release;
     over TLS with a self-signed certificate, a pi host enrolling over
     `wss://` with `NODE_EXTRA_CA_CERTS`, and without it offline with the
     reason; a copy of the registry restored into a fresh data directory
     admitting that host; and the launchd daemon on a macOS host running
     in the system domain as its `UserName` and restarted after a kill.
     Not checked: a logout on that macOS host, which would have ended the
     session doing the check.
   - Part 2, the extension, built 2026-10-23: release 0.1.0 (`v0.1.0`)
     built with every end-to-end test passing against its bundles and
     binary (the extension's test checks that pi loaded the staged package,
     by its version), published to the `pirc-extension` repository, and
     installed with `pi install git:...@v0.1.0` into a fresh pi
     configuration, which enrolled with the relay on the Raspberry Pi and
     connected as `pirc-extension/0.1.0`. Installing from a release's
     unpacked package works too. Moving to the next tag is checked with
     part 3's release.
   - Part 3, the adapter, built 2026-10-23: release 0.1.1 (`v0.1.1`),
     with the adapter's `version` command, owner check and environment
     settings, and `adapter/service/`. Installed by `docs/adapter.md`'s
     steps as a systemd service on the Raspberry Pi beside the relay, after
     `SHA256SUMS` verified. An adapter that had run by hand on another
     host moved there with its data directory, re-enrolled with the same
     client key, and its paired phone stayed paired. The extension, moved
     from `v0.1.0` to `v0.1.1` with `pi install`, reconnected as
     `pirc-extension/0.1.1`. The phone check of step 8 passed against that
     setup. The relay's registry and the adapter's data directory were
     backed up and restored byte-identical. Found: a refused command
     leaves the app's bubble pending (step 10's list).
10. **Dogfood**: the author's whole installation on PiRC for about a week,
    from 2026-10-23: every host's pi moved from Remote Pi's extension to
    PiRC's, the sessions already running carried over in place, every
    phone's app pointed at the adapter, and Remote Pi's relay stopped but
    kept installed. Planned as one host at first; the whole installation at
    once is simpler, since the app has one relay setting for all hosts
    rather than one per host, so a phone on the adapter sees only PiRC's
    hosts. Going back is not kept clean: the sessions and the phones would
    be moved again by hand. pi's `/reload` carries a running session over:
    it fires `session_shutdown`, on which Remote Pi's extension closes its
    relay connection, and reads the package list again, installing PiRC's
    extension, without ending the conversation (checked on pi 1.0.0). A
    host on an older pi is upgraded first, and its sessions restarted and
    resumed. Gaps are written down here and fixed from this list. Known
    before it starts, low priority:
    - **A refused command leaves the app's bubble pending.** The adapter
      answers a refused built-in (`/session`, say) with an app `error`,
      which the app shows as "⚠ invalid: …" without settling the user's
      bubble (`sync_service.dart:624`); it reads "sending…" until the
      app's 20 s backstop removes it. Fix: answer as `/cost` is answered,
      echoing `user_message` and then a notice; and `/session`, which in
      pi shows the session's stats, could be answered with `/cost` and
      `/context` together instead of refused.
    - **Every session in one folder had the same name.** Found on the first
      day: the adapter named a room `<host>: <folder>`, and sessions
      started in one folder (by a launcher, say) were indistinguishable.
      Fixed in 0.1.2: a room is named after its session when the session
      has a name (`docs/adapter.md`, section 4); rooms the app has
      already seen keep their old names.
    - **A named room did not say which host it was on.** With the session's
      name alone, rooms from different hosts under the one header could not
      be told apart. Fixed in 0.1.6: every room name starts with the host
      label, `<host>: <session name>`.
    - **Enrolling meant carrying a token to the host.** Not a gap but a
      wish, added 2026-10-24 in 0.1.3: a host may connect without a token
      and be approved on the relay (section 5.3).
11. **Stay switched**: once step 10's list is clean, the author keeps PiRC,
    with the Remote Pi app, and Remote Pi's relay and extension are removed.

**Later**

12. **PiRC's web app** (`docs/web.md`, decided 2026-10-25): first the
    session list, a session's history and live stream, prompt and stop, the
    actions of step 8, and the passkey sign-in, installable as an app; then
    where sessions run (section 4), in the web app and the adapter; then
    notifications by web push. Fork and clone came next, then past
    sessions and resume, then reload (all 2026-10-27, section 4), then
    pi's session tree (2026-10-28, section 4), then approving hosts
    (2026-10-29, section 5.3), then starting and stopping agents
    (2026-10-29, section 4), then notifications (2026-10-30, `web.md`
    section 6), then images in prompts (2026-10-30, `web.md` section 6).
    Then the devices, renaming and removing them, and tokens for new
    ones (2026-10-31, section 5.3).
13. **PiRC's mobile app**: in Flutter (decided 2026-11-01, below);
    written new, nothing adapted from Remote Pi's; joining by a link or QR
    code from another client, and approving, renaming, removing and
    inviting devices, as the web app does (section 5.3); iOS and
    Android, TestFlight and Play internal testing; then retire the adapter.

    **Notifications** (decided 2026-10-31). The app talks to the relay, not
    to the web app's server, which is what notifies browsers today
    (`web.md`, section 6), so nothing would notify it; and a phone is
    reached in the background only through Apple's or Google's push
    service, which takes pushes only with the app publisher's credentials,
    which a self-hosted relay cannot hold. So:
    - **The push carries nothing.** It wakes the phone, which connects to
      the relay, fetches the session list as it does on connecting, and
      writes the notification itself. Nothing about a session passes
      through Apple, Google or the publisher, encrypted or not, and no
      second encryption scheme is needed for notifications.
      - **On iOS** the push arrives with a fixed text ("A session needs
        you"), which the app's notification extension replaces within
        about 30 seconds. It cannot drop the push (without an entitlement
        Apple grants rarely), so if the phone cannot reach the relay, or
        finds nothing new, the fixed text stays and tapping it opens the
        app. That extension is a separate native program of about 24 MB:
        the React Native or Flutter code does not run in it, so the relay
        login, reading the list and writing the text are written again
        there in Swift, kept small for that reason. Built 2026-11-03 as
        the Swift package `app/ios/PircNotices` (iOS 16, macOS 13), pure:
        `Fetch.run` logs in with the read-only key, reads the session list
        once and returns the notifications and the numbers shown, by the
        same session IDs as `web/core`; the extension target around it
        reads and writes storage and posts them. Its protocol types are
        generated with swift-protobuf from `proto/` (`buf.gen.swift.yaml`,
        `sh/notices.sh`); it passes `cases/notices` and reads the recorded
        exchanges' session lists as `web/core` does, and its tests log in
        to a Go relay. In those tests a fetch adds tens of KiB to the
        process's peak memory; SwiftProtobuf is about 1.2 MB of code
        before linking strips it. Its key must be
        readable after the phone's first unlock, so between a restart and
        that unlock every push shows the fixed text.
      - **On Android** the push is a high-priority data message, which
        the app handles in about 20 seconds and answers with a
        notification, the fixed text when it cannot reach the relay:
        Google demotes high-priority pushes that show nothing. A wake that
        finds nothing new (every notice already shown) shows nothing
        (decided 2026-11-03): it is rare, since the relay wakes a phone
        only for an announcement flagged push, and the fixed text then
        would announce nothing. An app the user force-stopped gets no
        pushes until it is opened again.
      - A self-hosted relay reachable only over a private network gives
        the fixed text whenever the phone is off it.
    - **The host says what is worth a notification, the client writes
      it.** Each session's announcement, which the relay already stores
      and replays, gains its latest notice: a number that goes up with
      each one, its kind (a turn that ended, not an abort; a turn that
      failed; a question), and the first 120 characters of the reply,
      the error or the question, cut by the host. These are today's rules
      (`web.md`, section 6), moved from the web app's server into the
      extension. A client shows a notice whose number is past the last it
      showed for that session, which it keeps across wakes, and writes
      the title and text itself with code shared in `web/core`: the web
      app's server for its browsers, as their client, and the app for
      itself (on iOS, the extension's Swift version). One per session, a
      later replacing the earlier: on iOS the extension removes the
      earlier itself, since the push cannot be grouped by a session the
      gateway does not know; on Android by the notification's tag. If
      several sessions have new notices, it shows each. A session it has
      not seen before is notified only if its notice is later than when
      the client last looked, which the phone keeps (2026-11-03): the
      session may have started while the phone slept. The number is the
      host's clock and that time the phone's, so a skew between them can
      drop or repeat one notification at the edge. The web app's server,
      always connected, takes a session it has not seen as not news.
    - **The relay is told which announcements to push for.** The relay
      does not read announcements, so the extension sets a flag on the
      `SessionAnnounce` frame, outside the payload, when the notice
      number went up. The relay then wakes every client registered for
      push that is not connected under either of its keys (built
      2026-11-03): `POST {gateway}/v1/wake` with `{"handle": …}`, the
      gateway set by `--push-gateway` and none by default, in the
      background so that no announcement waits for it (10 seconds to
      answer, no retries, at most 8 at once). At most one wake per client
      every 10 seconds: one asked for within that window is sent at its
      end if the client is still not connected, so that a question asked
      just after a turn's wake, which the phone may have fetched and
      finished with, is not missed, and a burst sends two at most. A 404
      or 410 says the handle is no longer valid: the relay unregisters it,
      unless a newer one was registered meanwhile, and the app registers
      again when next opened; anything else is only logged. The app closes its relay connection
      when it goes to the background, so that a phone not showing the
      app is woken; the relay would otherwise notice it gone only when a
      ping fails, up to 25 seconds later. The relay learns when turns end
      and questions are asked, which the timing of the traffic already
      shows.
    - **A session gone is not notified.** The relay forgets a session's
      announcement when its pi process disconnects, so a notice raised
      just before a laptop sleeps may be missed, or found with nothing
      new; the phone then shows the fixed text.
    - **A client registers for push with the relay**, under its key, with
      new relay frames to register and unregister (`RegisterPush`,
      `UnregisterPush`, built 2026-11-03, section 7); the registration is
      deleted when the key is removed. It holds the gateway's handle
      (below), which the app registers again whenever Apple or Google
      changes its push token.
    - **A push gateway at pirc.dev**, small, run by the publisher, holds
      the Apple and Google credentials. The app registers its push token
      with it and gets back a handle, the token encrypted with a key only
      the gateway has, saying too whether it is for Apple's test servers
      (a development build) or its real ones; it gives the handle to its
      relay. The relay sends the gateway the handle, and the gateway
      sends the empty push. It keeps nothing but counters in memory,
      limits how often each handle and each address may send, and learns
      which relay woke which phone and when. Changing its key invalidates
      every handle, and every app registers again. Open to every relay,
      self-hosted ones included, as ntfy's, Matrix's and Nextcloud's
      are, since the push carries nothing worth taking; a relay may later
      be asked to register for a free key if it is abused. The relay
      needs to reach pirc.dev (outbound HTTPS). On Android, a way around
      Google (UnifiedPush) may come later; iOS has none. Built 2026-11-03
      (`docs/gateway.md`, its API and how it runs): the handle is
      AES-256-GCM under a random nonce; a token is taken as gone, and the
      wake answered 410, only on Apple's 410 or 400 `BadDeviceToken` and
      Google's `UNREGISTERED` or an `INVALID_ARGUMENT` that names the
      token, so that a fault in the gateway's own message never drops
      registrations; wakes are limited by token, not by address, since a
      relay sends all its phones' from one. A platform the gateway has no
      credentials for answers 503, which a relay keeps registrations
      through, so that a gateway started without them drops none.
    - **Not notifying while another device shows the chat** is left for
      later: the app would need to say a chat is on its screen. The web
      app's server keeps doing it for its own browsers.
    - **The key a woken phone logs in with** can only read the session
      list (decided 2026-11-02, below; built 2026-11-03, section 7).

    Rejected: the web app's server, or a server like it, notifying phones
    (a server that reads everything would stay in the app's path, and
    would have to go with end-to-end encryption); the push carrying the
    notification encrypted for each phone, as WhatsApp's are believed to
    (a second encryption scheme, signing and queueing on the host, for a
    gain only when the phone cannot reach the relay); the host sending
    pushes (each pi process would need the phones' push details and the
    gateway, and only the relay knows who is connected); the relay waking
    clients on every announcement (they change all the time while pi
    works).

    **Decided before the app starts** (2026-11-01 and 2026-11-02, one at a
    time):
    - **The web app stays as it is**: a server that reads everything, for
      self-hosting (`web.md`, section 1). The hosted relay gets, later, a
      web client that is its own client of the relay, with its own keys,
      as WhatsApp's and Element's web apps are, built on what the mobile
      app will have made by then (its own key, protocol code and state);
      `web/core` stays free of Node meanwhile. Rejected: rebuilding it so
      now, which brings keys in the browser, the relay taking browsers,
      and trusting the page's code on every load, for nothing until a
      hosted relay exists.
    - **The phone's key** is an Ed25519 key made on the phone: in the
      Keychain on iOS; on Android in a file encrypted with a Keystore key
      (the Keystore holds Ed25519 keys only from Android 13). On that
      phone only: never synced, never in a backup; another phone joins
      by a link or QR code. Rejected: a P-256 key in the phone's security
      chip (the Secure Enclave makes only P-256), which cannot be copied
      out, but would need the relay, the protocol and the registry to
      take a second kind of key, for a gain only against malware that
      has taken the phone over; and a synced key, which puts a shell on
      every host in Apple's or Google's cloud. The protocol gains no key
      type now: a field added later reads as Ed25519 when absent, and an
      older relay refuses a key of the wrong length.
    - **Face ID, a fingerprint or the device's PIN** before the app acts,
      enforced by the phone, not only by the app's screen: the key is
      stored so that the Keychain or the Keystore releases it only after
      one of them. The app unlocks it on opening, holds it while in use,
      and forgets it after a time, 30 minutes by default as the web app's
      sign-in is, adjustable from every time to a few hours. On by
      default, and can be turned off in the app's Settings. The hold's
      choices (the owner's, 2026-11-06): every time, 5 minutes, 30 minutes
      (the default), 1 hour or 4 hours, counted from when the app goes to
      the background. On Android, which goes there for the photo picker,
      the camera and the system's prompts, such a trip does not count
      unless it lasts as long as the hold and 5 minutes, as when the
      person goes home from it; iOS stays in front for them. Locked again,
      the key goes with the connection that logged in with it and what
      was open, and is asked for as on opening. Turning the lock off asks
      for the person once and keeps the key unprotected; turning it on
      keeps it protected again, which a phone with no passcode refuses and
      Android asks the person for; a change that fails keeps the key as it
      was. On Android the new key is written beside the old, which goes
      only once it is, so that the app killed while the prompt shows loses
      neither; on iOS, with no prompt between, the Keychain item is
      replaced. The read-only key is the same either way. Android 11
      (API 30) at least (decided 2026-11-03), the first whose Keystore
      asks for a fingerprint, the face or the PIN at each use of a key;
      before it, a key asks at each use only for a fingerprint, or for any
      of them within a time after an unlock, with no prompt of its own.
      Rejected: a second path for Android 7 to 10. The extension needs iOS 16, as
      PircNotices does; the app runs from iOS 15 without it.
    - **The key a woken phone logs in with** is a second Ed25519 key,
      registered to the same client when the phone joins, that the relay
      lets only read the session list and refuses everything else; it is
      removed with the client. It is readable from the phone's first
      unlock after a restart, by the iOS notification extension too, so a
      locked phone can fetch; a leak of it shows the session list and its
      notices, and gives no shell. With end-to-end encryption it can also
      decrypt announcements. A relay change: a new kind of key, and a
      frame for a client to register it (`RegisterReadKey`, built
      2026-11-03, section 7). A client counts as connected, for waking it,
      when either of its keys is: a woken phone fetches under its
      read-only key, and a second push in the middle of that would be
      wasted. Removing a client removes both its keys and its push
      registration (both agreed 2026-11-03). Rejected: one key readable while
      locked (Face ID would then guard only the app's screen); a short-lived
      pass from the relay (sent over the wire, and lapsing on a phone not
      opened for a while); no fetch at all (every notification the fixed
      text).
    - **What the phone keeps**: the chats opened in the last 7 days, whole,
      images as thumbnails, so that the app opens at once and fetches only
      what is new each time iOS has cut its connection (history from an
      entry, section 7); the list shows
      only what the relay says is live, as the web app's does. Stored so
      that it cannot be read while the phone is locked, kept out of
      iCloud and Google backups, and deleted when the phone is removed
      from the relay. Done 2026-11-04 (until then the chats were kept
      unprotected): a private folder from the app's plugin, and a chat that
      cannot be read while the phone is locked neither lost nor written
      over by less. The thumbnails (2026-11-04): a folder beside each chat
      in the private folder, a file each, protected the same way and
      deleted with the chat, and with the chat's images: the relay sends
      only what follows a kept chat, so without them its images would be
      placeholders. Drawn by the engine 288 pixels high (a thumbnail's 96
      points at 3x), a photo as a JPEG and anything else, which may be
      transparent, as a PNG; the image itself when that is no smaller.
      JPEG by the `image` package (pure Dart, MIT), since the engine
      encodes only PNG, which for a photo is several times the size. A
      kept thumbnail opens full screen as it is, and the image replaces it
      if the relay sends it again. **Still to be checked on a phone**: that
      a kept chat's file has complete protection after it is saved a second
      time. The
      simulator keeps no file protection, so it could not show it; the
      plugin's "protection" call does, on the next TestFlight build.
      Reading the sessions of a host that has gone away
      (a laptop asleep), marked offline, is a later feature for both apps
      (`roadmap.md`).
    - **The first version is a core**, to TestFlight and Play internal
      testing and in daily use before the rest: joining by a link or QR
      code, the Face ID lock, the session list and the chat live, prompt
      and stop, pi's questions, and notifications. It replaces the Remote
      Pi app, and the adapter is retired then. After it, as screens on the
      same foundations: images and drafts, the session's actions, the
      session tree, starting and stopping pi, then hosts and devices,
      which stay on the web app meanwhile. Reason: the parts only a real
      phone tests (the connection, the background, push, keys) are proved
      first, on a small app.
    - **The Native look** first, the one designed for phones (`web.md`,
      section 5), with Flutter's iOS and Android widgets. Built so that
      another look is a theme, not a rewrite; Quiet, Triage or Cockpit
      follow if missed. Code in replies is highlighted as the web app
      highlights it (2026-11-04): by `re_highlight`, a Dart port of the
      same highlight.js, with the same common languages, and only a block
      that names its language. The session's actions (2026-11-04), from
      the chat's "…", as the web app's: model, thinking level, cost and
      context, compact, rename, reload, clone, resume, a new session and
      stopping pi, with the header's cost and context and the line under it
      for what an action answered. pi's session tree (2026-11-06), as the
      web app's: tapping one of the user's messages that pi has saved offers
      going back to before it, with or without a summary, or a fork from
      there, and puts the message back in the composer; Branches in the
      session's actions lists the others, to switch to one, again with or
      without a summary. Text in a chat is selectable (2026-11-09, as
      decided for the web app too): what is read, that is replies with
      their code and tables, the user's messages, thinking, opened tool
      calls, summaries and pi's questions, and not the controls. A long
      press selects within one message, never across the list, with the
      system's handles and menu (Copy, Select all, Share); a tap that ends a
      selection only ends it, so a message's own tap (going back) is the
      next one, and a tap beside it or on another message ends it too, a
      scroll not. What is copied keeps a line for each paragraph, item and
      row, a table's cells apart by tabs (an empty one a space), where
      Flutter would run them together; a tool call's headings are left
      out. Copy under a reply and on a code block are kept as they were: the
      reply's Markdown, the code. A chat with nothing to scroll counts as at
      its end, as the web page's does, so that one made short by going back
      shows its end rather than a button to go there. A new agent beside a
      running pi (2026-11-06), as the web app's: + on a tmux session's or
      herdr workspace's line, or on a host's when its sessions are all in
      one, and New agent in the session's actions, where its pi has a
      launcher; in that pi's folder, one of the host's live or saved
      sessions', or one typed in, its window named after the folder unless
      named there; the new pi's chat opens once it connects, and after 45
      seconds the sheet says it has not yet. The + is right after the
      host's or group's name, before its counts (decided 2026-11-10, as
      the web app's), so that the chevron is always at the end of the
      line, with a + or not, and the + reads as a new agent in that name;
      the name takes at most 60% of the line, so that a long one leaves
      the + in view. A sheet asking for text
      (renaming, a new agent) rises above the keyboard, where the web app's
      goes to the top. Settings (2026-11-06), from the button beside the
      list's title, as the web app's: this phone's, kept on it, the lock,
      how long it holds (both above) and notifications. Notifications have
      a switch of their own (the owner's choice, 2026-11-06): off
      unregisters this phone's push at the relay, so that the relay stops
      waking it, which the phone's own Settings cannot do; on registers
      again, asking the phone first if it has not been asked, and where the
      phone refuses them the line under it says so, with a way to its
      Settings. The web app's look and keys have nothing to set here, and
      its test notification waits for a relay request to send one.
      Machines asking to join (2026-11-06), as the
      web app's: a line on the session list for each, and a sheet with its
      key, to compare with what /pirc status shows on it, where it asked
      from and what it runs, a name for it, and Approve or Reject; it
      closes once the relay no longer lists it, decided here, elsewhere,
      or expired. The relay's hosts and clients (2026-11-06), as the web
      app's: two sections of Settings, each online or not and this phone
      first among the clients, one tapped to rename, or remove after Remove?
      and Back; this phone's own row has no Remove, since the relay refuses
      a key's removing itself, as the web app's own has none. Removing the
      web app's server, through which every browser signs in, asks no more
      than removing any other client, as in the web app (decided
      2026-11-06): neither app can tell it apart yet (`roadmap.md`).
      Adding a host or an app (2026-11-06), as the web app's Invite: a
      one-time token from the relay, valid for 15 minutes, shown once with
      its expiry and kept only in the sheet's state, gone when it closes; a
      host's as the /pirc enrol line, an app's as a pirc://join link and its
      QR code, drawn from the `qr` package (pure Dart, BSD-3-Clause, the
      encoder qr_flutter uses), since an encoder of our own would save
      nothing. Copied, it stays on this phone (iOS's local-only clipboard,
      cleared when the token expires) and Android marks it sensitive, so
      that the clipboard's preview hides it. While a token shows, the
      screen is kept out of the app switcher's snapshot, which is written
      to disk (2026-11-06): Android's FLAG_SECURE, and on iOS a plain cover
      as the app goes inactive, both cleared when the token expires or the
      sheet goes, a relock included. Licences (2026-11-06), the last row of
      Settings: Flutter's page of them, with the app's name and its version
      as the build gave it, from the NOTICES file every build carries, which
      Flutter writes from the Dart packages and itself, and on Android
      the notices of the libraries Gradle adds (2026-11-06), which it
      leaves out: written at each release build from the dependencies it
      takes, each library's licence named by its POM (or a parent's) with
      the full text kept in `app/android/notices/`, the two BSD parts whose
      copyright the POMs leave out given by hand (libyuv in CameraX,
      protobuf-lite in AndroidX's datastore), and the notices that Google's
      closed libraries (Play services, Firebase, ML Kit) carry inside them;
      a licence the build does not know stops it, so a new Maven
      dependency cannot go out unlisted (a library added as a file would
      need its notice added by hand; there are none). Written from the build, not kept as a list,
      so that it cannot fall behind the dependencies. A host's page and
      a group's (2026-11-06), as the web app's scopes: the name in a host's
      or group's line opens it, over the list, the rest of the line still
      folding; on it, only that host's or group's sessions, their counts
      and search, a way back to the level above, and New agent where they
      are all in one group; a chat opened from it goes back to it. Tables
      in replies (2026-11-06), as the web app's: one wider than the reply
      keeps its first column in view while the rest scroll under it, the
      edge that hides more shaded, and Full screen opens it on a page of
      its own, where a phone turned sideways shows more. The iPad and
      other wide screens (the owner's choice, 2026-11-06): the app stays
      built for iPad, as it has been (both device families, every
      orientation, Split View and Slide Over), and at 1024 points or wider,
      as the web page's breakpoint, the list sits in a column of 380 beside
      the chat or Settings, the chat's row marked and neither with a way
      back; narrower (an iPad mini or Air upright, Split View, every phone)
      it is as on a phone. The same rule holds by width on Android, for
      tablets and opened foldables. Crossing the width keeps what is open.
      With it come, at the App Store submission (not TestFlight), iPad
      screenshots and Apple's review on an iPad. Rejected: iPhone only,
      which Apple does not let a later update undo for an app already on
      iPad. Images (2026-11-04),
      as the web app's: a message's as thumbnails that open full screen,
      and pictures chosen from the phone's photos, made to fit pi's limits
      as they are picked (the platform's picker, which asks for no
      permission), or taken with the camera, as the web's file input offers
      on a phone (2026-11-04, the owner's choice): the composer's button
      asks which, the photo goes through the same picker at the same size
      and quality and the same checks, and Android asks for the camera as
      it opens, as for the join scanner. The camera's purpose string, the
      owner's words: "PiRC uses the camera to read a join code, and to take
      a photo you choose to send in a message." Drafts (2026-11-04), as
      the web app's: a file per chat in the private folder, for a week, the
      newest hundred.

    **Still to do before the app starts** (not decisions):
    - **Reaching the relay.** A self-hosted relay on a private network
      needs the phone's VPN set to connect when needed, or notifications
      are mostly the fixed text and the app is empty away from it. The
      author's phone is set so (2026-11-02).
    - **Accounts and names**, set up by the owner: a Google Play console
      (made, in Google's identity review, 2026-11-06). **Before the first
      Play upload** (internal testing, cleared 2026-11-06; the app is
      "PiRC: Pi AI Coding Agent" in the store, PiRC on the phone, paid
      (free with a subscription since 2026-11-08, step 15),
      with Play app signing): the notices of the Android libraries Gradle
      adds, now in the build (Licences, above); and an upload key, made
      2026-11-06 (RSA 4096, PKCS12, valid to 2054), which Play checks each
      upload against while it signs the app with its own key. The key and
      its password are kept by the publisher outside the repo and given to
      the build as environment variables (app/README.md); a release build
      without them stops rather than sign with another key, since a first
      upload signed with any key would make that key the upload key. The
      build number is one counter for both stores (pubspec.yaml), so
      Android's first bundle is 1.0.0 (5), after iOS's 1.0.0 (4). The Firebase project
      for Android's pushes is set up, and the push gateway's credentials
      for Google come from it. The push gateway runs
      at `push.pirc.dev` (decided 2026-11-03). The Apple developer account is set up and paid
      (2026-11-02). The bundle IDs are decided (2026-11-03), under the
      publisher's domain: `dev.pirc.app` for the app on iOS and Android,
      `dev.pirc.app.notifications` for the iOS notification extension;
      Play fixes its application ID at the first upload.

    **Export compliance** (decided 2026-11-03): the app declares
    `ITSAppUsesNonExemptEncryption` false, in the app's and the
    notification extension's Info.plist, so that App Store Connect does not
    ask for each build. Its encryption is all exempt: TLS for its
    connections, through the platform; Ed25519 signatures that
    authenticate it to the relay; and the platform's Keychain and Keystore
    (AES-GCM on Android) for its keys at rest. Nothing proprietary, and no
    encryption of what it shows beyond the standard protocols. End-to-end
    encryption of announcements, if it comes, is a change to revisit this.

    **Where it lives** (2026-11-03): `app/`, a Flutter project outside
    the pnpm workspace. Its Dart types are generated from `proto/` by
    `buf.gen.dart.yaml`, apart from `buf.gen.yaml`, so that
    `sh/generate.sh`, the relay, the web app and their deploy need no
    Dart; `sh/app.sh` generates them and runs `flutter analyze` and
    `flutter test`, which `sh/check.sh` runs when Flutter is on `PATH`
    and otherwise says it skipped. The client logic it ports from
    `web/core` is held to the same cases (`cases/`).

    **How the toolkit was chosen** (Flutter, decided 2026-11-01). Mostly
    because the app is written by agents: they check a screen in
    Flutter's tests without a simulator, its toolchain is one and changes
    slowly, and its publishing has no layer between it and Apple's and
    Google's tools. What React Native would have shared is small. What
    weighed:
    - *What could be shared.* Only `web/core`, about 1,400 lines: the
      live sessions, chats, requests and their results. The page is
      React for a browser and is not reused by either. The relay
      connection (`relay-client`) is Node's and is written again for
      either. With Flutter, `web/core` is ported to Dart and kept in step
      with the TypeScript, best by test cases both run: recorded relay
      frames and the views they must produce.
    - *Native code either way.* iOS's notification extension is Swift
      whichever is chosen (above), and so are the key's storage and the
      push registration's glue.
    - *Agents building it.* The app is to be written by agents, so what
      matters is how fast they can check their own work. Flutter's tests
      draw widgets, and compare them with saved images, without a
      simulator, and one toolchain (`flutter analyze`, `flutter test`)
      covers it; Dart and Flutter change slowly. React Native's tests
      do not draw, so seeing a screen needs a simulator, and its stack
      (React Native's releases, Expo's every few months, native modules)
      changes faster than what agents know of it. TypeScript is what
      agents know best, and the repository's other code is TypeScript.
    - *Publishing.* The same for both where it is hard: Apple's signing,
      provisioning and review, Google's console and review, TestFlight
      and Play internal testing; iOS builds need a Mac. Expo adds a
      layer over it (cloud builds, managed signing, updates of the
      JavaScript without a store release), which helps or gets in the
      way; Flutter builds with its own commands (`flutter build ipa`,
      `flutter build appbundle`) and uploads with Apple's and Google's
      tools or fastlane, with no hosted service of its own.
14. **Hosted relay**: multi-tenancy, end-to-end encryption and device-signed
    registration (section 5).
15. **Open**: licence, public repository, pirc.dev, store listings.
    Planned 2026-11-07, for self-hosters first: it does not wait for the
    hosted relay (step 14), which comes after as its own release, and
    until then the store listings say plainly that the app needs a relay
    of one's own. The plan was reviewed independently the same day
    (Claude Opus 5.5), which found what is folded in below.

    **Decided** (2026-11-07):
    - **Licences**, all open source, by part (decided 2026-11-07):
      - MIT for what runs on other people's machines or is meant to be
        reused: the extension, what it shares with the clients
        (`proto/`, `protocol/`, `relay-client/`, `cases/`), the push
        gateway, and the rest of the tree (`sh/`, `test/`, `docs/`).
      - AGPL-3.0 for the relay and the web app, which run as services:
        whoever runs a changed copy for others must publish their
        changes. It does not forbid hosting; it deters it, as it does
        for Grafana and Immich, and a hosted relay of the publisher's own
        (step 14) is free to be built on it, since the publisher holds
        the copyright.
      - GPL-3.0 for the mobile app, as Blink Shell's (a paid iOS app
        whose source is public) and Signal's: anyone may build it for
        themselves, but on Apple's App Store, whose terms conflict with
        the GPL's in the Free Software Foundation's reading, only the
        copyright holder can safely publish it. No additional permission
        for Google Play services and Firebase, as Signal gives none: a
        copy conveyed to others must leave them out, and with them
        Android's notifications, while the publisher, holding the
        copyright, needs no permission for its own builds. The owner
        wanted no one else to publish the apps in a public store, and
        private builds (TestFlight, an organisation's own devices) left
        free; only a licence of PiRC's own could say exactly that, and
        not an open-source one, so GPL-3.0 was taken as the nearest:
        a Play copy remains possible, renamed, without notifications,
        with its source published. Nor can the GPL forbid charging for
        a copy.
      - The names and the icon are protected by a trademark policy
        (`TRADEMARKS.md`), which does more against store copies than
        any code licence.

      The source-available licences weighed first, the Functional
      Source License, the Business Source License and PolyForm, were
      set aside: they come from companies protecting a hosted service,
      and the Business Source License's fixed terms allow anyone to
      redistribute, so its grant could not forbid a store copy. The
      gateway is MIT although it is a service, since it is of no use
      without the publisher's Apple and Google credentials; so it must
      not link the relay's AGPL packages, which a check enforces. The
      mobile app is paid in both stores; since 2026-11-08 a free download
      with a subscription (below).
    - **Price** (decided 2026-11-08, as Blink Shell's): the app is free to
      download, with a paywall until subscribed: one auto-renewing yearly
      subscription, £19.99 / $19.99, the stores pricing other countries
      from it, sold only through the stores (Apple's in-app purchase, Google
      Play Billing), since Apple requires in-app purchase for unlocking an
      app's features (guideline 3.1.1) and PiRC is neither a reader app
      nor a companion to one of the web services 3.1.3(f) names. Rejected:
      payment on the web with Stripe, as Spotify's (Spotify is a reader
      app; iOS would still need in-app purchase beside it, 3.1.3(b), and an
      account service of the publisher's to tie a web payment to a phone).
      The trial is the stores' own: an introductory free trial of 14 days
      on the subscription, started in the store's sheet, as Blink's;
      an app-counted trial was rejected, since App Review expects a
      subscription's trial set up in the store (3.1.2(a)) and an Android
      reinstall could reset it. While locked out, iOS notifications show
      only the fixed text and Android's none; Family Sharing is off; the
      Play build links only the privacy policy.
      The paywall offers the subscription and restoring a purchase, with
      the Terms of Use (Apple's standard licence) and the privacy policy;
      the stores handle payment, and the app learns only whether a
      subscription is active. A build from source has no paywall
      obligation under the GPL; the stores' builds are the publisher's.
      Built with the stores' own libraries in the app's plugin, StoreKit 2
      on iOS and Play Billing on Android, over 'dev.pirc.app/store'
      (`lib/app/store.dart`); rejected: Flutter's `in_app_purchase`, a
      layer over the details that matter here (grace, billing retry,
      pending purchases, Play's acknowledgement), and RevenueCat, whose
      service would see every purchase and an identifier for each phone.
      The store's answer is one of: allowed (the trial, paid, or in the
      store's billing grace period, which is turned on in both stores),
      a payment problem (past the grace, the store still retrying),
      ended, or never subscribed; only allowed opens the app. On iOS
      (built 2026-11-08) a transaction counts when StoreKit has verified
      it, it is not revoked, and StoreKit lists it among the current
      entitlements, which take in the grace period, so the app does not
      compare an expiry date with the clock; offline StoreKit answers
      from what it keeps on the phone. Allowed past its period's end is
      the grace after a failed payment, reported as not in the trial and
      with no end. The grace, the retry and whether it renews come from
      the store's servers, asked for at most 3 seconds, and are unknown
      offline. Any transaction at all, even unverified, rules out "never",
      so that an account that has had the trial is not offered it.
      Transactions that come outside a purchase (renewals, refunds, an
      approved Ask to Buy) are listened to from launch, as Apple asks, and
      from iOS 17 changes that bring none (grace, a failed payment,
      renewal turned off); the rest, and whatever happened while the app
      was not running, the app learns by asking again on coming to the
      front and after the store's own pages. A purchase may wait for
      approval (Ask to Buy, or a bank's own check).
      Tested against StoreKit's test store with the product as in App
      Store Connect; that store does not answer on Xcode 26.3's own iOS
      26.3 simulator (an Apple bug), so the tests run on iOS 18.6's.
      The paywall (built 2026-11-08, `lib/ui/paywall_screen.dart`): in
      place of everything else while the store does not allow the phone,
      before joining too, decided with what the app loads at its start
      and so before the key is asked for, which a phone locked out is
      not, nor does it connect. It offers the store's free trial where
      the account can still have it ("Start your 14-day free trial", its
      terms said under the button before the store's sheet opens: free for
      the trial's days, then the store's price a year, renewing until
      cancelled), the subscription otherwise, "Your subscription has
      ended", "There's a problem with your payment" (whose button opens
      the store's page), and "Waiting for approval", which the store does
      not say and the app keeps across a restart, with a way to ask again
      (given up, as after a request declined, it is no longer waiting);
      the amount billed under the title, as large as anything but it;
      Restore, which says when there is nothing to restore, the Terms of
      Use and the privacy policy. The status is asked for again on coming
      to the front, after the store's sheets and pages, and when the
      store says something changed; allowed no longer, what is open
      closes as on locking, with nothing deleted, and allowed again the
      app opens as it would. One ask of the store runs at a time, and one
      unlock: an unlock under way when the phone stops being allowed (Face
      ID asked) does not connect, and locking again after the hold asks
      the store before Face ID. A purchase that never answers (decided
      2026-11-10, found on TestFlight build 7: after Apple asked for the
      password twice, StoreKit's purchase did not return while the app
      ran, and the subscription showed only after a restart) does not hold
      the paywall: the store's saying allowed, on a change or on coming to
      the front, lets the phone in whatever the purchase is waiting for,
      and the paywall waits for the store's answer no longer than 30
      seconds with the app in front, counted again from each of the
      store's sheets (its password prompts, Play's purchase), which take
      the app from the front: giving up on every return would let the
      person buy again between Apple's two prompts. An answer that comes
      after is said, unless something newer was begun, and a purchase's
      late answer changes no newer purchase's waiting. While it waits, its button
      keeps its colour and label with a spinner beside it, where a
      disabled button's fill was nearly black in dark mode. On iOS the
      purchase is confirmed in the app's scene in front, as Apple asks of
      an app with scenes, from iOS 17, and the 3 seconds for the store's
      servers are kept even when their call goes on, which a task group,
      waiting for every child, did not. Settings has the subscription: the trial
      and when it ends, when it renews or ends, a failed payment and the
      date to fix it by, and the store's page. Notifications while not
      allowed: the extension takes the time the app left in the App Group
      ("store.until": the period's or grace's end and 3 days, so that a
      renewal while the app is not opened does not silence them), and
      past it asks StoreKit itself, for 3 seconds at most of iOS's 30; when
      neither allows it, nothing is fetched and the fixed text shows. A
      refund therefore stops them only at that time, or when the app is
      next opened. That StoreKit
      answers in the notification extension is to be seen on a phone, on
      the next TestFlight build. Play Console creates a subscription only
      for an app whose uploaded build asks for the billing permission, so
      Play Billing 9.1 went into the plugin first on its own (build 6,
      2026-11-08), unused; after that upload, licence testers can buy
      against Play from debug builds on the emulator, and Android's half
      was built and tested that way (2026-11-09, `Store.kt`). On Android
      (decided 2026-11-09) the app has what Play Billing tells the phone,
      and no more: whether the account has the subscription, active (the
      trial, paid, or in Play's grace) or suspended (on hold after the
      grace, the payment failed: "There's a problem with your payment",
      whose button opens Play's page for it; pausing is off in Play
      Console, since a paused one is suspended too), whether it renews,
      and the free trial, which Play offers only to an account that has
      never had the subscription, so that its absence tells "ended" from
      "never". Play gives the phone no dates, nor whether it is the trial:
      Settings says "Renews every year" or "Won't renew", and the paywall
      for an ended subscription also has Play's page, where a cancellation
      or a payment is set right. Rejected: a server of ours asking Google's
      API for each purchase's dates and state, which would see every
      subscriber, and break the privacy policy's word that the app sends
      PiRC nothing about the subscription. Each purchase is acknowledged
      to Play when bought and at every status, since Play refunds one not
      acknowledged within 3 days. Play has no restore: the account's
      purchases come with each status. The paywall names Google Play and
      links only the privacy policy. Notifications while not allowed: the
      wake (lib/push/wake.dart) asks Play for 3 seconds at most, and when
      it does not answer goes by store.until, which the app sets to 3 days
      after it last saw the subscription allowed; not allowed, nothing is
      shown, not even the fixed text.
      Review access (decided 2026-11-10): the stores' reviewers must get
      past the paywall without paying. Google says it cannot create
      accounts, make purchases or use free trials to review an app, and
      asks for access details for anything behind a subscription; Apple
      asks for a working demo. So while the phone is joined to PiRC's
      review relay, `wss://review.pirc.dev`, built into the app
      (`reviewRelay`, `lib/app/store.dart`) and compared exactly, it is
      allowed as if subscribed, notifications too (the wake and the iOS
      extension). The store's own answer is still asked for and kept as it
      is, store.until included; leaving that relay, or any other, has the
      store's answer again. Settings says "Review access" in the
      subscription's section, with the store's status beside it only when
      the store allows the phone. That relay runs one demo host of
      PiRC's, so whoever joins it gets only that demo, never their own
      machines: the unlock gives nothing away. It is keyed on the joined
      relay, which only a link that relay's owner issues can make, rather
      than on a code, a switch or an account, which could be passed on or
      found in the app; there is no other way past the paywall. A fresh
      install still opens on the paywall, which has "Join with a link"
      while the phone has not joined (the join screen, with Back to the
      paywall), and a pirc://join link opened from outside while it is up
      opens the join screen with it, joined only on a tap, as before. Any
      relay may be joined from there: one other than the review relay
      leaves the paywall up, not connected until the store allows the
      phone, which is where a lapsed subscription already is. Rejected:
      refusing other relays before paying, a second rule with its own
      error for nothing gained, since a joined phone with no subscription
      can do nothing.
    - **The public repository** is on GitHub, in an organisation of its
      own, `pirc-dev` (matching pirc.dev; `pirc` is taken), owned by
      Justino Ltd and made 2026-11-07, not under the owner's account, and starts from one commit
      of the tree as it is on the day. The private repository's history
      is archived, and its main branch starts again from that same
      commit, so that both have one history from then on: the work and
      the deployment stay on the private repository, which mirrors each
      push to GitHub. Tags start again too, so that a public clone builds
      with a real version (`sh/build.sh`). Only that tree is checked for
      secrets and for details of one installation, not every past commit.
    - **One repository**, not one per licence: a change usually spans the
      schema, the extension, the relay client and both apps, the checks
      run them together (`cases/`, the end-to-end tests), and the
      deployment builds from one commit. The cost is that GitHub shows
      one licence per repository, so the root `LICENSE` and the README's
      first lines say which directories are under which licence. Revisited when the protocol leaves `v1alpha1`;
      a split then would be two repositories, the MIT parts and the two
      apps together, since the apps share `cases/` and the client logic.
    - **Commits are the owner's**, as anywhere else: author and committer
      Igor Soarez, `igor@soarez.org`, and the GitHub account acting on the
      repositories (creating them, releases, pushes) is his, `soarez`
      (2026-11-11; before that, from 2026-11-07, commits were to name the
      company, PiRC `github@pirc.dev`, and the owner's name nothing
      published). The copyright stays Justino Ltd's (`LICENSE`, `NOTICE`,
      `web/LICENSE`, since 2026-11-07), and contacts are the company's,
      on pirc.dev (2026-11-08): support@, privacy@, security@ and github@,
      every address there reaching the owner's inbox; the company is
      named where the law requires it (a website's company disclosure, a
      privacy policy's controller, the trademark notice). The extension's
      repository, which moves to GitHub, starts again from one commit too.
    - **No outside contributions for now**: issues are welcome, pull
      requests are not taken, as `CONTRIBUTING.md` says; opening up later
      would need a contributor agreement, since the publisher must hold
      the whole copyright to publish the apps in the stores.
    - **The extension's package repository moves to GitHub**, into the
      same organisation. The
      deployment keeps the old one up to date for a while, so that
      existing installs keep working, until the owner's machines have
      moved.
    - **The adapter is retired first**, now that the owner uses PiRC's
      app (iPhone, iPad and Android) and the web app in place of the
      Remote Pi app, and has no use for it (2026-11-07): `adapter/`, its
      tests and what refers to it are removed, and the Remote Pi app is
      no longer supported. Its sections here (section 10, the decision
      table's First client) stay as history, marked retired.

    **In order** (3 to 6 may run side by side):
    1. This plan, reviewed independently.
    2. **The adapter retired** (above). The deployment stops building
       and installing it before the code goes, or every deployment would
       fail; then the code, its build and checks, and what refers to it
       (`CLAUDE.md`'s exception for Remote Pi's protocol, the docs).
    3. **Licences** (above): the root `LICENSE`'s preamble rewritten,
       since it covered `web/` and `app/`; a `LICENSE` in each AGPL and
       GPL directory; the gateway's link to the relay's server package
       moved into an MIT one; each build carrying its own licence, the
       extension package only MIT (`sh/build.sh`); `NOTICE`, `README.md`,
       `CONTRIBUTING.md` and `TRADEMARKS.md` to match.
    4. **A first app without another client** (roadmap, smaller item 7):
       `pirc-relay add-client` gives the `pirc://join` link and its QR
       code, so that a self-hoster's first phone joins without the link
       written by hand. App Review's relay (8) uses it too. Done
       2026-11-07: `add-client --url` (section 5.3).
    5. **The repository ready for strangers**:
       - a README for someone meeting PiRC for the first time;
       - `CLAUDE.md`'s rule against one installation's details naming
         the publisher's own identifiers as allowed (the Apple team, the
         Firebase project, `push.pirc.dev`), and the Firebase API key in
         `app/android/app/google-services.json` checked to be restricted
         to the app, since it will be public;
       - `docs/gateway.md` brought up to date (pushes now go through
         Apple and Google), and `docs/self-hosting.md` telling a relay to
         use `push.pirc.dev`, then followed from nothing on a clean
         machine and corrected, once the downloads (6) and the
         extension's new home are known;
       - the tree checked for secrets and installation details, again on
         the day it opens (9).

       Done 2026-11-07 but for what waits on (6) and the extension's
       move: the README rewritten for a newcomer; the rule in `CLAUDE.md`;
       `docs/gateway.md` and `docs/web.md` brought up to date;
       `docs/self-hosting.md` covering the web app, and the relay's
       `env.example` setting `push.pirc.dev`; the tree checked, with no
       secret in it but the Firebase API key, which is public by design,
       and test fixtures named after the owner's machines renamed. Still
       open: the Firebase key's restriction to the app and to the
       Firebase APIs it calls (the owner's, in Google Cloud: it is
       unrestricted; decided 2026-11-08, to be done before opening, with
       every signing certificate, Play's included; done 2026-11-11: the
       key accepts only `dev.pirc.app` signed by Play's app-signing
       certificate, the upload key's or the development machine's debug
       certificate, and only the Firebase Installations and FCM
       Registration APIs; checked by calls with each certificate, a wrong
       one and none, and its usage showed one refused call to the
       Geocoding API from elsewhere, not enabled in the project), the extension's address in the
       README and `docs/self-hosting.md` once it has moved, and the walk
       from nothing on a clean machine.
       Done 2026-11-11: the walk, on a fresh Ubuntu 24.04 from the v0.3.0
       downloads, the relay with a private CA's certificate, two hosts
       (approved, and with a token), the web app and a phone's link, and
       a stranger's read of the repository; the guide was put in the order
       it is followed and corrected. Found then and left for a release:
       `pirc-web enrol` reports an untrusted certificate as no answer from
       the relay; the registry commands, run without the relay's data
       directory, show an empty registry rather than saying which one they
       read; the relay logs that it listens before loading its
       certificate; a wrong token is reported as an unregistered key; the
       release archives carry the builder's owner and group-writable modes.
       Checks on GitHub (2026-11-11), since a visitor should see the
       project's state and outside changes may come: `sh/check.sh` on
       Linux with pi and tmux, so the end-to-end tests too, and the mobile
       app and the iOS notification extension on macOS, without the golden
       images, which GitHub's Macs draw about 3% differently.
    6. **pirc.dev**: what PiRC is, how to self-host, support, a privacy
       policy (both stores ask for its address; it covers the push token
       sent to `push.pirc.dev` and to Apple and Google), and downloads of
       the relay and the web app. Live since 2026-11-08 at
       `https://pirc.dev`, from its own repository (an Astro site on
       Cloudflare Pages), its privacy policy covering the apps, the push
       gateway and the site; downloads, the source and store links are
       added at opening. Decided 2026-11-08: the relay and the web
       app are released again, on GitHub, so that a self-hoster needs no
       toolchain: each tag publishes the relay for Linux (amd64 and arm64)
       and macOS, and the web app's bundle; the self-hosting guide starts
       from a download. No container image yet. Built 2026-11-11:
       `sh/release.sh` writes the relay's four archives
       (`pirc-relay-X.Y.Z-<os>-<arch>.tar.gz`), the web app's and the
       extension's, and runs both end-to-end tests against this machine's
       relay, the web bundle and the extension package before the
       checksums; `sh/publish-release.sh` attaches them to a GitHub
       release of a tag already pushed there, after checking the tag is
       the commit they were built from. The README and the self-hosting
       guide start from the download, building from source kept as the
       alternative. A snapshot's Linux relays and web bundle ran on arm64
       and amd64 machines. The macOS relay is signed ad hoc only, as Go
       links it, so macOS refuses to run one a browser downloaded until
       its quarantine mark is removed, which the guide says; signing it
       with the Apple developer team's Developer ID and notarising it
       would remove that step, not done yet.
    7. **Store listings.** The owner's, started early, since Apple's take
       days to approve: the price, Play's payments profile, Apple's Paid
       Apps Agreement with its banking and tax forms, and the EU's trader
       declaration in both stores (it publishes the trader's address,
       phone and email on the listing). Drafted for the owner's review:
       each listing's text, screenshots (iPad's too), Play's data-safety
       form and content rating, Apple's privacy labels, age rating and
       support address. In the app: an iOS privacy manifest
       (`PrivacyInfo.xcprivacy`), which App Store submission requires for
       the app's use of `UserDefaults`. Needs the privacy policy (6).
       Done 2026-11-08: one in the app and one in the notification
       extension, since Apple reads each bundle's own; both declare
       `UserDefaults` for the App Group they share (reason `1C8F.1`; neither
       uses the standard defaults), no tracking and no data collected. The
       app's other calls on Apple's list were looked for, and the one found,
       the file attributes the plugin's "protection" check read (which
       carry the file's dates), was replaced by the file's resource
       values, which need no reason. The plugin is built into the app, not
       a framework of its own, so the app's manifest covers it; the other
       packages (Flutter, the scanner, the photo picker, the link opener,
       SwiftProtobuf) bring their own, and `path_provider` reaches iOS
       through `objective_c`, whose native part has none and was looked
       through for the listed calls, finding none. Apple's processing of the next
       upload is the check.
       The subscription (Price, above): the paywall, the trial and
       restoring in the app; the subscription in both stores (one
       subscription group on Apple's side), which needs the paid
       agreements, banking and tax first; App Review given a sandbox
       account's way through it.
    8. **A relay for App Review**, with a pi session behind it, kept up
       while Apple reviews each version, since the app shows nothing
       without a relay; its join link goes in the review notes. Decided
       2026-11-10: on one of the publisher's servers, in a rootless
       container that a reviewer, or the model, may run anything in, so
       locked down: a read-only root, no capabilities and no host mounts,
       limits on memory, processes and CPU, and no way out but a proxy to
       the model's provider and the push gateway, nothing of the server's
       own nor of the networks it is on; closed to hosts (5.3), so that no
       one holding a reviewers' link can bring a computer of their own onto
       it and use the app on it unpaid. One pi in a small sample
       project, on a cheap model whose key has a monthly limit of its own,
       and at most three agents at once; the container starts again if
       the relay or pi goes or a client removes the host, which then enrols
       again, and the sample is reset at every start. Each store gets
       its own reusable link (5.3), so that its reviewers' devices are told
       apart from the other's; an hourly check warns before a link expires
       or the model's money runs out, rather than a review failing on them. It is
       rebuilt at each submission, at the version under review. Done
       2026-11-10, at `wss://review.pirc.dev`.
    9. **Opening**: the tree checked again; the Firebase key restricted
       (5), if not already; the GitHub repository
       published and the private history archived (above); the
       extension's repository moved; both apps submitted for review and
       then released; pi's users told. Decided 2026-11-11, after Apple's
       review of build 7 was withdrawn (2026-11-10) to fix the paywall:
       neither app goes to a store's review for public release until the
       repository is published; until then the apps go on improving on
       TestFlight and Play's testing tracks, and pirc.dev, redesigned and
       live the same day, is updated once the source is public.

       Done 2026-11-11, but for making both repositories public: the
       tree checked again (no secret but the restricted Firebase key, no
       installation's details); the private history, its branches and
       those of every checkout archived, and the archive found in the
       backup; the opening commit `c81c310` (the tree of `d4ea366`, no
       parent, the owner's) tagged `v0.3.0`, not `v0.2.0`, which `NOTICE`
       already holds as a dependency's version and which the
       deployment's comparison with the version masked would then have
       seen as a change everywhere; the private repository's master
       restarted from it, its other branches and the `v0.1.x` tags
       removed, each checkout moved onto it; the private repository
       refusing a master or tag whose history does not start at that
       commit alone, a master that does not move forward, a moved or
       deleted tag, and replace refs, and copying master and the tags to
       GitHub after each push (the publisher's deployment, not this
       repository); GitHub's `pirc-dev/pirc` and `pirc-dev/pirc-extension`
       made private, the latter starting from the extension's 0.3.0
       release as its one commit, the same tree as the release in the
       old extension repository, which the owner's machines keep
       following until they move; release 0.3.0 cut and its downloads
       published on GitHub, checked against their checksums once
       downloaded.

## 13. Review log

**2026-10-20.** The design and plan were reviewed independently by Claude
Fable 5.1, GLM 5.3 Flash and DeepSeek V4.1 Flash (1017); all three verdicts
were "proceed with changes". Adopted after checking each claim against pi
1.0.0 and the Remote Pi source: session control is command-only and replaces
the extension's context (section 8); pi processes change session (section 4);
one host key across many pi processes (section 4); the adapter's own registry,
rooms that follow processes, and the `/mesh` stub's danger (section 10); no
tool approvals or extension dialogs in the first client; a security section;
protocol v0's handshake, turn IDs, sequence numbers, idempotency and limits
(section 7); TLS by default with plaintext as a setting (section 5.1);
self-hosting and packaging as a plan step; adapter v0 before actions; corrected
counts and causes. Not adopted: limiting plaintext to private addresses (an
explicit setting is enough); a daemon for sessions that outlive the terminal
(out of scope; the first user does not use Remote Pi's).

**2026-10-21.** Relay v0 (commit `f42e5a3`) was reviewed independently by
Claude Fable 5.1, GLM 5.3 Flash and DeepSeek V4.1 Flash (1017): "ship with
fixes" twice, "do not ship" once. No reviewer found a way past login
without a valid token and signature, a spoofed sender key, or a host
speaking for another host's session. Fixed, each with a test that fails
without the fix: a key removed during its own login kept access; one slow
peer stalled the relay for about five seconds, because the close handshake
ran under the relay's lock; send queues were bounded by frames, not bytes;
the session list could exceed the announced frame size; an unreadable
registry let the last good copy keep authorising logins; no limit on
sessions per connection or on connections not yet logged in; a connection
could be left behind by a login that failed after admission; proto comments
that disagreed with the code; and smaller items (registry change detection
by time and size, durable renames, field length limits, a clean close on
shutdown, validation of `--max-frame-bytes`). The `registry` package gained
its own tests. Not adopted: a collision between session references with a
forged short host key, which can only reach the real session.

**2026-10-22.** Extension v0 (commit `699940e`) was reviewed independently by
Claude Fable 5.1 and GLM 5.3 Flash: "do not ship" and "ship with fixes". Both
confirmed the turn-ID approach, event ordering, isolation of the extension's
errors from pi, key and configuration handling, and that no token or payload
is logged. Fixed, after checking each claim against pi 1.0.0: a message from
another extension stalled the event stream for the rest of the session, and
the two-second fallback meant to release it never fired; a prompt pi refused
(during compaction, with no model or no credentials) was still answered
`Accepted`, and a retry got the same answer from the cache; an item too large
for a frame, such as a few pasted screenshots, was dropped unseen, and History
could come back empty; the idempotency cache spanned sessions, so a request ID
reused after `/new` was never run; no login deadline; requests during
`/reload` got `SESSION_GONE` instead of `BUSY`; a throwing callback in the relay
client could crash pi; the double-load guard never fired; sequence numbers
restarted on a return to a session; prompt echoes with images went unmatched;
a fractional token count would throw; the `deferred` stop reason was unmapped
(`STOP_REASON_DEFERRED` added); and claims about confirmation in sections 7
and 12 that the code did not bear out.
Not adopted yet: packaging without `workspace:` dependencies (step 9).

**2026-10-22.** The adapter's specification (`docs/adapter.md`, before any
code) was reviewed independently by Claude Fable 5.1 and GLM 5.3 Flash; both
said to fix it first. Adopted after checking each claim in the app's source:
PiRC starts a new turn at a steer, and the app's single streaming bubble,
keyed by the reply's ID, would have lost the text streamed so far, so the
adapter keeps one ID per working span, as Remote Pi's own extension does; the
app keeps a room's first name for good, so room names are host and folder,
which never change; `agent_done` must reach the app before the room's idle
state, or the app throws away the streamed reply; a room with no live
session gets no history, which would wipe the chat the phone kept; an ended
room is set idle first; a removed phone's mesh blob is deleted, or a later
pairing undoes itself; messages from other clients use entry IDs. Not
adopted: GLM's reading that a grey room's composer stays enabled (the app
disables it from the room's liveness).

**2026-10-22.** Adapter v0's code (commit `d18e190`) was reviewed
independently by Claude Fable 5.1 and GLM 5.3 Flash; both said to fix it
first. Fixed, after checking each claim: a room went deaf when its host's
connection dropped and came back within the grace, since the relay forgets
attachments with a session; one HTTP request with an absolute-form target, or
a mesh upload cut off mid-body, crashed the adapter; a missed turn end (relay
outage, sequence gap) left the room working for good; after the adapter
reconnected, rooms were ended at once and their streams reset; requests to an
ending session waited 45 s; the event that showed a gap was dropped; a failed
prompt's error went to every phone in the room; a second phone never learned
of an unpair done on the first (the blob that says so is now kept until the
person pairs again); half-done logins were never closed; failed pairing
attempts rewrote the registry. The end-to-end test gained a relay outage that
swallows a turn's end, a host connection blip, a phone reconnecting, a shared
room on two phones, re-pairing, and malformed input; the outage step found
two more reconnection bugs, also fixed.

**2026-10-23.** The step 8 specification (actions) was reviewed
independently by Claude Fable 5.1 and GLM 5.3 Flash; both said to fix it
first. Adopted after checking each claim against pi 1.0.0 and the app's
source: the adapter answers `model_set` and `thinking_set` before the room
meta they produce, or a clamped level is shown wrong; the adapter's 45 s
request deadline would have reported every long compaction as failed, so
`Compact` has none while the session shows it compacting; the extension
marks a session compacting or being replaced when it takes the request,
since pi's hooks come later; PiRC's own commands were reachable as prompt
text (a phone could have re-pointed the host's relay) and are now refused
and left out of the command list; a compaction before a prompt's run no
longer flaps the app's working state; `Models.current` carries the model's
details; a new session is answered only for a shutdown of reason `new`, and
before the old session's end. Not adopted: listing each model's thinking
levels (pi computes them in a library the extension does not depend on).

**2026-10-23.** Step 8's code (commits `aea250a`, `9644d36`) was reviewed
independently by Claude Fable 5.1 and GLM 5.3 Flash; both said to ship.
Fixed, after checking each claim: the specification wrongly said an abort
cannot stop a compaction (in pi 1.0.0's interactive mode it does), so a
Stop now ends in the notice "Compaction stopped."; a `/cost`, `/context` or
`/name` answered after a turn began closed that turn in the app; a change
of room meta during the second after a compaction could show the room idle
early; a refused compaction showed the room working for a second; a
compaction could be taken while a prompt was starting; the long-compaction
path was untested (the fake model can now summarise slowly, and the
adapter's test covers the early acknowledgement, the room working
throughout, and a Stop). The extension's copy of pi's built-in commands is
now checked against pi's own list.

**2026-10-23.** The step 9 plan was reviewed independently by Claude
Fable 5.1 and GLM 5.3 Flash; both said to fix the plan first. Adopted after
checking each claim: the bundles as first planned threw on load (`ws`
calls `require`, which esbuild's ES output cannot; fixed with a
`createRequire` banner, checked); the service files were to sit in a
git-ignored `dist/`; `NOTICE` missed `@bufbuild/protobuf`'s BSD-3-Clause
part and the Go standard library's; a registry command run as root would
lock the service out; "updating to a newer tag" is not what `pi update`
does, and the unpinned install let the extension run ahead of the relay,
so the pinned install is now the documented one; a launchd agent stops at
logout, so it is a daemon; `sh/release.sh` must fail, not skip, without
its tools; TLS, a restore and the stamped version were unchecked; and
smaller points (version stamping, the adapter's shebang, the boolean
encoding, backup and restore details).

**2026-10-25.** PiRC 0.1.4 (commit `423a21f`) was given a security review
by Claude Fable 5.1, with the relay newly reachable from the internet
behind a proxy (`docs/reviews/2026-10-25-security-0.1.4.md`). It found no
way past login, no spoofed key and no way for one host to read or take over
another's sessions at the relay. Fixed in 0.1.5, each with a test: the
adapter took a reply to its request from any session that sent the right
request ID, and its history IDs were sequential, so a malicious host could
replace another host's chat on the phone; 64 idle connections from anyone
locked every peer out of logging in (now 8 per address, 256 in all, and 5
seconds to say Hello); a host could announce sessions of up to a frame
each, enough to have every client dropped as too slow (now 64 KiB); idle
HTTP connections were never closed; labels with control characters could
forge rows in `pirc-relay pending` and `list`, and phone names in
`pirc-adapter list`; `remove` and `reject` took a one-character prefix;
hosts asking at once could each rewrite the registry; `approve` could
register a key twice; the adapter parsed 32 MiB messages before login,
from any number of connections (now 16 KiB, 64 at once); IPv4-mapped
trusted-proxy prefixes trusted nothing, and a wide prefix now draws a
warning; Welcome reported `pirc-relay/0.0.0`. Not adopted yet: a per-key
connection cap; marking a removed host that asks again; checking a key
file's mode on load; showing a room's host in the app, where a host can
name a session after another host's.
