# End-to-end encryption

Status: **Decided**, replacing an earlier design that was our own protocol for a list of
devices and the keys that follow it, and whose state, shared by several pi processes on one
computer, proved hard to get right. This one is built from standard parts that a reviewer can
name. Why the earlier design and the alternatives were set aside is in section 10. The order of
the build is in `design.md`, step 14.

The aim: a relay that routes every session but can read none of them, cannot add a device to an
account, and cannot let one computer read another's sessions. A browser is the exception: it
runs the page's code as served on every load, so whoever controls that code can read and act
through it; the page is kept apart from the relay (section 7). Today a relay is trusted
completely (`design.md`, section 6), which is acceptable only because it is the person's own.

This is for the hosted relay only. **Decided**: a self-hosted relay stays as it is,
unencrypted, for good (section 9).

## 1. In short

A reviewer should recognise each part by name and need to check only how it is used:

| Part | Standard | Precedent |
|---|---|---|
| All cryptography | libsodium 1.0.18 or later (audited in 2017, at 1.0.12) | NaCl's design; Threema builds on NaCl |
| Live channel, client to pi process | Noise `IK`, `25519_ChaChaPoly_SHA512` | WireGuard's handshake (`IKpsk2`), WhatsApp's transport |
| Who is in the account | One list of public keys, signed by one phone | WhatsApp's linked devices; SSH's `authorized_keys` |
| What the relay stores | libsodium's `crypto_box`, one copy per client | Threema's stored messages (NaCl box) |
| Joining | A QR code or pasted text holding a one-time secret, then Noise `XXpsk3` | The flow is Signal's and WhatsApp's device linking; the handshake is Noise's own |

- Each client (a phone or a browser) talks to each pi process (one running pi, the coding
  agent, on a computer; a computer may run several) over a channel of their own.
  Computers share no keys, so none can read another's sessions.
- The account's phone, the one that signed up, alone signs the list of devices. There is no
  group key and nothing shared that changes, so nothing for the relay to split and nothing for
  pi processes to fight over.
- What the relay keeps for later, each session's announcement (its name, folder, model and
  latest notice: the agent's question or the end of its turn, which a notification shows), is
  sealed by the computer to each client separately.
- Labels and names travel only encrypted. The relay learns none of them.
- Code that predates encryption cannot find the hosted relay (section 9).

**Every client is a shell on every computer.** **Decided**, by design: there are no read-only
computers and no permissions per client. What this design protects is who is on the list, and
what anyone off it can see or do.

## 2. Keys

Every device makes its keys itself; they never leave it and never change:

- an **Ed25519 signing key**, to log in to the relay and to name the device;
- an **X25519 channel key**, used only inside Noise, as Noise's specification requires of a
  static key;
- an **X25519 box key**, used only to open what the relay stores for it.

**On a phone**, two more, its **read-only key** (`design.md`, section 12, step 13): an Ed25519
key that logs in only to fetch the account's newest list and the notices sealed to this phone,
and an X25519 **notification key** that opens those notices. Both are readable from the first
unlock after a restart, by the iOS notification extension too, so that notifications work while
the phone is locked. The signing, channel and box keys stay behind Face ID or the PIN, on this
device only; push is registered with the signing key, while the app is open. A phone stolen while
locked yields at most the read-only key and the notification key: every notice sealed to it,
the latest of each session from any relay, older ones from a relay that kept them, and new ones
until the phone is removed
(section 8), and not the conversation or the rest of the announcements. That is what a
notification needs, and so what a locked phone gives up.

**In a browser** the signing and channel keys are WebCrypto keys that cannot be exported: Ed25519
to sign, X25519 for the two key agreements in Noise that use the static key. The box key is a
libsodium key stored encrypted under a WebCrypto AES-GCM key that cannot be exported, opened with
a fresh random nonce each time. Script injected into the page can use the first two only while it
runs, but can copy the box key once it is open, and with it read session names and notices for
good.

**Libraries.** libsodium everywhere, verified to give the same bytes on every platform:

- Node and browsers: `libsodium-wrappers-sumo`, the "sumo" build, since the standard one has no
  SHA-512 or HMAC-SHA-512;
