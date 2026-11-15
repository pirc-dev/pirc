# End-to-end encryption

Status: **Open**. A proposal, 2026-11-15, for the first step towards a
hosted relay (`design.md`, section 5.1 and section 12, step 14). Nothing
here is decided, and nothing of it is built.

The aim: a relay that routes every session but can read none of them, and
cannot add a device to an account. Today a relay is trusted completely
(`design.md`, section 6), which is acceptable only because it is the
person's own. A relay run by someone else, the publisher's included, must
be able to see only what it needs to route: which devices are in an
account, which are connected, and the size and timing of what they send.

## 1. What changes, in short

- Every device gets an encryption key beside the signing key it has now.
- The account becomes a list of devices that only the account's clients
  can change, each version signed by a client in the version before it.
  The relay stores the list and checks it, but cannot forge it. Hosts and
  clients trust a device because it is on the list, not because the relay
  let it log in.
- Each pi process makes its own sending keys and gives them to every
  client on the list, wrapped for each. It encrypts its announcements and
  everything it sends with them. Clients encrypt each request to the host.
- Announcements and conversation are encrypted with different keys, so a
  phone's read-only key can be given the first and not the second.
- The relay keeps what it keeps now, encrypted: the latest announcement
  of each session, and now each process's wrapped keys. History stays on
  the host, as now, and is sent encrypted when a client asks for it.
- The push gateway sees what it sees now. The relay still knows when to
  wake a phone, from a flag outside the payload.

## 2. Keys per device

Every device has two key pairs:

- **Signing: Ed25519**, as now: the key a device logs in with, and the key
  that names it. Nothing changes for it.
