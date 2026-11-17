# End-to-end encryption

Status: **Open**. A proposal, 2026-11-15, for the first step towards a
hosted relay (`design.md`, section 5.1 and section 12, step 14), revised
2026-11-17 after two independent reviews, and corrected the same day by
tests of its riskiest assumptions on every platform (sections 2, 5 and
11). Nothing here is built. The
owner's decisions it takes as given are marked **Decided**; the rest is
proposed.

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
- Each pi process makes its own keys, new every day: sending keys, which
  it gives to every device on the list, wrapped for each in a bundle the
  host signs; and a key that clients encrypt their requests to. Hosts keep
  no long-term encryption key.
- Clients and read-only keys each publish an encryption key, signed by
  their signing key, and make a new one every week.
- Announcements and conversation are encrypted with different keys, so a
  phone's read-only key can be given the first and not the second.
  Announcements are also signed by their host.
- Every request is signed by its client, names the process and session it
  is for, carries a counter, and is refused if it is old, a repeat, or out
  of order.
- The relay keeps what it keeps now, encrypted: the latest announcement
  of each session, and now each process's bundle. History stays on the
  host, as now, and is sent encrypted when a client asks for it.
- A new device joins by a code: the device shows it, a client types it.
- Labels and names travel only encrypted. The relay learns none of them.
- Code that predates encryption cannot find the hosted relay.

## 2. Keys per device

- **Signing: Ed25519**, as now: the key a device logs in with, and the key
  that names it on the list. Who signed a list version, a bundle, an
  announcement or a request is checked by an Ed25519 signature against the
  list. A host's routed frames are the exception (section 4): they are
  authenticated by a key only the account's clients share.
- **Encryption, for clients and read-only keys: X25519 pre-keys**. A
  client, and each read-only key, publishes an X25519 public key signed by
  its Ed25519 key, with the account ID, when it was made, and when it
  expires. A device checking one requires that it expires at most 14 days
  after it was made, and has not expired. A new one is made every week,
  and the old private key is deleted two days after the new one is
  published, whatever the hosts have done meanwhile: a relay that keeps a
  new pre-key from the hosts can then stop the device reading, but not
  keep an old private key alive. Hosts wrap only for a current pre-key of
  a device on the list. The relay stores the latest of each device's and
  hands them out; a relay that holds back a new one can keep an old one in
  use for at most its 14 days. Pre-keys are outside the list, so renewing
  one changes no version of it.
- **Encryption, for hosts: one X25519 key per process, per day**, made with
  its sending keys and gone with them (section 4). A host has no
  long-term encryption key, in its key file or on the list.

**On a phone.** A phone has a second Ed25519 key for its read-only key
(`design.md`, section 12, step 13), readable from the first unlock after
a restart, by the iOS notification extension too. Each of the two has a
pre-key, stored as its signing key is:

- the main pre-key's private key with the same protection as the main
  Ed25519 key: released only by Face ID or the PIN, on this device only.
  So the main pre-key is renewed only while the app is open and unlocked.
  A phone stolen while locked yields at most the read-only key's secrets,
  which open announcements, not the conversation. A phone whose app is not
  opened for 14 days stops getting the conversation key until it is,
  which is fine;
- the read-only pre-key readable from the first unlock, and renewed by
  the app or by the notification extension, which holds the read-only
  Ed25519 key, so that notifications keep working on a phone whose app is
  not opened.

A read-only key is given announcement keys and the label key only
(sections 3 and 4).