- the app: Dart's `sodium` package (verified publisher), pinned to an exact version. It builds
  libsodium from its source at the app's build, and the build checks that source against the
  published release. SHA-512, HMAC-SHA-512 and ChaCha20-Poly1305 IETF are reached through its raw
  bindings, since its higher-level API lacks them (**Decided**); its author is asked
  to export the HMAC state the raw bindings need;
- the iOS notification extension: `swift-sodium`, pinned to a commit, since its last tagged
  release carries an older libsodium; the extension calls libsodium's C functions;
- the relay: Go's own Ed25519, only to decide whom to let log in; nothing trusts the relay for
  more.

**Ed25519 is verified with libsodium** wherever a device checks a signature, built without its
compatibility flag, so non-canonical and small-order encodings are refused alike everywhere. A
signature is made by whatever holds the key: WebKit's and CryptoKit's add randomness, and
libsodium accepts them. Keys of mixed order are accepted; with one signer that cannot split
devices.

**What is signed is exact bytes.** Protocol Buffers encodings are not canonical across
languages, so every signed object travels as the bytes that were signed, verified on those bytes
before it is parsed, and never encoded again to check it. Every string that is signed or used as
Noise's prologue, except the login challenge below, is *framed*: a context in ASCII, a NUL byte,
then each part prefixed by its length as an unsigned LEB128. Numbers inside are 8 bytes
big-endian. One rule, so no two uses can be read as each other, and no signature can be taken
for another kind. The contexts are `pirc-e2e-v2 ` followed by the kind: `list`, `join`,
`names`, `channel` for Noise's prologue, and `announcement` and `notice` for the first line of
what a computer seals (section 5). The login challenge signs `pirc-auth-v1alpha2`, NUL, the
account ID, the relay's origin and the relay's nonce, as now.

## 3. The account: one list, one signer

The account is a **device list**. Each version holds:

- the account ID, empty in the first version, whose hash is the account ID;
- a counter, and the hash of the version before (the relay checks it, below; a device, which
  may skip versions, does not);
- for each device: its role (computer or client), its signing, channel and box keys, and for a
  phone its read-only key and notification key;
- the account's phone's signature, over framed(`pirc-e2e-v2 list`, account ID, body).

It is encoded with Protocol Buffers (`account.proto`) and signed as sent: a version travels as
the 64-byte signature followed by the body's bytes, with no envelope to parse before the signature
is checked. "Hash" here is SHA-256 of the body's bytes, and the first version holds only the
account's phone. Every verifier, and the relay, refuses a list in which any public key appears
twice, so that a login names one device and one role. How each check runs, in what order and with
what result, is in `cases/e2e/`, which any implementation of the check must pass; TypeScript's
runs those files in `sh/check.sh`.

**One signer.** Every version is signed by the account's phone. A device learns that phone's key
when it joins (section 6), with the first version, which it checks hashes to the account ID and
verifies under the phone's key. From then on it accepts only versions that phone signed, for
this account, with a higher counter than its own. The signature is checked every time a version
is read, from the relay or from disk, and a list is refused by its size before it is parsed. One
signer and one counter means no forks, withdrawals or races.

**Each version built on the relay's.** The relay keeps the hash of every version it has held,
and of the version each was built on. It refuses a new version whose previous hash is one of
those but not its newest's, answering with a conflict and sending the version it holds first. So
two changes made from one version, the second of which would put back what the first removed,
cannot both be taken, whatever client signed them: the phone builds the second again on the
first. A version built on one the relay never knew is taken. That is how a relay that lost
versions it had taken (its store restored from an older copy) catches up: every device whose list
is newer than the relay's gives the relay its own at login, the phone, another client or a
computer, and the relay takes it over the gap.

A removal the phone published and never heard answered is kept by the phone, which signs nothing
else until it has given it to the relay again, at each later login and, after a refusal such
as the hourly cap, every two minutes: taken, it is the phone's newest; refused as a conflict, the
relay holds a newer version, which the phone takes. So a removal the relay took and
then lost comes back from the phone, or sooner from a computer that holds it. An addition not
heard answered is not kept; the phone reads the newest from the relay before it signs again.

**Caps.** **Decided**: at most **10 clients**, the account's phone among them, and
**50 computers**, in at most 16 KB, so that a list always fits in one Noise message. Every
verifier refuses a larger one, and a test checks the largest allowed list against the cap. A
computer seals each announcement once per client (section 5), and streams to each client
watching, so ten keeps that small.

