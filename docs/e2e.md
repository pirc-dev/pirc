# End-to-end encryption

Status: **Open**. A proposal, 2026-11-15, for the first step towards a
hosted relay (`design.md`, section 5.1 and section 12, step 14), revised
2026-11-17 after an independent review. Nothing here is built. The owner's
decisions it takes as given are marked **Decided**; the rest is proposed.

The aim: a relay that routes every session but can read none of them, and
cannot add a device to an account. Today a relay is trusted completely
(`design.md`, section 6), which is acceptable only because it is the
person's own. A relay run by someone else, the publisher's included, must
be able to see only what it needs to route: which devices are in an
account, which are connected, and the size and timing of what they send.

This is for the hosted relay only. **Decided**: a self-hosted relay stays
as it is, unencrypted, for good (section 8).

## 1. What changes, in short

- The account becomes a list of devices, by their Ed25519 keys, that only
  the account's clients can change, each version signed by a client in
  the version before it. The relay stores the list and checks it, but
  cannot forge it. Hosts and clients trust a device because it is on the
  list, not because the relay let it log in.
- Each pi process makes its own keys: sending keys, which it gives to
  every client on the list, wrapped for each in a bundle the host signs;
  and a key that clients encrypt their requests to. Hosts keep no
  long-term encryption key.
- Clients and read-only keys each publish an encryption key, signed by
  their signing key, and make a new one every week.
- Announcements and conversation are encrypted with different keys, so a
  phone's read-only key can be given the first and not the second.
  Announcements are also signed by their host.
- Every request is signed by its client, names the session it is for, and
  is refused if it is old or a repeat.
- The relay keeps what it keeps now, encrypted: the latest announcement
  of each session, and now each process's wrapped keys. History stays on
  the host, as now, and is sent encrypted when a client asks for it.
- A new device joins by a code: the device shows it, a client types it.
- Labels and names travel only encrypted. The relay learns none of them.

## 2. Keys per device

- **Signing: Ed25519**, as now: the key a device logs in with, and the key
  that names it on the list. Every check of who did something in this
  design is a check of an Ed25519 signature against the list.
- **Encryption, for clients and read-only keys: X25519 pre-keys**. A
  client, and each read-only key, publishes an X25519 public key signed by
  its Ed25519 key, with the account ID, when it was made, and when it
  expires (14 days after). It makes a new one every week, and deletes the
  old private key two days after publishing the new one, once the hosts'
  daily sending keys (section 4) have moved to it. The relay stores the
  latest of each device's and hands them out; hosts wrap only for a
  pre-key that has not expired, of a device on the list. A relay that
  holds back a new pre-key can keep an old one in use for at most its 14
  days. Pre-keys are outside the list, so renewing one changes no version
  of it.
- **Encryption, for hosts: one X25519 key per process**, made with its
  sending keys and gone with them (section 4). A host has no long-term
  encryption key, in its key file or on the list.

A phone has a second Ed25519 key for its read-only key (`design.md`,
section 12, step 13), readable from the first unlock after a restart, by
the iOS notification extension too, with a pre-key of its own. The app
renews both pre-keys; the extension reads them from the storage it shares
with the app. A read-only key is given announcement keys and the label
key only (sections 3 and 4).