- **Encryption: X25519**, new, made beside it and kept the same way (the
  host's key file, the phone's Keychain or Keystore, the web app's
  server's key file). It is published on the device list, signed by the
  device's own Ed25519 key, so that whoever adds the device to the list
  vouches for both at once. A separate key rather than one converted from
  the Ed25519 key: the conversion is safe but unusual, the platforms'
  libraries (WebCrypto, CryptoKit) do not offer it, and a second key costs
  32 bytes.

A phone has a second pair of each for its read-only key (`design.md`,
section 12, step 13): readable from the first unlock after a restart, by
the iOS notification extension too. It is on the list as the read-only
key of its client, and is given announcement keys only (section 4).

The algorithms are those every platform PiRC runs on has built in:
Ed25519, X25519, HKDF-SHA256 and AES-256-GCM (in Go, Node, WebCrypto,
CryptoKit from iOS 13, and Dart's `cryptography`). Keys are wrapped with
HPKE (RFC 9180): DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
Where a platform has no HPKE (CryptoKit before iOS 17, Dart), it is built
from those primitives and held to the RFC's test vectors in `cases/`.
ChaCha20-Poly1305 is not chosen because WebCrypto lacks it.

## 3. The account: a device-signed list

The list (`design.md`, section 5.2) is a chain of versions. Each holds:

- the account's ID, the hash of version 1;
- its version number, and the hash of the version before it;
- every device: its role (host, client, or a client's read-only key), its
  Ed25519 and X25519 public keys, the signature of the second by the
  first, which device added it, and when;
- the devices' labels, encrypted (below);
- the signing device's key, and its Ed25519 signature over all of it.

**Who may sign.** A version is valid only when signed by a client (not a
read-only key, not a host) in the version before it. That is today's rule
in another form: any registered client may approve, rename, remove and
invite (`design.md`, section 5.3). Hosts sign nothing, since a host that
could add a client could give itself a shell on every other host.

**What each change becomes.** Approving a host, issuing a link that a new
device joins by, renaming, removing and registering a read-only key are
each a new version, signed by the client that does it. The relay's
`ApproveHost`, `RenameKey`, `RemoveKey` and `RegisterReadKey` give way to
one frame that publishes a version. The operator's command line on a
hosted relay can no longer change an account at all; a self-hosted
relay's operator holds a client key of their own for it, if they want
one.

**Labels.** The relay needs the keys and roles to admit and route, but
not the names. Each version carries a fresh label key, wrapped for every
client's X25519 key, and the labels encrypted under it. Hosts do not get
it: they show their own name, and need no other.

**Checking it.** The relay checks every version it is sent (the chain,
the signer, the signatures), so that nobody can fill an account with
junk; but it is the hosts and clients that enforce it. Each keeps the
latest version it has checked, its number and hash, across restarts (the
host in its configuration file, the phone in its storage), and takes a
new one only if it chains from it. Two versions with the same number and
different hashes are proof that the relay, or a signer, forked the list:
the device says so and stops trusting either.

**Freshness.** A relay could keep a removed device in an account by never
showing a host the version that removed it. So every request a client
sends carries, encrypted with it, the number and hash of the latest
version that client has. A host that sees a newer one than its own
fetches and checks it before acting on the request, and refuses the
request if it cannot. The relay can still withhold the new version from a
host, but then the host refuses every honest client's requests, which is
seen at once, instead of quietly obeying the removed one. And every
announcement carries, encrypted, the version its host has, so a client
can show a host that is behind.

**The first device, and losing every device.** On a hosted relay, the
first client to sign up makes version 1 with itself in it. When every
client is lost, nothing is lost but access: the sessions live on the
hosts, in pi's files, and the relay keeps nothing but the latest
announcements. So recovery is a new account: a new client signs a new
version 1, and each host joins it again, at its terminal (`/pirc enrol`).
A recovery code (a client key printed on paper) may come later; it is not
needed to start.

## 4. Sending keys and what is encrypted

**A host's sending keys.** Each pi process, when its module is first
evaluated (where its instance ID is made, `design.md`, section 4), makes
a random 32-byte secret and derives two keys from it with HKDF: one for
announcements, one for the conversation. It wraps them with HPKE for each
client on the current list, both for a client's main key and the
announcement key alone for a read-only key, and publishes the wrapped
keys to the relay, which stores them with the process's sessions and
sends them to clients with the session list. With a few dozen devices
that is a few kilobytes per process, sent once.

It makes new ones whenever the list changes, so that a removed device
cannot read what comes after, and at least once a day. A key from before
is kept for a minute, for frames already in flight. Hosts do not share
sending keys, even with other processes on the same machine, so no pi
process needs another's state, and no host can read another host's
sessions, even with the relay's help.

**What a host sends.**

- *Announcements*: the payload of `SessionAnnounce`, which the relay
  stores and replays, is encrypted with the announcement key. Its notice
  is inside, so a woken phone reads it with its read-only key, as now.
- *Everything routed*: the payload of `Routed`, both broadcasts and
  answers to one client, is encrypted with the conversation key. An
  answer meant for one client can be read by every other client of the
  account, which can ask for the same answer anyway.
- Each frame is AES-256-GCM under a nonce that counts up, never repeated
  under one key, since the key is the process's alone. The additional
  data binds it to its place: the account, the `SessionRef`, the
  direction and kind of frame, the recipient for an answer to one client,
  and the list version. So the relay cannot move a frame from one session
  to another, or from one client to another, without its failing.

**What a client sends.** Each request (`Routed` from a client) is
encrypted to the host with HPKE in its authenticated mode, from the
client's own X25519 key. The host takes it only if that key is a client's
on its list, which replaces trusting the `client_key` the relay sets.
Requests are few and small (prompts, actions), so the cost of a key
exchange each is nothing. Inside, beside the request, the client puts the
time and its list version (above); the host refuses a request more than a
few minutes old, and the request ID it already keeps answers a repeat
(`design.md`, section 7), so the relay cannot replay a prompt.

**History.** It is on the host, as now, and goes to a client only when
asked for, encrypted as any other answer. A client added today can read
yesterday's conversation, because it asks the host for it, which is the
product's model: every client sees every session. No key from before the
client joined is ever needed, and the relay stores no conversation to
protect.

**The phone's own copy.** Unchanged: kept on the phone, protected as now
(`design.md`, section 12, step 13).

## 5. Joining: how a new device gets the keys

A new device needs two things: to be put on the list by a client, and to
know that the list it then downloads is its account's and not one the
relay made. Today's flows stay, each with an out-of-band check added.

**A client, by link or QR code.** The link an existing client shows
(`pirc://join?relay=…&token=…`) gains two fields that the relay never
sees: a one-time secret, and the hash of the inviting client's latest
list version. The new device registers its keys through the relay with
the token, as now, and with them a MAC of its keys under the secret. The
inviting client, which waits for it, checks the MAC (so the relay cannot
put its own keys in), signs a new version with the new device in it, and
the new device checks that the list it gets chains from the hash in the
link (so the relay cannot give it a list of its own).

**A host, by token.** The `/pirc enrol <relay-url> <token>` line gains the
same secret and hash, and the host does what a new client does.

**A host, by approval.** Today the person compares the host's key, shown
in the client's sheet, with `/pirc status` at the host. That proves the
host to the client, and stays. The other direction is new: the host
cannot yet tell its account's list from one the relay made. So after the
client approves, the host shows the account's code, a short form of the
list's latest hash, and asks the person at its terminal to confirm that
it is the one the client shows (`/pirc status`, and the footer until
then). Until it is confirmed, the host announces nothing and takes no
request. **Open**: whether this second check is worth its cost to "install,
then approve", or the token path should become the only one on a hosted
relay.

**A read-only key** is registered by its own client, on the same phone,
as a new version of the list; no out-of-band step is needed.

## 6. Several accounts on one relay

A hosted relay holds many lists. The account ID (the hash of version 1)
is in `Hello`, and the relay routes only within an account: a session's
frames go only to that account's clients, and a key logs in to the
accounts whose latest version lists it. A device belongs to one account;
a person with two accounts uses two apps' keys or two installs, as now
with two relays. Sharing between accounts is not part of this.

What the relay controls is admission, not membership. It can refuse a
device it should take (the device sees it cannot connect), but it cannot
let in one the list does not have, and cannot read what it routes.
Signing up, limits per account and paying are a hosted relay's own
questions, outside this design.

## 7. What the relay and the push gateway see

**The relay**, afterwards:

- each account's devices, by public key and role, and the list's
  history: who added whom, and when;
- which are connected, from what address, when;
- every `SessionRef`: host key, pi's session ID (a UUIDv7, so it holds
  the session's start time) and instance ID;
- the size and timing of every frame, and so roughly when a session is
  working, and how much;
- the `push` flag, so when a turn ended or a question was asked, as now.

**Not**: session names, folders, models, the host's name for itself,
devices' labels, prompts, replies, tool calls, images, notices, or
anything else of the conversation.

**The push gateway** sees what it sees now (`SECURITY.md`): which relay
woke which phone, and when. The push carries nothing, and nothing in this
design changes that.

Not hidden, and stated so: the timing and size of traffic, and the
membership of each account. Padding frames to fixed sizes, or hiding
session IDs from the relay, could come later; neither is needed to keep
the content private.

**No forward secrecy against a stolen device key.** A relay that records
what it routes, and later gets a client's X25519 key, can unwrap every
sending key that was wrapped for that client, and read all it recorded
while those keys were in use. One that later gets a host's X25519 key can
read every request it recorded that was sent to that host. Making new
sending keys daily, and on every change to the list, does not limit
this: each new one is wrapped for the same long-lived X25519 keys, so a
stolen key opens everything recorded since that device's key was made.
What would limit it is renewing the devices' own encryption keys, each
new one signed by the device's Ed25519 key and the old private key
deleted, so that a stolen key opens only the period since the last
renewal; it is open (section 11). Section 10 says why this design takes
the rest.

## 8. Moving from v1alpha1

A new protocol version, `v1alpha2`, in `Hello`. The envelope and the
payload are already apart (`design.md`, section 7), so the session
protocol (`session.proto`) is unchanged: what changes is how its bytes
are wrapped, and the relay's account frames.

- **A hosted relay takes `v1alpha2` only.** Nothing unencrypted ever
  reaches it.
- **A self-hosted relay takes both**, until a later release drops
  `v1alpha1`. Its account starts when a client makes version 1 of the
  list from the relay's current registry: the relay hands the client the
  registered keys, every device updated to `v1alpha2` publishes its
  X25519 key signed by its Ed25519 key, and the client signs a version
  listing those it can see the person recognises (labels and keys, as in
  the device list today). A device not yet updated stays on the old
  protocol, its sessions shown "not encrypted" in every client, and a
  relay setting, `--require-encryption`, refuses it, which a self-hoster
  sets once all their devices are updated. Removing it from the relay's
  registry then is as now.
- **The web app's server** on a self-hosted relay is a client like any
  other, with its own key pair and a place on the list; it decrypts what
  its browsers see, as it reads everything now. A self-hoster who wants
  their own server out of that path uses the mobile app, or later the
  hosted relay's web client.
- **Extensions update at their owner's pace** (`design.md`, section 7), so
  clients keep reading `v1alpha1` announcements for as long as a
  self-hosted relay takes them.

## 9. What changes in each part

- **The extension**: an X25519 key beside the host key, written at
  enrolment as now; fetching, checking and keeping the list, its version
  shared by the processes on the host (their latest wins, written
  atomically); a process's sending keys and their wrapped copies; every
  announcement and routed frame encrypted, every request decrypted and its
  sender checked against the list; refusing requests that are too old or
  that carry a list version it cannot reach; the account's code in
  `/pirc status`, and confirming it after approval; the enrol line's
  secret.
- **The relay**: accounts in `Hello` and in routing; storing and checking
  the list's versions, admitting keys by the latest; storing each
  process's wrapped keys and sending them with the session list; labels
  gone from its own registry; the account frames replacing approve,
  rename, remove and read-key registration; `--require-encryption`; both
  protocol versions for a while. Payloads it still never reads.
- **`web/core` and the mobile app** (TypeScript and Dart, kept in step by
  `cases/`, as now): the keys, checking the list and keeping its latest
  version, signing a new version for every change a client makes,
  unwrapping each process's keys, decrypting announcements and
  conversation, encrypting requests; the join link's secret and hash; an
  account code to show; a host shown as behind, or as not encrypted. A
  fork in the list stops the app with a warning.
- **The iOS notification extension** (`PircNotices`, Swift): its read-only
  X25519 key; unwrapping the announcement keys and decrypting
  announcements, with CryptoKit, from iOS 16 as now. It trusts the list as
  the app checked it, from storage shared with the app, rather than
  checking it again, to stay small.
- **The web app** (self-hosted): its server as one more client, through
  `web/core`; the page unchanged.
- **A web client for the hosted relay** (`design.md`, section 12, step 13,
  "The web app stays as it is"): keys in the browser, made by WebCrypto
  as non-extractable keys in IndexedDB; Ed25519 and X25519 are in current
  Chrome, Safari and Firefox. It still trusts the page's code on every
  load, which is the cost of any web client, and is stated so.
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
  already has a shell on every host. The cost of rejecting it is stated
  in section 7: without a ratchet there is no forward secrecy, and a
  device key stolen later opens the traffic a relay recorded before,
  back to when that key was made.
- **MLS** (RFC 9420): built for this shape, groups that change, but no
  library is mature in all of Go, TypeScript, Dart and Swift, and it would
  be the largest dependency in the tree for groups of a few devices that
  one person controls.
- **Keeping the relay in charge of membership** and encrypting only:
  a relay that can add a device can add its own and read everything,
  which is what this exists to prevent (`design.md`, section 5.2).

## 11. Open

- The host's confirmation of the account's code after approval (section
  5), or the token path only on a hosted relay.
- How long a self-hosted relay keeps taking `v1alpha1`.
- A recovery code, or only a new account (section 3).
- How often a host makes new sending keys beyond list changes: daily is
  proposed.
- Renewing each device's X25519 key, weekly say, signed by its Ed25519
  key, with the old private key deleted, which bounds what a stolen key
  opens to the time since the last renewal (section 7). Short of a ratchet,
  it is the forward secrecy this design can have; it costs a key that changes
  under the list, which then names a device by its Ed25519 key alone.
- Whether a removed device's sessions on its phone are deleted when it
  next connects and learns it was removed (it is today, by the relay
  closing it as revoked).