**The phone's counter** is kept beside its signing key, in storage that is not backed up, and the
next counter is saved before signing. So neither a restored backup nor a crash can sign two
versions with one counter; a crash only wastes a number.

**Only the account's phone adds or removes devices.** **Decided**, as WhatsApp's
linked devices do. If it is lost, nothing can be added or removed: the person runs `/pirc leave`
on each computer and makes a new account. Sessions on the computers are not lost.

**Names stay private.** The list holds no names. A computer puts its own name in what it seals
(section 5). The account's phone keeps every device's name and seals the names to each client's
box key, signed under `pirc-e2e-v2 names`, with the list counter inside. There is no shared
label key. The names carry an ordering value made as an announcement's is (section 5), from the
phone's clock or its last value plus one, kept beside its counter; a client keeps the highest it
has seen and refuses a lower one, so the relay cannot bring back an old name.

**A computer's account files**, beside its key file: the account ID, the account's phone's
signing key, the hosted relay's origin, and the list versions it has received. They exist only
on a computer that has joined, and they are what makes it a computer of an encrypted account
(section 9).

**On a computer, several pi processes and no service.** The computer's keys are fixed, in its key
file. A process that receives a newer list writes it to a temporary file, flushes it to disk,
links it to a name made of its counter, then flushes the folder. Linking is atomic and fails if
the name exists, so processes can neither undo nor tear each other's writes, and no lock is
needed. Node's flush on macOS is Apple's full flush (`F_FULLFSYNC`); tested on macOS and Linux.
If that name exists with different bytes, the phone signed two versions with one counter: the
computer stops and says so. A process uses the highest version; it reads again when
the relay says a new one exists, before taking any channel, and every few minutes, and closes the
channels of a client no longer listed.