**Algorithms.** Those every platform PiRC runs on has built in: Ed25519,
X25519, HKDF-SHA256 and AES-256-GCM (in Go, Node, WebCrypto, CryptoKit
from iOS 13, and Dart's `cryptography`). Keys are wrapped and requests
encrypted with HPKE (RFC 9180) in its base mode: DHKEM(X25519,
HKDF-SHA256), HKDF-SHA256, AES-256-GCM. Who sent something is proved by
an Ed25519 signature inside, not by HPKE's authenticated mode, so that
every identity is an Ed25519 key on the list and X25519 keys can be
renewed freely. Where a platform has no HPKE (CryptoKit before iOS 17,
Dart), it is built from those primitives and held to the RFC's test
vectors in `cases/`. ChaCha20-Poly1305 is not chosen because WebCrypto
lacks it.

**Every signature has its own context.** Each kind of thing a device
signs starts with its own fixed string, so that no signature can be taken
for another kind: a list version, a pre-key, a label record, a wrap
bundle, an announcement, a request. The login challenge (`Auth`) in
`v1alpha2` also names the account ID and the relay's origin. The relay
chooses the nonce a device signs at login, so this matters: nothing a
device signs for another purpose may be encodable as a login signature,
or the reverse.

## 3. The account: a device-signed list

The list (`design.md`, section 5.2) is a chain of versions. Each holds:

- the account's ID, the hash of version 1;
- its version number, and the hash of the version before it;
- every device: its role (host, client, or a client's read-only key), its
  Ed25519 public key, which device added it, and when;
- the signing device's key, and its Ed25519 signature over all of it.

**Who may sign.** A version is valid only when signed by a client (not a
read-only key, not a host) in the version before it. That is today's rule
in another form: any registered client may approve, rename, remove and
invite (`design.md`, section 5.3). Hosts sign nothing, since a host that
could add a client could give itself a shell on every other host.

**Every client is a shell on every host.** **Decided**, by design: there
are no read-only hosts and no permissions per client. A client on the
list can do what the person can do at the terminal of every host in the
account. What this design protects is who is on the list, and what
anyone off it can see or do.

**What each change becomes.** Adding a device, removing one and
registering a read-only key are each a new version, signed by the client
that does it. The relay's `ApproveHost`, `RenameKey`, `RemoveKey`,
`RegisterReadKey` and `IssueToken` give way to one frame that publishes a
version, on a hosted relay. The operator of a hosted relay cannot change
an account at all.

**Adopting a version.** A client that signs version N+1 adopts it only
once the relay has taken it. If the relay answers that N+1 already
exists, signed by another client at the same time, it drops its own,
fetches the other, checks it, and signs its change again on top of it.
Two honest clients then never make a fork.

**Labels.** The relay needs keys and roles to admit and route, but not
the names. Names are in a label record, outside the list: each device's
label, encrypted under a label key, with a counter and the list version
it belongs to, signed by a client. The label key is one symmetric key
shared by the clients and read-only keys, made new only when a client or
read-only key is removed, and wrapped by the client that makes it for
each current pre-key. A device keeps it once it has it; a new device gets
it in the join (section 5); a device whose pre-key expired while it was
away gets it wrapped again by any client once it publishes a new one.
Renaming is a new label record, not a new version of the list. A device
takes a label record only with a higher counter than the one it has. Hosts do
not get the label key: they show their own name, and need no other. A
read-only key has it, so that a notification can be titled with the
host's name.

**Checking it.** The relay checks every version it is sent (the chain,
the signer, the signatures), so that nobody can fill an account with
junk; but it is the hosts and clients that enforce it. Each keeps the
latest version it has checked, its number and hash, across restarts, and
takes a new one only if it chains from it. A host's processes share it
in a state file of its own, replaced only by a higher version (written
to a temporary file, then linked into place, as `relay-client` already
writes keys), so that two processes cannot put back an older one.

**Freshness.** A relay could keep a removed device in an account by never
showing a host the version that removed it. So every request a client
sends carries, inside its encryption and signature, the number and hash
of the latest version the client has, and the versions the host is
missing, which the client knows from the version the host's
announcements carry (section 4). They are small. A host checks them and
moves to the latest before acting on the request; it needs nothing from
the relay to catch up. And when a client sees a host announce an older
version than its own, it sends the host the missing versions at once, in
a request of their own.

What remains, and is said in section 7: a relay can keep a removed device
working on a host until an honest client's request reaches that host.

**Forks.** Two versions with the same number and different hashes, both
validly signed, are a fork. With adopting as above, honest clients do not
make one; one comes from a signer that is dishonest, most likely a removed
device whose key was stolen, signing a version on top of one it was still
in. What each side does:

- **A client** keeps the chain it and the clients it trusts have built:
  the one with the versions it adopted. It does not stop. It marks the
  hosts that announce the other branch as needing `/pirc join`, and names
  the device that signed the other branch.
- **A host** that is shown a fork stops serving, and says so at its
  terminal: it cannot tell which branch is its account's. It is joined
  again with `/pirc join`.

So a stolen phone and the relay together can stop a host until the person
is at it, but cannot make the person's own clients stop.

**Removal.** A device acts on its own removal only when a version it has
checked no longer has it. Then it deletes what it keeps: on a phone, its
keys, the chats it kept and its drafts; on a host, its anchor (below).
Nothing the relay sends without such a version removes anything: the
WebSocket close with "key revoked" (1008), which today deletes a phone's
keys and stops a host for good, means only that the relay refuses the
key. The device shows it and tries again later, backing off. Otherwise a
relay, malicious or broken, could wipe every phone of an account, and
with no recovery that would be the end of the account.

**The first device.** **Decided**: on a hosted relay, the first device is
a phone. Signing up is one tap, with nothing to fill in, and the phone
makes version 1 with itself in it (section 6).

**Losing every client.** **Decided**: there is no recovery code. Someone
who loses every client makes a new account: a new phone signs a new
version 1, and each host joins it at its terminal, with `/pirc join`.
Nothing is lost but access: the sessions live on the hosts, in pi's
files, and the relay keeps nothing but the latest announcements.

**A host's anchor.** A host keeps the account ID and the latest version
it has checked: its anchor. It is set only by `/pirc join`, typed at its
terminal (section 5). On a host that already has one, `/pirc join`
replaces it; nothing the relay sends can. `/pirc leave` forgets it, and
the host stops serving at once.

**A stolen phone.** With a second client, the person removes the stolen
one, and it can do nothing more once the hosts have the version that
removed it (Freshness, above). A stolen *only* client cannot be removed:
nothing is left to sign its removal. The thief has a shell on every host
until the person, at each host's terminal, runs `/pirc leave`, or makes a
new account and runs `/pirc join` there. The apps should say so, and
suggest a second client, when an account has one.

## 4. Sending keys and what is encrypted

**A process's keys.** Each `Host` object in a pi process (`design.md`,
section 4: a process has one, and after a `/reload` with new code, a
new one that takes over the old one's instance ID) makes, when it starts:

- a random 32-byte secret, from which HKDF derives two sending keys, one
  for announcements and one for the conversation;
- an X25519 key pair for requests;
- a key ID, random, which names all of these.

None of them is handed to a successor: during a `/reload` the old `Host`
object and the new one each have their own, and every frame carries its
key ID. So no two senders ever share a key and its nonce counter.

**The wrap bundle.** The process wraps the sending keys with HPKE for each
current pre-key of the list's clients (both keys) and read-only keys (the
announcement key alone). It signs the bundle with the host's Ed25519 key.
The signature covers the account ID, the host key, the instance ID, the
key ID, the list version, the process's request key, every recipient's
pre-key and its ciphertext, and the bundle's context string. It publishes
the bundle to the relay, which stores it by key ID, since two connections
can serve one `SessionRef` during a handover, and sends it to clients with
the session list. A client, and the iOS notification extension, checks
the signature against the host's entry in the list it has checked before
using a key from it. A bundle the host did not sign, or one for a host not
on the list, is refused. With a few dozen devices, that is a few kilobytes
per process, sent once.

**New keys.** A process makes new sending keys, with a new key ID and a
new bundle:

- on every removal from the list, so that a removed device cannot read
  what comes after;
- once a day, which bounds what a key read from a process's memory opens.

An addition needs no new key: the process wraps the current one for the
new device, which can read the history anyway. A renewed pre-key needs
only a new wrap of the current keys, in a new bundle. A key from before
is kept for a minute, for frames already in flight. The request key is
the process's for its life; a new `Host` object has a new one.

Processes do not share keys, even on the same machine, so no pi process
needs another's state, and no host can read another host's sessions,
even with the relay's help.

**What a host sends.**

- *Announcements*: the payload of `SessionAnnounce`, which the relay
  stores and replays, is signed by the host's Ed25519 key, then encrypted
  with the announcement key. Its notice is inside, so a woken phone reads
  it with its read-only key, as now. The signature is there because the
  announcement key is shared with read-only keys, the least protected
  keys in the account: without it, someone with a read-only key and the
  relay could write a question notice of their own choosing into a
  phone's notifications. The announcement carries the list version its
  host has.
- *Everything routed*: the payload of `Routed`, both broadcasts and
  answers to one client, is encrypted with the conversation key. An
  answer meant for one client can be read by every other client of the
  account, which can ask for the same answer anyway. These are not
  signed: only clients have the conversation key, and a client is a shell
  on the host already.
- Each frame is AES-256-GCM under a nonce that counts up from zero, never
  repeated under one key, since the key belongs to one `Host` object
  alone. The additional data binds it to its place: the account, the key
  ID, the `SessionRef`, the direction and kind of frame, the recipient for
  an answer to one client, and the list version. So the relay cannot move
  a frame from one session to another, or from one client to another,
  without its failing.

**What a client sends.** Each request (`Routed` from a client) is put in
an envelope that holds:

- the target: the account ID, the full `SessionRef` (host key, session
  ID, instance ID) and the key ID of the process's request key;
- the direction, client to host;
- the time, and the client's latest list version with any versions the
  host is missing (section 3);
- the request itself;
- the client's Ed25519 signature over all of the above.

The envelope is encrypted with HPKE to the process's request key, from
the bundle. A process that gets one:

- decrypts it, which only the process with that key can, so a request
  cannot be delivered to another process, even on the same host;
- checks that the target is itself: the account, its `SessionRef` as it
  is now (a process changes session on `NewSession`, a resume or a fork)
  and its key ID;
- checks the signature, and that its key is a **client's** on the list.
  A read-only key's and a host's are refused. The read-only key is the
  one a phone keeps readable while locked, and must not be a shell; this
  rule has a test of its own in `cases/`;
- checks that the signer is the client the relay named in
  `Routed.client_key`, and from then on knows the client by its
  signature, not by what the relay says;
- refuses it if its time is more than five minutes away from the host's
  own, or if it is a repeat (below).

Requests are few and small (prompts, actions), so the cost of a key
exchange and a signature each is nothing.

**Repeats.** The relay must not be able to run a request twice. Today a
repeated request ID is how a client retries: after a retryable error
(`BUSY`, `TIMEOUT` and the like), a repeat runs again (`design.md`,
section 7). So a repeat of the same request ID cannot be the test. Instead:

- The process records every envelope it accepts, by its HPKE
  encapsulated key, which is new for every encryption, for as long as
  its time can be accepted, and refuses the same one again. The set
  belongs to the request key, and goes when the process does; an
  envelope for an old process cannot be opened by its successor.
- A client's retry is a new envelope, with a new time and a new
  encryption. It keeps its request ID, so that a retry of a request the
  host has already answered gets that answer, and is not run again.
- That idempotency is keyed by the signer and the request ID, and the
  answers it keeps (`replies`) are handed over by `Host.succeeding`, with
  the sequence numbers and notices it hands over now.

So the relay can delay a request, within its five minutes, or drop it,
but not run it twice or later.

**History.** It is on the host, as now, and goes to a client only when
asked for, encrypted as any other answer. A client added today can read
yesterday's conversation, because it asks the host for it, which is the
product's model: every client sees every session. No key from before the
client joined is ever needed, and the relay stores no conversation to
protect.

**The phone's own copy.** Unchanged: kept on the phone, protected as now
(`design.md`, section 12, step 13).

## 5. Joining: one code for every new device

A new device needs two things: to be put on the list by a client, and to
know that the list it then gets is its account's and not one the relay
made. Every new device, a host, a browser or another phone, joins the
same way. **Decided**: the new device shows a code, and a client that is
already in the account types it.

**The code.** **Decided**: nine characters, Crockford base32, shown as
`K7QM-2XRP9`:

- four for the lookup, which the relay sees and uses only to pair the
  client with the device waiting, unique among the joins under way;
- five secret, a password for CPace (a password-authenticated key
  exchange, CFRG Internet-Draft, suite CPACE-X25519-SHA512), which never
  leaves the two devices.

A code is good for one try and ten minutes. The device that shows it
forgets it at the first failed attempt, whatever the relay says, and the
client that types it tries once. The relay gets one guess per code, at
about one in 2^25, and a failure is seen by both people at once. It gets
nothing to try offline: with a code this short, anything but a PAKE would
let it find the secret from the first message it carried (section 10).

**The exchange.** Through the relay:

1. `/pirc join` at the host's terminal (or the join screen of a new
   browser or phone) makes the code and a nonce, and waits.