**Algorithms.** Ed25519, X25519, HKDF-SHA256 and AES-256-GCM, which Go,
Node, WebCrypto, CryptoKit and Dart's `cryptography` all have (WebCrypto's
Ed25519 and X25519 only in recent browsers: Chrome from 2025, Firefox 129,
Safari 17). Keys are wrapped and requests encrypted with HPKE (RFC 9180) in
its base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. HPKE
is built in nowhere PiRC needs it: not in Node, WebCrypto, Dart, or
CryptoKit before iOS 17 (the notification extension's target is iOS 16).
So the extension, the browser client, the app and the notification
extension each build it from the primitives, held in `cases/` to the
CFRG's HPKE test vectors (RFC 9180's appendix has none for this suite;
`test-vectors.json` in the draft's repository, commit `b1f7cb0`); the
relay needs none. Tested 2026-11-17 in Swift: built from CryptoKit's
primitives at an iOS 16 target (HKDF sets the floor, at iOS 14), it
passes that vector, and CryptoKit's own HPKE opens what it seals and the
reverse; it adds about 40 KB. Base mode authenticates no
sender, so being able to decrypt something proves nothing about who made
it: whoever made it is proved by an Ed25519 signature inside, so that
every identity is an Ed25519 key on the list and X25519 keys can be
renewed freely. ChaCha20-Poly1305 is not chosen because WebCrypto lacks
it.

**Ed25519 is verified strictly, alike everywhere.** Libraries differ on
signatures at the edges, and a signer with a stolen key could make one
that one platform accepts and another refuses, and so split an account.
Tested 2026-11-17 on every verifier PiRC uses (Go, Node, WebCrypto in
Chromium, Firefox and WebKit, Dart's `cryptography` 2.9.0, CryptoKit),
with the 12 vectors of "Taming the many EdDSAs" and 21 more: none
differs on a non-canonical `S` or on torsion in `R`; they differ on a
public key encoded non-canonically, which Go, OpenSSL and BoringSSL
accept and the others refuse; and Dart's accepts signatures that no other
does, since its point comparison checks `x` twice and never `y` (a bug,
upstream too). So:

- before verifying, every platform checks the bytes: a 64-byte signature
  and a 32-byte key; `S` below the group order; and for both the key and
  the signature's `R`, `y` below p, with the top bit masked, and not one
  of the ten encodings of small-order points (the eight canonical ones,
  and the two non-canonical ones that decode);
- the equation is the cofactorless one that every platform's API
  computes. Mixed-order keys are not refused: only curve arithmetic of
  our own could find them, and honest keys never are;
- the app uses `cryptography` with the two-line fix to its point
  comparison, by `dependency_overrides`, until upstream takes it.

With these, every verifier decides all 33 vectors alike. `cases/` holds
them, and the relay, the extension, browsers, the app and the
notification extension must all decide them the same way. Some signers'
signatures are randomized (CryptoKit's are), so `cases/` holds signatures
as vectors that must verify, not as bytes to reproduce.

**What is signed and hashed is exact bytes.** Protocol Buffers encodings
are not canonical across languages. So every signed object travels as
`bytes` holding exactly what was signed, and is verified on those bytes
before it is parsed; nothing is re-encoded to check it. A hash of a signed
object (a list version's, say) is over its signed body, without the
signature. `cases/` holds each object's encoding, which every language
must reproduce or accept byte for byte.

**Every signature has its own context.** What a device signs starts with
a fixed string ending in a NUL byte, so that no context is a prefix of
another, followed by the account ID. The strings are `pirc-e2e-v1 `
followed by the kind: `list`, `withdrawal`, `pre-key`, `label-key`,
`labels`, `bundle`, `announcement`, `request` or `join`. No signature can
be taken for another kind. The login challenge (`Auth`) in `v1alpha2` signs
`pirc-auth-v1alpha2`, NUL, the account ID, the relay's origin and the
relay's nonce: the relay chooses the nonce, so nothing a device signs for
another purpose may be encodable as a login, or the reverse. The relay's
origin is its URL's scheme, host and port, in lower case, with the
default port left out and no path, as browsers write an origin.

## 3. The account: a device-signed list

The list (`design.md`, section 5.2) is a chain of versions. Each holds:

- the account's ID, except version 1, whose body hashed is the account
  ID;
- its version number, and the hash of the version before it;
- every device: its role (host, client, or read-only key), its Ed25519
  public key, which device added it, and when; for a read-only key, also
  the client whose it is;
- the hashes of versions withdrawn (below), if any;
- the signing device's key, and its Ed25519 signature over all of it.

**Who may sign.** Version 1 holds exactly one device, a client, which
signs it. Every later version is valid only when signed by a client (not
a read-only key, not a host) in the version before it. That is today's
rule in another form: any registered client may approve, rename, remove
and invite (`design.md`, section 5.3). Hosts sign nothing, since a host
that could add a client could give itself a shell on every other host. A
version that removes a client but keeps its read-only key is invalid:
both go together, a rule the relay applies today (`design.md`, section 7)
and the list now carries.

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
once the relay has taken it. Until it knows the outcome, it keeps the
exact signed bytes and sends those again if it must, and signs no other
N+1. If the relay answers that another client's N+1 got there first, the
client drops its own, fetches the other, checks it, and publishes a
withdrawal: the hash of its own N+1, signed, naming the one that won. It
then signs its change again on top of the winner, if it still applies.

**Forks.** Two versions with the same number and different hashes (of
their bodies), both validly signed, are a fork. They come about in two
ways: two clients changing the list at once, which is honest and is
resolved by a withdrawal; or a dishonest signer, most likely a removed
device whose key was stolen, signing a version on top of one it was still
in. The relay can also make the first kind look like the second, by
showing a dropped version to some devices and holding back its
withdrawal. So:

- **A device that took a version and then sees it withdrawn** by its own
  signer, in favour of the other, moves to the other branch. A withdrawal
  travels like versions do: from the relay, and in the requests that carry
  missing versions (Freshness, below).
- **A client** shown a fork that no withdrawal explains keeps the chain it
  and the clients it trusts have built: the one with the versions it
  adopted. It does not stop. It marks the hosts that announce the other
  branch as needing `/pirc join`. It says that the relay may have caused
  it, and names the other branch's signer as a suspect only if that device
  has been removed.
- **A host** shown a fork that no withdrawal explains stops serving, and
  says so at its terminal: it cannot tell which branch is its account's.
  It is joined again with `/pirc join`.

So the relay, with a stolen key of a removed device, can stop a host until
the person is at it; without one, only until a withdrawal reaches it.
Neither can make the person's own clients stop.

**Labels.** The relay needs keys and roles to admit and route, but not
the names. Names are in a label record, outside the list: each device's
label, encrypted under a label key, with a counter and the list version
it belongs to, signed by a client. A device takes a record only with a
higher counter than the one it has; two records with the same counter (two
clients renaming at once) are ordered by their hashes, the higher winning,
so every device ends with the same one. The label key is one symmetric
key shared by the clients and read-only keys, made new only when a client
or read-only key is removed, and wrapped by the client that makes it for
each current pre-key, each wrap signed by that client, so that the relay
cannot hand a device a label key of its own. A device keeps it once it has
it; a new device gets it, with the current record's counter, in the join
(section 5); a device whose pre-key expired while it was away gets it
wrapped again by any client once it publishes a new one. Renaming is a new
label record, not a new version of the list. Hosts do not get the label
key: they show their own name, and need no other. A read-only key has it,
so that a notification can be titled with the host's name.

**Checking it.** The relay checks every version it is sent (the chain,
the signer, the signatures), so that nobody can fill an account with
junk; but it is the hosts and clients that enforce it. Each keeps the
latest version it has checked, its number and hash, across restarts, and
takes a new one only if it chains from it.

**A host's anchor.** A host's processes share the account's state in a
folder of their own, not in `host.json`: the relay's address, the account
ID, and one file per version they have checked, named by its number and
hash, each created with an exclusive link (the call `relay-client` uses to
create a key file once), so that a file is never replaced. The anchor is
the highest version present. A process that finds its link refused because
the same number is there with another hash has found a fork. Every process
reads the folder before it checks a request's signer and before it signs a
bundle, and makes new keys at once when it finds a removal there, so that
no process stays on an older version than another has seen.

The anchor is set only by `/pirc join`, typed at the host's terminal
(section 5). On a host that already has one, `/pirc join` replaces it;
nothing the relay sends can. `/pirc leave` removes it, and the host stops
serving at once.

**Freshness.** A relay could keep a removed device in an account by never
showing a host the version that removed it. So every request a client
sends carries, inside its encryption and signature, the number and hash
of the latest version the client has, and the versions and withdrawals
the host is missing, which the client knows from the version the host's
announcements carry (section 4). They are small. A host checks them and
moves to the latest before acting on the request; for the list, it needs
nothing from the relay to catch up. When a client sees a host announce an
older version than its own, it sends the host the missing versions at
once, in a request of their own.

What clients make of the versions hosts report:

- **After a removal**, the client that made it follows each host until it
  has a signed announcement or bundle from it at the removal's version or
  later. Until then it says so: "laptop has not yet confirmed that Pixel 9
  is removed; it may still take its requests", and keeps sending the
  versions.
- **A host at a newer version than the client's own**: the client fetches
  that version from the relay and checks it; if it cannot get it, it says
  so: a host knows of a change to the list that this phone has not seen.
- **Every addition** is shown prominently in every client, by labels:
  "'iPad' added by 'Pixel 9' at 14:02", not only in a list in Settings.

What remains, and is said in section 7: whether an honest client's
request ever reaches a host is up to the relay, so how long a removed
device keeps working on a host, unknown to it, has no bound the relay
cannot stretch; the clients show that it is not yet confirmed.

**Removal.** A device acts on its own removal only when a version it has
checked no longer has it. Then it deletes what it keeps: on a phone, its
keys, the chats it kept and its drafts; on a host, its anchor. Nothing the
relay sends without such a version removes anything: the WebSocket close
with "key revoked" (1008), which today deletes a phone's keys and stops a
host for good, means only that the relay refuses the key. The device shows
it and tries again later, backing off. Otherwise a relay, malicious or
broken, could wipe every phone of an account, and with no recovery that
would be the end of the account.

If the version that removes a phone was signed by the very device that
phone was removing at the same time (a thief and the owner removing each
other, with the relay choosing which arrives first), the phone says so
plainly before deleting: removed by the device it was removing, so the
account may be in the other device's hands; make a new account, and run
`/pirc join` at each host.

**The first device.** **Decided**: on a hosted relay, the first device is
a phone. Signing up is one tap, with nothing to fill in, and the phone
makes version 1 with itself in it (section 6).

**Losing every client.** **Decided**: there is no recovery code. Someone
who loses every client makes a new account: a new phone signs a new
version 1, and each host joins it at its terminal, with `/pirc join`.
Nothing is lost but access: the sessions live on the hosts, in pi's
files, and the relay keeps nothing but the latest announcements.

**A stolen phone.** With a second client, the person removes the stolen
one. Its power ends when every host and every client has the version
that removed it, which the clients show host by host (Freshness), and
with the checks on old keys in section 4. A stolen *only* client cannot
be removed: nothing is left to sign its removal. The thief has a shell on
every host until the person, at each host's terminal, runs `/pirc leave`,
or makes a new account and runs `/pirc join` there. The apps should say
so, and suggest a second client, when an account has one.

## 4. Sending keys and what is encrypted

**A process's keys.** Each `Host` object in a pi process (`design.md`,
section 4: a process has one, and after a `/reload` with new code, a new
one that takes over the old one's instance ID) makes, when it starts and
then every day:

- a random 32-byte secret, from which HKDF-SHA256 derives two sending
  keys: one for announcements, one for the conversation, with the key ID
  as the salt and, as `info`, the context `pirc-e2e-v1 announcement key`
  or `conversation key` (NUL-ended), the account ID and the host key;
- an X25519 key pair for requests;
- a key ID, 16 random bytes, which names all of these.

A read-only key is sent the derived announcement key, never the secret,
so it cannot derive the conversation key; a `cases/` test checks that from
a read-only key's wrap nothing more can be had. None of these keys is
handed to a successor: during a `/reload` the old `Host` object and the
new one each have their own, and every frame carries its key ID. So no two
senders ever share a key and its nonce counter.

**The wrap bundle.** The process wraps the sending keys with HPKE for each
current pre-key of the list's clients (both keys) and read-only keys (the
announcement key alone), with, as HPKE's `info`, the context `pirc-e2e-v1
wrap`, the account ID, the host key, the key ID and the recipient's
Ed25519 key. It signs the bundle with the host's Ed25519 key. The
signature covers the account ID, the host key, the instance ID, the key
ID, when the bundle was made, the list version, the process's request
key, every recipient's Ed25519 key, pre-key and ciphertext, and the
bundle's context. It publishes the bundle to the relay, which stores it by
key ID, since two connections can serve one `SessionRef` during a
handover, keeps it while a stored announcement uses that key ID, and
sends it to clients with the session list. With a few dozen devices, that
is a few kilobytes per process per day.

**What a client takes from a bundle.** A client, and the iOS notification
extension, uses a bundle, and frames under its key ID, only if:

- its signature checks against the host's entry in the list the client
  has checked;
- every recipient in it is on that list. So when the client learns of a
  removal, from its own list and not from the relay, it stops reading
  frames under every bundle made before the removal;
- it is the newest bundle of that process the client has seen, or an older
  one for at most a minute after the newer one was made, by the time the
  newer one says, for frames in flight;
- it was made less than 26 hours ago, the daily renewal and some slack.
  Past that, the session is shown as stale ("no new keys from laptop"),
  not with what the old key brings.

Each signed announcement also names its key ID, so a client that has seen
a newer signed announcement refuses frames under an older key ID.
Without these checks, a removed device that kept the conversation key
could, with the relay holding back the new bundle, keep writing what the
person sees as the host's: an answer that says Stop was taken, or text
asking them to run something.

**New keys.** A process makes new keys (sending keys, request key, key ID
and bundle):

- on every removal from the list, so that a removed device cannot read
  what comes after;
- once a day, which bounds what a key read from a process's memory opens.

At each renewal it announces its session again under the new keys, since
the relay's stored announcement must stay readable. An addition needs no
new key: the process wraps the current one for the new device, which can
read the history anyway. A renewed pre-key needs only a new wrap of the
current keys, in a new bundle. The old request key is kept for two
minutes after the new bundle is made, for requests already on their way;
the old sending keys are not used again.

Processes do not share keys, even on the same machine, so no pi process
needs another's state, and no host can read another host's sessions,
even with the relay's help.

**What a host sends.**

- *Announcements*: the payload of `SessionAnnounce`, which the relay
  stores and replays, is signed by the host's Ed25519 key, then encrypted
  with the announcement key. The signature covers its context, the
  account ID, the full `SessionRef`, the key ID, the list version the host
  has, when it was made, and the announcement itself, notice included, so
  that a woken phone reads it with its read-only key, as now. It is signed
  because the announcement key is shared with read-only keys, the least
  protected keys in the account: without the signature, someone with a
  read-only key and the relay could write a question notice of their own
  choosing into a phone's notifications, or move one session's
  announcement to another.
- *Everything routed*: the payload of `Routed`, both broadcasts and
  answers to one client, is encrypted with the conversation key. An
  answer meant for one client can be read by every other client of the
  account, which can ask for the same answer anyway. These are not
  signed: only clients have the conversation key, and a client is a shell
  on the host already. A removed client's copy is what the checks above
  shut out.
- **Each frame** is AES-256-GCM. It carries in clear its key ID, a 64-bit
  counter, and the list version its host had; the nonce is four zero
  bytes and the counter, which counts up from zero and is never repeated
  under one key, since the key belongs to one `Host` object alone. The
  additional data is the context `pirc-e2e-v1 frame`, the account ID, the
  key ID, the `SessionRef`, the direction and kind of frame, the recipient
  for an answer to one client, the list version and the counter. The
  receiver takes the key ID, the counter and the list version from the
  frame, and fills in the rest from what it knows: the session the frame
  came for, and whether it is a broadcast or an answer to itself. So the
  relay cannot move a frame from one session to another, or from one
  client to another, without its failing.
- **No replays.** A client accepts, under each key ID, only counters
  higher than the last it accepted. It sees only some of a process's
  frames (those for the sessions it is attached to, and its own answers),
  but in order. The one exception is the stored announcement, which may
  come again with the same counter and the same bytes.

**What a client sends.** Each request (`Routed` from a client) is put in
an envelope that holds:

- the target: the account ID, the full `SessionRef` (host key, session
  ID, instance ID) and the key ID of the process's request key;
- the direction, client to host;
- the time, and a counter, which goes up with each envelope this client
  sends under that request key, kept by the client in its storage;
- the client's latest list version, with any versions and withdrawals the
  host is missing (section 3);
- the request itself;
- the client's Ed25519 signature over all of the above.

The envelope is encrypted with HPKE to the process's request key, from
the bundle, with, as `info`, the context `pirc-e2e-v1 request`, the
account ID, the host key and the key ID. A process that gets one checks,
in this order:

1. that it decrypts. This proves only that it was meant for this
   process's key, which anyone, the relay included, can encrypt to;
2. that the target is itself: the account, its `SessionRef` as it is now
   (a process changes session on `NewSession`, a resume or a fork) and its
   key ID;
3. the list versions and withdrawals it carries, which check themselves;
   it records them and moves its anchor, so that a client added in a
   version the host had not yet seen can be taken in its first request;
4. the signature, and that its key is a **client's** on the list as it now
   is. A read-only key's and a host's are refused. The read-only key is
   the one a phone keeps readable while locked, and must not be a shell;
   this rule has a test of its own in `cases/`;
5. that the signer is the client the relay named in `Routed.client_key`;
   from then on the host knows the client by its signature, not by what
   the relay says;
6. that its time is within two minutes of the host's own, and its counter
   higher than the last it accepted from that client under this request
   key;
7. that it is not a repeat (below).

Only then does it run it. Requests are few and small (prompts, actions),
so a key exchange and a signature each cost nothing.

**Order.** The counter keeps the relay from reordering a client's
requests: it cannot deliver an Abort and then the prompt it was meant to
stop, or a prompt after the `NavigateTree` that came after it. A request
held back and delivered after a later one is refused; the client sees the
refusal or no answer, and sends it again as a new envelope if it still
wants it.

**Repeats.** The relay must not be able to run a request twice. Today a
repeated request ID is how a client retries: after a retryable error
(`BUSY`, `TIMEOUT` and the like), a repeat runs again (`design.md`,
section 7). So a repeat of the same request ID cannot be the test. Instead:

- The process records every envelope it accepts, by its HPKE
  encapsulated key, which is new for every encryption, and refuses the
  same one again. It keeps each for four minutes, twice the window,
  measured on a monotonic clock, so that a change of the system clock
  cannot shorten it. The set belongs to the request key, and goes when it
  does; an envelope for an old key cannot be opened after that key is
  gone.
- A client's retry is a new envelope, with a new time, a higher counter
  and a new encryption. It keeps its request ID, so that a retry of a
  request the host has already answered gets that answer, and is not run
  again.
- That idempotency is keyed by the signer and the request ID, and the
  answers it keeps are handed over by `Host.succeeding`, with the
  sequence numbers and notices it hands over now. Today it covers only
  requests that change something, is keyed by the `client_key` the relay
  gives and the session ID, keeps 1,000 entries, and is not handed over;
  all of that changes, in a form an older `Host` object's successor can
  still read.

So the relay can delay a request, within its two minutes, or drop it,
but not run it twice, or after a later one from the same client. The two
minutes are by the host's clock against the client's: a client whose clock
is off by a minute gives the relay a minute more, or less. Phones and
computers keep their clocks set from the network; one off by more than the
window cannot send at all, and says so.

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
  exchange, suite CPACE-X25519-SHA512, pinned at
  `draft-irtf-cfrg-cpace-21`, which is with the RFC Editor), which never
  leaves the two devices.

A code is good for one try and ten minutes. The device that shows it
forgets it at the first failed attempt, whatever the relay says, and a
client tries a lookup only once: typing the same code again after a
failure is refused, and a new code is needed. Each attempt gives the relay
one guess, at about one in 2^25, and nothing to try offline: with a code
this short, anything but a PAKE would let it find the secret from the
first message it carried (section 10). A relay that poses as the waiting
device to the client gets its guess without the real device seeing
anything, so the client, not only the new device, reports every failed
join plainly, as a possible attack.

**The exchange.** Through the relay:

1. `/pirc join` at the host's terminal (or the join screen of a new
   browser or phone) makes the code and a nonce, and waits.
2. The person types the code into a client. The two run CPace, with a
   session ID made of the string `pirc-join-v1`, the relay's origin, the
   lookup characters and the nonce, and confirm the key in both
   directions. A failed confirmation ends the join on both sides. From
   CPace's key, HKDF derives one key for each direction; each message is
   AES-256-GCM under its direction's key, with a counter as its nonce, and
   carries the hash of the transcript so far.
3. Under those keys the new device sends its role (host or client), its
   Ed25519 key, the name it would like to be shown by (the machine's
   name, for a host), for a client its first pre-key, and its signature,
   with its own context, over the transcript and all of these, which
   proves it holds the key it hands over.
4. The client shows what is about to happen, by role, in words, before the
   name: for a host, "a computer: you will be able to control it from
   here"; for a client, "a new browser or app: it will have full control of
   all 4 of your computers". It says that the name is what the device calls
   itself, and asks the person to confirm that they are holding, or
   sitting at, the device that shows this code. Then it signs version N+1
   with the new device in it, adopts it as in section 3, and sends: the
   account ID, version N+1 and its own key, and to a new client the label
   key and the current label record's counter. It writes the new device's
   name into a new label record.
5. The new device fetches the chain from the relay, checks that it hashes
   to that account ID, chains, and ends at N+1, signed by that client.
   Only then does it keep its anchor and start serving (a host) or working
   (a client).

The name travels only in step 3 and in the label record, never in `Hello`
(section 7).

**CPace on each platform.** The platform's X25519 does CPace's scalar
multiplications. Before it, the other side's point is made canonical (bit
255 cleared, then reduced mod p), since Firefox refuses at import some
non-canonical encodings that every other platform takes; the transcript
keeps the bytes as received. An error from the platform and an all-zero
result both end the join, as a failed confirmation does: on a low-order
point every platform raises an error except Dart's `cryptography`, which
returns zeros, so CPace's own check is the one that acts there. Tested
2026-11-17 in TypeScript (in Node, Chromium, Firefox and WebKit) and in
Dart: both pass draft 21's vectors, and joins between them succeed both
ways, and fail on a wrong code or a low-order point put in by the relay.

**What a host says.** A code hands whoever types it a shell on the
machine, and a code read out over the phone is how device-code phishing
works. So `/pirc join` says, beside the code, that it gives whoever types
it full control of this machine, and after the join it says which client
approved it, by name: "Joined the account, approved by 'Pixel 9'". The
other direction, a stranger's device showing a code and persuading the
person to type it, would hand over every machine; step 4's wording is
there for it.

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

A hosted relay holds many accounts. The account ID is in `Hello`, and in
the login signature (section 2). The relay routes only within an account:
a session's frames go only to that account's clients, and a key logs in to
the accounts whose latest version lists it. A device belongs to one
account; a person with two accounts uses two installs, as now with two
relays. Sharing between accounts is not part of this. The relay's registry
holds one account today (`relay/internal/registry`); holding many is a
rewrite of it, not an addition.

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

- refuse a device, or drop, delay (within two minutes, for a request) or
  withhold frames;
- keep a removed device working on a host, for as long as it keeps every
  honest client's requests from that host; the clients show the removal as
  not yet confirmed there (section 3, Freshness);
- with a stolen key of a removed device, on a host that has not yet seen
  the removal: have that device sign a version adding a device of the
  relay's own, which the host takes as an ordinary next version, so that
  the relay has a client there until a version from the person's clients
  reaches the host, which then sees a fork and stops (section 3, Forks);
- with a stolen key of a device not yet removed: add a device and show
  that version to hosts while holding it back from the person's other
  clients. The clients see it once a host reports a newer version than
  theirs (section 3, Freshness), and every addition is shown;
- show a dropped version to some devices and hold back its withdrawal,
  which stops hosts until a withdrawal reaches them (section 3, Forks);
- show a client an older stored announcement on its first look at a
  session, before a question was asked, say; counters catch a rollback
  within a stream, not on the first view. This is withholding by another
  name;
- hold back a device's new pre-key, keeping its old one in use for up to
  14 days, or keep a new one from the hosts, so that the device stops
  reading after two days (section 2);
- answer a client's join attempt as the waiting device, for one guess at
  the code (section 5).

Not hidden, and stated so: the timing and size of traffic, and the
membership of each account. Padding frames to fixed sizes, or hiding
session IDs from the relay, could come later; neither is needed to keep
the content private.

**Stolen keys, and what they open later.** For a relay that records what
it routes, and later gets a device's key:

- **Requests** are encrypted to a process's request key, which exists
  only in that process's memory and is renewed every day. A host's key
  file holds no key that opens them. A read of a process's memory opens
  the requests of the last day or so, not every request of its life.
- **What hosts send** is under sending keys renewed daily and wrapped for
  clients' pre-keys. A stolen client or read-only key opens what was
  wrapped for the pre-keys it still holds: the last week or two of
  traffic, not everything since the device joined, since old private
  pre-keys are deleted. A phone stolen while locked gives up only the
  read-only pre-key, which opens announcements, not the conversation
  (section 2). That is the forward secrecy this design has, short of a
  ratchet (section 10).
- **A stolen host key** (Ed25519) opens nothing recorded; it lets its
  holder, with the relay, act as that host until the host leaves or is
  removed.
- **A stolen client key** is a shell on every host anyway, until it is
  removed (section 3).

## 8. Self-hosted relays, and code from before

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
account never shows encrypted and unencrypted sessions side by side.

**Code from before encryption must not find the hosted relay.** That
refusal lives only in new code. Every extension released so far reads the
relay's address from `host.json` (or `PIRC_RELAY`) each time it connects,
speaks `v1alpha1`, and runs any request from any client the relay names:
in `v1alpha1` the relay is trusted completely. A machine can run old and
new code at once: two installs of PiRC (the reason for `copies.ts`), a
project's own older copy, or a downgrade after a bad release. If old code
found the hosted relay's address, a malicious relay would answer it in
`v1alpha1` and have that process's content and a shell. So:

- The hosted relay's address, and that the account is encrypted, are kept
  only in the anchor's folder (section 3), never in `host.json`'s `relay`.
- `/pirc join` writes, into `host.json`'s `relay`, a value every released
  version refuses before it opens a socket: an address with the scheme
  `pirc-e2e:`, which their `relayURL()` rejects, as it rejects anything
  but `ws:` and `wss:`. Old code then fails to connect, and says so.
- New code with an anchor ignores `PIRC_RELAY` and refuses to start if it
  names another relay.
- A test runs the last unencrypted release against a host that has joined
  a hosted account, and checks that it does not connect.

A hosted account is safe from a downgrade only as long as no code from
before encryption can find the hosted relay; that is what these are for.

## 9. What changes in each part

- **The protocol**: `v1alpha2`, in `Hello`, with the account ID; `Welcome`
  with the mode; the login signature binding the account and the relay's
  origin. The envelope and the payload are already apart (`design.md`,
  section 7), so `session.proto` is unchanged: what changes is how its
  bytes are wrapped, and the relay's frames. `Routed` and
  `SessionAnnounce` gain the key ID, counter and list version; the session
  list's entries (`SessionEntry`, `SessionUpdated`) carry bundles; and
  there are new frames for pre-keys (the relay sends each host every
  current pre-key of its account, and every new one), for publishing a
  bundle and its acknowledgement, for list versions and withdrawals, for
  label records and label-key wraps, and for the join. The new messages
  are named in the proto files before any code, so that `buf breaking`
  and `cases/` cover them. `design.md` (section 7's envelope, section
  5.2) is updated with the hosted design once it is decided.
- **The extension**: no encryption key on disk; per `Host` object, renewed
  daily, a key ID, sending keys, a request key and a signed bundle; every
  announcement signed and encrypted, every routed frame encrypted with its
  counter; every request decrypted and checked in order, repeats and
  reorderings refused; the anchor's folder, read before every check;
  frames from the relay it ignores today (`Host.onFrame` takes only
  `routed` and `error`): pre-keys, bundle acknowledgements, versions;
  `/pirc join`, `/pirc leave`, and the account in `/pirc status`; the
  `pirc-e2e:` address in `host.json`; no label in `Hello`; a 1008 close no
  longer recording the host as removed (old code still does, which is
  harmless).
- **The relay** (hosted): accounts in `Hello` and in routing, and a
  registry of many accounts; storing and checking the list's versions and
  withdrawals, admitting keys by the latest; storing pre-keys, label
  records, label-key wraps and bundles by key ID, and sending them; the
  join's lookup; sign-up, attestation, the subscription check and the
  abuse guards (section 6); no labels anywhere. Payloads it still never
  reads.
- **`web/core` and the mobile app** (TypeScript and Dart, kept in step by
  `cases/`, as now): the keys and the weekly pre-keys, stored as section
  2 says; checking the list and keeping its latest version, signing
  versions, adopting and withdrawing them, forks; checking bundles and
  announcements as section 4 says, decrypting, and refusing old keys and
  replayed counters; envelopes for requests, with their counters and the
  missing versions; the label key and records; typing a join code,
  CPace, and approving by role; following each host's confirmation of a
  removal, and showing additions; acting on removal only from a checked
  version, and no longer on a 1008 close; in the app, `cryptography`
  with its point comparison fixed (section 2). CPace is needed only in
  TypeScript and Dart. `relay-client`, the relay connection the extension
  uses, is Node only; a browser client needs a connection of its own in
  `web/core`, which has none today.
- **The iOS notification extension** (`PircNotices`, Swift): from storage
  shared with the app, the checked list (host keys and roles, at least),
  the read-only pre-key, the label key and label records; in the same
  fetch, the bundles; checking a bundle's and an announcement's signature
  and recipients against the list the app checked, rather than checking
  the chain again, to stay small; unwrapping the announcement key with
  HPKE written in Swift (its target is iOS 16, and CryptoKit has HPKE
  from 17), decrypting, and titling with the label from the label record;
  renewing the read-only pre-key when the app has not. Today it logs in
  with `v1alpha1`, titles from `SessionEntry.host_label`, and keeps only
  the read-only key's seed and what it has shown.
- **A web client for the hosted relay** (`design.md`, section 12, step 13,
  "The web app stays as it is"): keys in the browser, made by WebCrypto
  as non-extractable keys in IndexedDB. It joins by showing a code. It
  still trusts the page's code on every load, which is the cost of any web
  client, and is stated so. Since every client is a shell on every host,
  whoever controls the page's code controls every account with a browser
  on it. **Decided** (2026-11-17, `design.md` step 14): the page is served
  as fixed files from Cloudflare Pages, apart from the relay, so that
  getting into the relay does not give anyone the page; what an account
  with a browser trusts is then Cloudflare Pages and the publisher's
  deploy of the page, besides its own devices. Safari deletes a site's storage after seven
  days without use unless it is installed (added to the Dock or home
  screen), so in Safari it is to be installed, or it loses its keys and
  stays on the list as a device nobody holds; clients show, for each
  device, when the relay last saw it, so such entries can be found and
  removed.
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
  already has a shell on every host. Weekly pre-keys and daily keys per
  process (section 7) give most of what is left of that gain.
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
- **Signing every routed frame**: it would make every frame's sender
  provable, but costs a signature per streamed delta. The checks on old
  keys in section 4 shut out a removed client, the only one that holds the
  conversation key and is not trusted.
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
- **The lengths of time**: a pre-key's 14 days and its weekly renewal, the
  two days an old private pre-key is kept, a request's two minutes, the
  minute an old bundle is read after a newer one, the 26 hours a bundle
  is read at all, and the two minutes an old request key is kept. They are
  first guesses.
- **Padding** frames to fixed sizes, and hiding session IDs from the
  relay (section 7).

**Risks, not yet settled:**

- **CPace is not yet an RFC**: draft 21 is with the RFC Editor. The join
  pins it and holds every implementation to its test vectors in `cases/`.
  SPAKE2 is an RFC (9382), but needs group addition on Ed25519, which no
  platform's library offers. The map to the curve (Elligator2, RFC 9380)
  runs on numbers derived from the password, and is not constant-time in
  TypeScript or Dart big integers: a side channel on the device only, not
  one the relay can measure. The platforms' X25519 was tested 2026-11-17
  (section 5); Firefox in Playwright's build, not a released Firefox.
- **Ed25519 verifiers** (section 2): their differences are known and the
  checks there make them agree, tested 2026-11-17. CryptoKit has changed
  its answers before (in 2020 it accepted non-canonical keys), which the
  byte checks cover; a platform that moved to the cofactored equation
  would show in the mixed-order vectors. The app depends on a patched
  `cryptography` until upstream fixes its point comparison.
- **Not tested on iOS 16** itself: no iOS 16 simulator or device was at
  hand, only iOS 18 and 26 simulators and a compile at an iOS 16 target.
- **Signature contexts** (section 2) are hardening: no collision with the
  current encodings is known.
- **Old code** (section 8): how often a machine has two installs of PiRC,
  or a project's own older one, is not known; it happens, which is enough
  to guard against it.
- **Forks** (section 3) by a dishonest signer assume a removed device that
  kept its private key: a stolen one, not a lost one.