**Removing a device** is a new version without it. Each computer refuses the device once it has
that version, from the relay or from any client's next connection (section 4). The account's
phone shows each computer not yet on its newest version ("removal not yet confirmed by 'build
box'"). A relay working with a stolen client can keep the new version from a computer for as
long as no honest client connects to it; that display is the only defence (section 8).

## 4. Live use: a channel per client and pi process

A client that opens a session starts **Noise `IK`** with that pi process, knowing the computer's
channel key from the list. The prologue is framed(`pirc-e2e-v2 channel`, the channel's version, 1,
account ID, the client's role, the computer's role), and both handshake messages carry nothing,
because IK's first message can be replayed, and the client is not proved to hold its key until
its first message on the channel.

- The client's first message on the channel is its newest list. The computer checks the phone's
  signature, stores the list if it is newer, and only then checks that the client is listed as a
  client. It sends nothing before that. So a computer the relay kept behind is brought up to date
  by any client that reaches it, and a replayed or forged first message gets nothing.
- The computer answers with its list counter, and with its list when that is newer than the
  client's. A client that learns of a newer list from anywhere closes its channels to computers
  no longer on it.

Everything of the session travels inside: the conversation, requests, history, images, in
`session.proto`'s messages as now. Noise gives proof of both ends, encryption, order and no
replays, with fresh keys every connection. A Noise message holds at most 65,535 bytes, so larger
things are split. A missing or reordered message ends the channel, and the client starts a new
one. Each request names its session, and a process refuses one it does not run, so a relay that
routes a client to another process on the same computer gets nothing. All the processes of a
computer answer to the same channel key.

The relay's part (`relay.proto`, `OpenChannel`): a pi process logs in with an instance ID, and a
client opens a channel by the computer's signing key and that ID, with IK's first message; the
relay passes it to the newest connection of that process, gives the channel an ID, and passes
each Noise message on in order, unread, without saying who opened it. A channel lives only
while both connections do, and the relay closes it when either device is removed.

HMAC-SHA-512 in Noise's key derivation is libsodium's `crypto_auth_hmacsha512` in its init,
update and final form, which takes Noise's 64-byte key; never `crypto_auth`, which truncates.
Both implementations, in TypeScript and Dart, are held to the published test vectors (cacophony's
and snow's), and run against each other.

## 5. What the relay stores

For each session, the latest **announcement**: its name, folder and model, the computer's name,
and its latest notice, the agent's question in its own words. The computer seals it with
`crypto_box`, from its box key to each client's box key, with a random 24-byte nonce. To each
phone's notification key it seals a **notice**: the session's name, the computer's name and the
latest notice, all a notification shows. It stops sealing for a client once that client leaves
the list.

`crypto_box` has nothing like associated data, so the sealed text starts with framed(`pirc-e2e-v2
announcement` or `pirc-e2e-v2 notice`, account ID, the computer's signing key, session ID,
ordering value). The ordering
value is the time in milliseconds, or the last value plus one if that is larger; the last value
is kept in the process's memory only, so after a restart the time alone is used. A session is
named by its computer's signing key and its session ID. A client accepts an announcement only
when:

- it opens with that computer's box key, and that computer is on its newest list;
- the context matches the slot the relay gave it from;
- its ordering value is higher than the highest it has seen for that computer, session and kind
  (announcements and notices are counted apart), and no more than a day ahead of its own clock.

A client that no longer holds the session, as after its connection to the relay went, also
accepts an announcement equal to the highest it has seen: the relay gives the copy it holds
again at each login, and an idle computer announces nothing newer, so its session would stay
out. That copy is one the client accepted before.

So the relay cannot replay an old announcement to a client that has seen a newer one, or move
one to another session, and one computer cannot write over another's. A computer whose clock is
set back and then restarted sends announcements its clients refuse, without either side
noticing, until the clock passes the old value.

The relay keeps each copy in memory with its session, gives it only to its recipient, and drops a
copy to a key not on its newest list. An announcement goes when its session ends or its
recipient is removed; a notice stays fetchable for ten minutes after its session ends, so that
a notification for a turn's end can still show it, and goes at once with its computer's or
recipient's removal.

**Notifications.** The push carries nothing, as now. The notification extension logs in with the
read-only key, fetches the account's newest list and the notice sealed to its notification key,
checks the list as every device does, and makes the same checks of the notice as the app makes
of an announcement. The app and the extension keep the list and the highest values in the
storage they already share, so a list the extension took is the app's too. Each writes only a
newer list or a higher value, never over one, so neither undoes the other.

**History** stays on the computer, as now, and goes to a client over its channel when asked.

## 6. Joining

A new device needs two things: to be put on the list by the account's phone, and to know that
the list it then gets is its account's and not one the relay made. Every new device, a
computer, a browser or another phone, joins the same way.

1. The new device (a computer at `/pirc join`, or the join screen of a browser or phone) makes a
   one-time 256-bit secret and a lookup, and shows them as a **QR code and, under it, the same
   value as text**, about 60 characters. The lookup is 8 Crockford base32 characters, upper
   case, made at random: 40 bits, which with the caps on lookups makes guessing one impractical.
   The relay sees the lookup, only to pair the two devices, and never the secret. Only the
   account's phone looks one up; another client's lookup is refused and the wait stays.
2. The account's phone scans the code, or the person pastes the text into the app; on a phone
   that is in Termius or Blink, the text is copied from the terminal and pasted into PiRC.
3. The phone starts **Noise `XXpsk3`** with the new device through the relay, with the secret as
   the pre-shared key. The secret proves itself only at the end of the handshake, so the
   handshake messages carry nothing of the join, and the secret counts as used once the last one
   checks out.
4. Then each side sends its role, its keys and an Ed25519 signature over framed(`pirc-e2e-v2
   join`, its role, its keys, the final handshake hash), the new device first. The phone shows
   nothing until that message has arrived and checks out.
5. The phone says what is about to happen, by role, in words, before the name: for a computer,
   "a computer: you will be able to control it from here"; for a client, "a new browser or app:
   it will have full control of all 4 of your computers". It says that the name is what the
   device calls itself, and asks the person to confirm that they are holding, or sitting at, the
   device that shows this code.
6. After the person confirms, the phone signs a list version with the device in it and sends it,
   with the first version, over the channel. The new device pins the signing key proven in the
   join, and accepts the list only if that key signed it and it holds the device's own keys and
   role.

**The text is secret for its ten minutes.** The new device, not the relay, makes it work once and
expire after ten minutes. The relay ends a join's wait with `TIMEOUT` after those ten minutes, and a
join paired from it ten minutes after the wait began. Anyone who reads it first could join that device to an account of their
own, which for a computer means controlling it. So `/pirc join` says, beside it, that it gives
whoever uses it full control of this machine, and afterwards which phone approved it: "Joined the
account, approved by 'Pixel 9'. If your phone does not show this computer now, run `/pirc
leave`." Any link that holds the text carries it after `#`, never in the query.

**A computer already in an account.** `/pirc join` replaces its account, only when typed at its
terminal.

## 7. Accounts on the hosted relay

A hosted relay holds many accounts. The account ID is in `Hello`, and in the login signature
(section 2). The relay routes only within an account, and a key logs in to the account its
`Hello` names only if that account's newest list has it: a client or computer by its signing
key, a phone's read-only key only to fetch the newest list and its notices. A device belongs to
one account; a person with two accounts uses two installs, as now with two relays.

What the relay controls is admission, not membership. It can refuse a device it should take (the
device sees it cannot connect), but it cannot let in one the list does not have, and cannot read
what it routes. It stores each account's newest list, routes channel messages, keeps the sealed
announcements and names, and pairs the two sides of a join. It keeps no older version, only the
keys removed from the list, until the account is deleted: a device removed while it was offline
logs in, is given the newest version, and is then refused, so that it learns of its removal.

**Signing up and paying.** **Decided**, and outside the cryptography:

- Signing up is anonymous and one tap: no email, no password. A phone makes the account, and
  signs its first version.
- App Attest (iOS) or Play Integrity (Android) runs when a phone makes an account or joins one,
  and the relay checks a subscription per account. An account is free while any of its phones
  has a live subscription or trial, and the browsers on it are included. Accounts with no phone
  pay later, by Stripe or a merchant of record. A joining phone's attestation is kept with the
  join and stored for its key only when the account's phone publishes a list version that has the
  key while the join is alive, so a join that fails leaves nothing behind. The relay passes at
  most 8 steps of the join, each at most 65,535 bytes, and keeps none of them.
- Against abuse: the hosted relay has a domain of its own; there are caps per account (section 3)
  and per address, join lookups among them; sign-ups are open, by invite code, or closed, which
  the operator sets while the relay runs; an account can be deleted, only from the account's
  phone, as only it changes the list; and abuse reports go to an `abuse@` address.
- Invite codes are 80 random bits, kept by their hash, each good for a number of accounts until it
  expires. The app asks the relay's mode, and whether a code may be used, before it buys anything
  (`CheckInvite`), and a code can be given while sign-ups are open too. Codes are tried only after
  a sign-up's attestation, and at most 30 an hour from one address. A review code, given only to the stores' reviewers, stands in for the
  subscription: its account has a review subscription for 30 days and is deleted when that ends,
  unless a subscription bought since carries it on.

**Attestation only stops abuse.** It tells the relay that a real app on a real phone is signing
up or joining, so that accounts cannot be made in bulk. It never stands in for the list: a
device is trusted by the other devices because the account's phone signed it onto the list,
whatever any attestation said.

**Privacy.** For hosted accounts, the subscription is checked. That reverses, for them, what
`design.md` (section 12, on Play Billing) says: that the app sends PiRC nothing about the
subscription, and that no server of PiRC's asks the stores' APIs.

**The hosted web client's page.** **Decided** (`design.md` step 14): served as fixed
files from Cloudflare Pages, apart from the relay, so that getting into the relay does not give
anyone the page. What an account with a browser trusts is then Cloudflare Pages and the
publisher's deploy of the page, besides its own devices. Safari deletes a site's storage after
seven days without use unless the site is installed (added to the Dock or home screen), so in
Safari it is to be installed, or it loses its keys and stays on the list as a device nobody
holds; clients show, for each device, when the relay last saw it, so such entries can be found
and removed.

## 8. What the relay and the push gateway see

**The relay**, afterwards:

- each account's devices, by public key and role, and the list's history;
- which are connected, from what address, when;
- which client opens a channel to which pi process, and when;
- every session's computer and pi's session ID (a UUIDv7, so it holds the session's start time);
- the size and timing of every message, and so roughly when a session is working, and how much;
- the `push` flag, so when a turn ended or a question was asked, as now;
- the app's attestations and each account's subscription (section 7): an App Attest key ID,
  Apple's original transaction ID, Google's purchase token. These tie an account to a store
  account, and that link outlives a new account made after losing the account's phone.
  Anonymous here means no email and no password, not unlinkable.

**Not**: session names, folders, models, the devices' names, prompts, replies, tool calls,
images, notices, or anything else of the conversation. On a hosted account, `Hello.label` and
`Hello.software` are empty.

**The push gateway**, on the hosted relay, is the same operator as the relay. So what it sees,
which relay woke which phone and when (`SECURITY.md`), becomes which account's phone, by its APNs
or FCM token, and when; Apple and Google can tie that token to a store account. The push carries
nothing, as now.

**What a relay can still do.** It cannot read, write or add. It can still:

- refuse a device, or drop, delay or withhold messages; a dropped channel message ends the
  channel, and the client starts another;
- keep a newer list from a computer for as long as no honest client connects to it, and so,
  with a stolen client's key, keep that client working there after its removal (section 3);
- show a client an older announcement the first time it looks at a session, until a newer one
  arrives or it opens the session's channel;
- with the join's text read by someone else within its ten minutes, let them join that device to
  their account (section 6);
- with a stolen client's key, connect as that client until it is removed;
- keep a newer list from a client other than the account's phone, so that it goes on trusting a
  removed computer, whose keys were stolen, until it reaches a computer that has the newer list;
- show a client the names as they were, until newer ones reach it.

Not hidden, and stated so: the timing and size of traffic, and the membership of each account.
Padding messages to fixed sizes could come later; it is not needed to keep the content private.

**Stolen keys, and what they open later.** For a relay that records what it routes, and later
gets a device's key:

- **The conversation and requests** are under each channel's own keys, made fresh at each
  connection and never stored. A stolen long-term key opens none of them. A read of a running
  process's memory opens its open channels.
- **Stored announcements have no forward secrecy.** A client's box key, or a phone's
  notification key, opens every announcement sealed to it: session names and notices. The
  notification key is readable on a locked phone, so a seized locked phone is enough for
  notices.
- **A stolen computer's keys** open nothing recorded; with the relay, they let their holder act as
  that computer until it is removed.
- **A stolen client's keys** are a shell on every computer anyway, until it is removed.
- **A phone stolen while locked** needs no help from the relay: its read-only key fetches every
  new notice from an honest relay until the phone is removed. If it is the account's phone,
  nothing can remove it; the person runs `/pirc leave` on every computer, which ends it.

## 9. Self-hosted relays, and code from before

**Decided**: a self-hosted relay stays unencrypted, for good (`design.md`, section 5.1). It keeps
`v1alpha1`, its registry, its tokens and approval by key comparison, and its operator, who is the
person, keeps trusting it.

**Encryption belongs to the account, and is never read from the relay.** A device learns whether
it is in an encrypted account from how it joined: signing up on the hosted relay, or `/pirc join`.
It keeps that, and from then on refuses `v1alpha1`, any payload that is not encrypted, and any
`Welcome` that does not match. A device enrolled on a self-hosted relay with `/pirc enrol` stays
unencrypted, as now. One account never shows encrypted and unencrypted sessions side by side.

**Code from before encryption must not find the hosted relay.** That refusal lives only in new
code. Every extension released so far reads the relay's address from `host.json` (or
`PIRC_RELAY`) each time it connects, speaks `v1alpha1`, and runs any request from any client the
relay names. A machine can run old and new code at once: two installs of PiRC, a project's own
older copy, or a downgrade after a bad release. If old code found the hosted relay's address, a
malicious relay would answer it in `v1alpha1` and have that process's content and a shell. So:

- The hosted relay's address, and that the account is encrypted, are kept only in the computer's
  account files beside its key file (section 3), never in `host.json`'s `relay`.
- `/pirc join` writes, into `host.json`'s `relay`, a value every released version refuses before
  it opens a socket: an address with the scheme `pirc-e2e:`, which their `relayURL()` rejects, as
  it rejects anything but `ws:` and `wss:`. Old code then fails to connect, and says so.
- New code in an account refuses to start while `PIRC_RELAY` is set at all, since an environment
  variable is read by every install on the machine, old code included; `/pirc join` refuses
  while it is set.
- The hosted relay never speaks `v1alpha1`. That stops only accidents: a malicious relay answers
  however it likes.
- A test runs the last unencrypted release against a computer that has joined a hosted account,
  and checks that it does not connect.

A hosted account is safe from a downgrade only as long as no code from before encryption connects
to the hosted relay. Its address is public, so these cannot make it unfindable: they keep PiRC's
own configuration from leading old code there. Old code pointed at it by hand, by a setting of
its own, is not covered.

## 10. Rejected, and why

- **The earlier design**: a list any client could sign, kept as a chain with forks
  and withdrawals; daily sending keys per process, wrapped for each client in bundles; weekly
  pre-keys; a shared label key; HPKE built by hand in four languages; per-platform checks before
  Ed25519; signed requests with counters and time windows; joining by a typed code with CPace.
  Each part was argued for, but together they were a protocol of our own that an expert would
  have to study whole, and the state several pi processes shared was where its flaws kept
  appearing. Pairwise channels were rejected then for sending each broadcast once per client and keeping a ratchet's
  state in every process; with at most ten clients the first is small, and Noise keeps no state
  between connections, so neither holds.
- **MLS** (RFC 9420), one group for the account: its shared group secret lets every computer read
  every other's sessions, and a commit must be ordered by the relay. Audited in Rust (OpenMLS), but
  not in Dart or the browser.
- **MLS, one group per computer**, with that computer and the clients: it keeps computers apart,
  but each group's key changes with every addition and removal, and all the pi processes of a
  computer would have to share that changing state, which is what broke before. Its saving,
  encrypting once instead of once per client, is negligible at ten clients.
- **Matrix**: a whole chat system, with a server of its own and rooms; its room encryption shares
  a key, as MLS does; its one-to-one mode is the same idea as here; and its cryptography's record
  is weaker (practical attacks published in 2022, its first library retired for a timing flaw in
  2024).
- **Signal's protocol** (libsignal), pairwise: the most reviewed, but AGPL, unsupported outside
  Signal, without an official Dart or browser build, and its ratchet solves offline messaging
  between people, which PiRC does not have.
- **WebRTC data channels**: a WebRTC stack inside pi, and tying its certificates to the account
  would be custom again.
- **Any client administers**: more convenient when the account's phone is lost, but two clients
  can then sign conflicting versions, which brings back forks and their rules.
- **Sender keys**, as Signal's and WhatsApp's groups use, so that a computer encrypts once: worth it
  for groups of hundreds; not at ten clients, and the key would change on every removal.
- **A list that expires** unless signed again, the standard cure for a relay withholding a
  removal: every computer would stop whenever the phone went unopened for a few days.
- **A typed code with CPace**: needed only because a typed code is short; the QR code's text can
  hold a 256-bit secret, and a Noise handshake with it needs no PAKE.

## 11. Open

- **A recovery code**, written down at sign-up, that lets a new phone take over as the account's
  phone, as Matrix offers. A known pattern; after the first release.
- **Windows**: flushing a folder is not tested there, and Node cannot open a folder to flush it.
  PiRC does not offer Windows computers today.
- **Padding** messages to fixed sizes, and hiding session IDs from the relay (section 8).
- **Moving the hosted relay's domain.** Each computer's account files hold the relay's origin and
  every login signs it, so a move means `/pirc join` at every computer and every client signing in
  again. A move signed by the account's phone, in a version of the list, may come later.

**Risks, not yet settled:**

- **Noise in TypeScript and Dart is ours**, about 300 lines each over libsodium: there is no
  audited Noise library for Dart, and Rust's `snow` says it has not had a formal audit. It is held
  to two independent sets of published vectors for `IK` and one for `XXpsk3`, and the two
  implementations to each other.
- **The Dart `sodium` package** is one publisher's, with few users; it is pinned and its libsodium
  source checked. Its raw bindings reach into the package's own files for the HMAC state, which
  an update may move.
- **Not tested on iOS 16** itself: only iOS 18 and 26 simulators, with an iOS 16 target.
- **Old code** (section 9): how often a machine has two installs of PiRC, or a project's own older
  one, is not known; it happens, which is enough to guard against it.