2. The person types the code into a client. The two run CPace, with a
   session ID made of the string `pirc-join-v1`, the relay's origin, the
   lookup characters and the nonce, and confirm the key in both
   directions. A failed confirmation ends the join on both sides.
3. Under the key they now share, the new device sends its Ed25519 key, the
   name it would like to be shown by (the machine's name, for a host),
   and, for a client, its first pre-key.
4. The client shows the name and asks the person to approve. It then
   signs version N+1 with the new device in it, adopts it as in section 3,
   and sends, under the shared key: the account ID, version N+1, its own
   key, and, to a new client, the label key. It writes the new device's
   name into a new label record.
5. The new device fetches the chain from the relay, checks that it hashes
   to that account ID, chains, and ends at N+1, signed by that client.
   Only then does it keep its anchor and start serving (a host) or
   working (a client).

The name travels only in step 3 and in the label record, never in `Hello`
(section 7).

**What a host says.** A code hands whoever types it a shell on the
machine, and a code read out over the phone is how device-code phishing
works. So `/pirc join` says, beside the code, that it gives whoever types
it full control of this machine, and after the join it says which client
approved it, by name: "Joined the account, approved by 'Pixel 9'".

**A read-only key** is registered by its own client, on the same phone,
as a new version of the list; no code is needed.

**A host already in an account.** `/pirc join` replaces its anchor (section
3), only when typed at its terminal.

**Without a camera, and with one.** Typing is the way that always works.
A QR code that the new device draws, carrying the same exchange with a
128-bit secret in place of the five characters, needs no PAKE and no
typing, where a phone's camera can see the screen; it may come later
(section 11). Any link or QR code that carries a secret carries it in the
fragment (`#...`), never in the query, which reaches servers' and proxies'
logs.

## 6. Accounts on the hosted relay

A hosted relay holds many accounts. The account ID (the hash of version
1) is in `Hello`, and in the login signature (section 2). The relay routes
only within an account: a session's frames go only to that account's
clients, and a key logs in to the accounts whose latest version lists it.
A device belongs to one account; a person with two accounts uses two
installs, as now with two relays. Sharing between accounts is not part of
this. The relay's registry holds one account today
(`relay/internal/registry`); holding many is a rewrite of it, not an
addition.

What the relay controls is admission, not membership. It can refuse a
device it should take (the device sees it cannot connect), but it cannot
let in one the list does not have, and cannot read what it routes.

**Signing up and paying.** **Decided**, and outside the cryptography:

- Signing up is anonymous and one tap: no email, no password. A phone
  makes the account (section 3).
- App Attest (iOS) or Play Integrity (Android) runs when a phone makes an
  account or joins one, and the relay checks a subscription per account.
  An account is free while any of its phones has a live subscription or
  trial, and the browsers on it are included. Accounts with no phone pay
  later, by Stripe or a merchant of record.
- Against abuse: the hosted relay has a domain of its own, not
  `pirc.dev`; there are caps per account and per address; sign-ups can be
  closed, to invite codes only; an account can be deleted; and abuse
  reports go to an `abuse@` address.

**Attestation only stops abuse.** It tells the relay that a real app on a
real phone is signing up or joining, so that accounts cannot be made in
bulk. It never stands in for the list: a device is trusted by the other
devices because a client signed it onto the list, whatever any
attestation said, and a relay that waves a device through attestation
still cannot put it on the list.

**Privacy.** For hosted accounts, the subscription is checked. That
reverses, for them, what `design.md` (section 12, on Play Billing) says
now: that the app sends PiRC nothing about the subscription, and that no
server of PiRC's asks the stores' APIs. The design and the privacy
policy are to be changed for hosted accounts when the hosted relay is
written into `design.md`; what the check links is in section 7.

## 7. What the relay and the push gateway see

**The relay**, afterwards:

- each account's devices, by public key and role, and the list's
  history: who added whom, and when;
- which are connected, from what address, when;
- every `SessionRef`: host key, pi's session ID (a UUIDv7, so it holds
  the session's start time) and instance ID;
- which client is looking at which session, and when, from `Attach` and
  `Detach`;
- the size and timing of every frame, and so roughly when a session is
  working, and how much;
- the `push` flag, so when a turn ended or a question was asked, as now;
- the app's attestations and each account's subscription (section 6): an
  App Attest key ID, Apple's original transaction ID, Google's purchase
  token. These tie an account to a store account, and that link outlives
  a new account made after losing every client. Anonymous here means no
  email and no password, not unlinkable.

**Not**: session names, folders, models, the host's name for itself,
devices' labels, prompts, replies, tool calls, images, notices, or
anything else of the conversation. On a hosted account, `Hello.label` and
`Hello.software` are empty, and the frames that carry labels today
(`PendingHost`, `RegisteredKey`, `SessionEntry.host_label`) carry none.
Clients title notifications with the host's label from the label record.

**The push gateway**, on the hosted relay, is the same operator as the
relay. So what it sees, which relay woke which phone and when
(`SECURITY.md`), becomes which account's phone, by its APNs or FCM token,
and when; Apple and Google can tie that token to a store account. The
push carries nothing, as now.

**What a relay can still do.** It cannot read, write or add; it can
still:

- refuse a device, or drop, delay (within five minutes, for a request) or
  withhold frames;
- keep a removed device working on a host until an honest client's
  request reaches that host (section 3, Freshness);
- with a stolen key of a removed device, stop hosts until the person is
  at them (section 3, Forks);
- show a client an older stored announcement on its first look at a
  session, before a question was asked, say; counters catch a rollback
  within a stream, not on the first view. This is withholding by another
  name;
- hold back a device's new pre-key, keeping its old one in use for up to
  14 days (section 2).

Not hidden, and stated so: the timing and size of traffic, and the
membership of each account. Padding frames to fixed sizes, or hiding
session IDs from the relay, could come later; neither is needed to keep
the content private.

**Stolen keys, and what they open later.** For a relay that records what
it routes, and later gets a device's key:

- **Requests** are encrypted to a process's request key, which exists
  only in that process's memory and goes when it does. A host's key file
  holds no key that opens them. They have forward secrecy.
- **What hosts send** is under sending keys wrapped for clients' pre-keys.
  A stolen client or read-only key opens what was wrapped for the pre-keys
  it still holds: the last week or two of traffic, not everything since
  the device joined, since old private pre-keys are deleted. That is the
  forward secrecy this design has, short of a ratchet (section 10).
- **A stolen host key** (Ed25519) opens nothing recorded; it lets its
  holder, with the relay, act as that host until the host leaves or the
  host is removed.
- **A stolen client key** is a shell on every host anyway, until it is
  removed (section 3).

## 8. Self-hosted relays

**Decided**: a self-hosted relay stays unencrypted, for good (`design.md`,
section 5.1). It keeps `v1alpha1`, its registry, its tokens and approval
by key comparison, and its operator, who is the person, keeps trusting
it.

**Encryption belongs to the account, and is never read from the relay.**
A device learns whether it is in an encrypted account from how it
joined: signing up on the hosted relay, or `/pirc join` with a code. It
keeps that, and from then on refuses `v1alpha1`, any payload that is not
encrypted, and any `Welcome` that does not match. A device enrolled on a
self-hosted relay with `/pirc enrol` stays unencrypted, as now. One
account never shows encrypted and unencrypted sessions side by side, and
no relay can talk a device in an encrypted account into sending
anything in the clear.

## 9. What changes in each part

- **The protocol**: `v1alpha2`, in `Hello`, with the account ID, and the
  login signature binding the account and the relay's origin. The
  envelope and the payload are already apart (`design.md`, section 7), so
  `session.proto` is unchanged: what changes is how its bytes are
  wrapped, and the relay's account frames. The new messages are named in
  the proto files before any code, so that `buf breaking` and `cases/`
  cover them: a list version, a pre-key, a label record, a wrap bundle, a
  signed announcement, a request envelope, the join exchange, and the
  frame that publishes a version.
- **The extension**: no encryption key on disk; per `Host` object a key
  ID, sending keys, a request key and a signed bundle; every announcement
  signed and encrypted, every routed frame encrypted; every request
  decrypted, its target and signer checked, repeats refused, its missing
  list versions taken; the list's anchor in a state file of its own that
  only moves forward; `/pirc join`, `/pirc leave`, and the account in
  `/pirc status`; no label in `Hello`; a 1008 close no longer recording
  the host as removed.
- **The relay** (hosted): accounts in `Hello` and in routing, and a
  registry of many accounts; storing and checking the list's versions,
  admitting keys by the latest; storing pre-keys, label records and wrap
  bundles by key ID, and sending them with the session list; the join's
  lookup; sign-up, attestation, the subscription check and the abuse
  guards (section 6); no labels anywhere. Payloads it still never reads.
- **`web/core` and the mobile app** (TypeScript and Dart, kept in step by
  `cases/`, as now): the keys and the weekly pre-keys, checking the list
  and keeping its latest version, signing versions and adopting them,
  forks; checking bundles and announcements, decrypting; envelopes for
  requests, with the missing versions; the label key and records; typing
  a join code, CPace, and approving; acting on removal only from a
  checked version, and no longer on a 1008 close. CPace is needed only in
  TypeScript and Dart.
- **The iOS notification extension** (`PircNotices`, Swift): the
  read-only pre-key; checking a bundle's and an announcement's signature
  against the host's entry in the list the app checked, which it reads
  from storage shared with the app rather than checking the chain again,
  to stay small; unwrapping the announcement key, decrypting, and
  titling with the label from the label record. With CryptoKit, from iOS
  16 as now.
- **A web client for the hosted relay** (`design.md`, section 12, step 13,
  "The web app stays as it is"): keys in the browser, made by WebCrypto
  as non-extractable keys in IndexedDB; Ed25519 and X25519 are in current
  Chrome, Safari and Firefox. It joins by showing a code. It still trusts
  the page's code on every load, which is the cost of any web client, and
  is stated so.
- **The web app** as it is (self-hosted): nothing.
- **The push gateway**: nothing.
- **Export compliance** (`design.md`, section 12, step 13): the apps
  declare their encryption exempt today, "nothing … beyond the standard
  protocols". End-to-end encryption of content needs that looked at again
  before the first build that has it.

## 10. Rejected, and why

- **One key shared by the whole account**, rotated on each change. The
  simplest, but every host could read every other host's sessions with
  the relay's help, and a read-only key could not be kept from the
  conversation.
- **A pairwise channel between each client and each process**, as
  Signal's sessions are: forward secrecy per message, but every broadcast
  sent once per client, and a ratchet's state kept in every pi process,
  for a gain only against a key stolen from a device while it runs, which
  already has a shell on every host. Weekly pre-keys and per-process
  request keys (section 7) give most of what is left of that gain.
- **MLS** (RFC 9420): built for this shape, groups that change, but no
  library is mature in all of Go, TypeScript, Dart and Swift, and it would
  be the largest dependency in the tree for groups of a few devices that
  one person controls.
- **Keeping the relay in charge of membership** and encrypting only:
  a relay that can add a device can add its own and read everything,
  which is what this exists to prevent (`design.md`, section 5.2).
- **HPKE's authenticated mode for requests**, in the first draft: it ties
  who sent a request to an X25519 key, and a stolen recipient key then
  lets its holder forge senders. A signature inside makes every identity
  an Ed25519 key on the list.
- **A long-term X25519 key per host**: it is one key for every process on
  a machine, so it binds a request to none of them, and a stolen one
  opens every request ever recorded.
- **A short code without a PAKE**, a hash or a MAC under a few characters:
  the relay carries every message, so it can find the secret offline from
  the first one, or grind keys to match a short hash. Without a PAKE the
  secret needs at least 64 bits, about 17 characters to type with the
  lookup (the figures are rough estimates of a GPU farm's reach in ten
  minutes).
- **Links with relay-issued tokens, and approval by comparing keys**, the
  first draft's join flows for a hosted relay: three flows where one does,
  and approval proved the host to the client but left the host unable to
  tell its account's list from one the relay made.
- **A recovery code**: **Decided**, a new account instead (section 3).

## 11. Open

- **A QR code** for joining, beside the typed code, where a camera can see
  the screen (section 5).
- **The lengths of time**: a pre-key's 14 days and its weekly renewal,
  the two days an old private pre-key is kept, a request's five minutes,
  and the minute an old sending key is kept. They are first guesses.
- **Padding** frames to fixed sizes, and hiding session IDs from the
  relay (section 7).

**Risks, not yet settled:**

- **CPace is an Internet-Draft**, not an RFC. The join pins one version of
  it and holds every implementation to that version's test vectors in
  `cases/`. SPAKE2 is an RFC (9382), but needs group addition on Ed25519,
  which no platform's library offers.
- **CPace on the platforms' X25519.** CPace's X25519 suite calls the
  platform's X25519 function on a point it maps to (Elligator2, RFC 9380,
  about 50 lines of field arithmetic in each language). Nobody has yet
  checked that WebCrypto, Node, CryptoKit, Dart's `cryptography` and Go's
  `crypto/ecdh` each take an arbitrary 32-byte input as a public key, and
  behave alike on low-order points. CPace's own check that the result is
  not the identity covers the security side; that it works everywhere is
  untested.
- **Signature contexts** (section 2) are hardening: no collision with the
  current encodings is known.
- **Forks** (section 3) assume a removed device that kept its private key:
  a stolen one, not a lost one.
