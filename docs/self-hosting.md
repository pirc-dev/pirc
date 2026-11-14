# Self-hosting PiRC

PiRC has three parts: a **relay**, which every host and client connects
to; the **pi extension**, on every machine that runs pi; and **clients**.
This guide covers the relay, the extension and the web app.

One relay serves one account: every client it admits sees every host it
admits. The relay passes messages along without reading them, but in this
version they are not end-to-end encrypted, so whoever runs the relay
could read them. Run it yourself, on a machine you trust.

## With Docker Compose

The shortest way, on a machine with Docker and a public name: the relay
and the web app in containers, behind Caddy, which gets and renews their
certificate. Both are reached by one name, the relay at `wss://<name>` and
the web app at `https://<name>`. The name's DNS must point at the machine,
with ports 80 and 443 open to Caddy. The images, `ghcr.io/pirc-dev/pirc-relay`
and `ghcr.io/pirc-dev/pirc-web`, are built from each release's own
archives (from the release after 0.3.4 on), for amd64 and arm64, with
provenance (`gh attestation verify oci://ghcr.io/pirc-dev/pirc-relay:X.Y.Z
--owner pirc-dev`).

From `docker/` in a clone of this repository, checked out at the release's
tag:

```sh
cp env.example .env                  # set PIRC_DOMAIN and PIRC_VERSION
docker compose up -d caddy relay
alias pirc-relay='docker compose exec relay pirc-relay'
pirc-relay add-client --url '' --label web    # the token alone, valid 15 minutes
docker compose run --rm web enrol ws://relay:8443 <token>
docker compose up -d web
docker compose logs web                       # wait for "listening"
docker compose exec web pirc-web pair         # a link that adds a passkey
```

Open the link and make a passkey, then add hosts and phones as in
[Hosts and clients](#hosts-and-clients), with the alias above:
`pirc-relay add-host --label <name>` prints the `/pirc enrol` line, and
`pirc-relay add-client --label phone` the app's link.

- **Upgrading**: check out the new release's tag, so that `docker/` is
  that release's, set `PIRC_VERSION` to it in `.env`, and run
  `docker compose up -d`. The relay and the web app go together.
- **Backups**: the relay's registry and the web app's keys and passkeys
  are in the volumes `pirc_relay` and `pirc_web`; back up both (Backup and
  restore, below). Caddy's volumes hold only its certificates, which it
  gets again.
- **Notifications**: the relay wakes PiRC's apps through PiRC's push
  gateway, `push.pirc.dev`, which learns which relay woke which phone, and
  when (`SECURITY.md`). Set `PIRC_RELAY_PUSH_GATEWAY=` (empty) in `.env`
  for none; phones are then not woken.
- **Addresses**: the containers share the network `172.30.88.0/24`, with
  Caddy at `172.30.88.2`, the one proxy the relay and the web app believe
  `X-Forwarded-For` from, so that their limits count each client. If the
  subnet collides with one of the machine's, change it and Caddy's address
  in `compose.yaml`, and the two `TRUSTED_PROXIES` with them. With
  Docker's userland proxy, as by default, clients reaching the machine
  over IPv6 all appear as the network's gateway, and so share one limit.

## Downloading

Each release is on GitHub, at `https://github.com/pirc-dev/pirc/releases`:
the relay for Linux and macOS, on amd64 (x86-64) and arm64, the web app
and the extension, each a `.tar.gz`, and `SHA256SUMS`. Download the ones
you need and `SHA256SUMS` into one directory, check them, and unpack:

```sh
sha256sum -c --ignore-missing SHA256SUMS      # on macOS: shasum -a 256 -c --ignore-missing SHA256SUMS
tar -xzf pirc-relay-X.Y.Z-linux-amd64.tar.gz
cd pirc-relay-X.Y.Z-linux-amd64
```

On macOS, the relay from 0.3.2 on is signed with PiRC's Developer ID and
notarised by Apple. The first time one a browser downloaded is run, macOS
checks with Apple and asks once, in a window, whether to open it, saying
that Apple found no malicious software. Earlier ones are not notarised,
and macOS refuses to run one a browser downloaded until its quarantine
mark is removed: run `xattr -dr com.apple.quarantine
pirc-relay-X.Y.Z-darwin-arm64` on the unpacked directory before starting
it. Either way, `curl -LO` downloads without the mark, so nothing is
asked.

The relay's archive holds the binary, `LICENSE` (the relay is under the
AGPL-3.0), `NOTICE`, the licences of the code built into it
(`third_party/`) and the service files (`service/`). The web app's,
`pirc-web-X.Y.Z.tar.gz`, is the same for any platform and needs Node
(below). The extension is installed with pi from its own repository, or
from its archive (below).

### Building from source

Instead of downloading, build any part from this repository, at a
release tag or any later commit, in a clone made with git (the version
comes from its tags, so GitHub's "Source code" archives do not build).
You need Go and Node 24 with corepack.

```sh
corepack pnpm install --frozen-lockfile
sh/generate.sh
sh/build.sh relay dist/relay
```

This writes the relay for this machine into `dist/relay/`, as the
download has it (set `GOOS` and `GOARCH` for another).
`sh/build.sh web|extension <dir>` builds the others the same way.
`sh/check.sh` runs every test first; it needs pi and tmux for the
end-to-end ones. `sh/release.sh` at a tag builds what a release
downloads, into `dist/pirc-X.Y.Z/`.

## The relay on Linux (systemd)

As root, in the unpacked relay:

```sh
useradd --system --home-dir /var/lib/pirc-relay --shell /usr/sbin/nologin pirc-relay
install -m 755 pirc-relay /usr/local/bin/pirc-relay
install -d -m 755 /etc/pirc-relay
install -m 644 service/env.example /etc/pirc-relay/env
install -m 644 service/pirc-relay.service /etc/systemd/system/
```

Before starting it, edit `/etc/pirc-relay/env` and choose how it does
TLS (the next two sections): by default it wants a certificate, and will
not start without one. Then:

```sh
systemctl daemon-reload
systemctl enable --now pirc-relay
systemctl status pirc-relay
curl https://<name>:<port>/healthz   # prints OK; http:// if plaintext
```

With a private CA, give curl its certificate (`--cacert <ca.pem>`), and
use the name the relay's certificate is for, not its address. Behind a
proxy, check the relay's own listen address: the proxy passes only
`/v1alpha1`.

The relay logs to the journal (`journalctl -u pirc-relay`). Its one
durable file, the registry, is `/var/lib/pirc-relay/registry.json`.

The unit runs the relay as `pirc-relay` with most of the system read-only
to it. To listen on a port below 1024, add `AmbientCapabilities=` and
`CapabilityBoundingSet=` lines for `CAP_NET_BIND_SERVICE` in a drop-in,
or put a proxy in front (below).

### Configuration

`pirc-relay serve` takes its settings as flags or from the environment;
a flag wins over its variable. The unit reads `/etc/pirc-relay/env`:

| Variable | Flag | Default |
|---|---|---|
| `PIRC_RELAY_LISTEN` | `--listen` | `127.0.0.1:8443` |
| `PIRC_RELAY_TLS_CERT` | `--tls-cert` | none |
| `PIRC_RELAY_TLS_KEY` | `--tls-key` | none |
| `PIRC_RELAY_PLAINTEXT` | `--plaintext` | `false` |
| `PIRC_RELAY_MAX_FRAME_BYTES` | `--max-frame-bytes` | 16 MiB |
| `PIRC_RELAY_TRUSTED_PROXIES` | `--trusted-proxies` | none |
| `PIRC_RELAY_PUSH_GATEWAY` | `--push-gateway` | none |
| `PIRC_RELAY_CLOSED_TO_HOSTS` | `--closed-to-hosts` | `false` |
| `PIRC_RELAY_DATA_DIR` | `--data-dir` | `$XDG_STATE_HOME/pirc-relay`; the unit sets `/var/lib/pirc-relay` |

An empty variable counts as unset. `PIRC_RELAY_PLAINTEXT` must be `true`
or `false`; anything else is an error. The relay will not start without
a certificate and key unless plaintext is set.

`PIRC_RELAY_PUSH_GATEWAY` is the push gateway through which the relay
wakes phones registered for notifications (`docs/design.md`, section 12,
step 13). Without one, phones are not woken, which the relay says once as
it starts. The relay must be able to reach it over HTTPS. PiRC's own is
`https://push.pirc.dev`, open to every relay (`docs/gateway.md`), and the
only one that can wake PiRC's apps from the App Store and Google Play:
`service/env.example` and the macOS plist set it, and an older
`/etc/pirc-relay/env` or plist needs it added. A push passes no content,
but the gateway learns which relay's address woke which phone, and when.

Listen on an address your hosts and clients can reach, and no wider than
you need: a private network's address, or loopback behind a proxy, rather
than `0.0.0.0`. If the address belongs to a VPN that comes up after boot,
the unit retries every five seconds until it can listen.

### TLS

Choose one:

- **Certificate files.** Install `service/tls.conf` as
  `/etc/systemd/system/pirc-relay.service.d/tls.conf` (make the directory
  first, `install -d /etc/systemd/system/pirc-relay.service.d`), and set
  its two `LoadCredential=` paths to your certificate (the full chain) and
  key. systemd reads them as root and gives the relay private copies, so
  the key can stay readable by root only. Leave `PIRC_RELAY_PLAINTEXT`
  false. The relay reads the certificate when it starts, so **restart it
  after every renewal**, for example with certbot's
  `--deploy-hook "systemctl restart pirc-relay"`. Hosts and clients reconnect on their
  own within about half a minute.
- **A proxy that terminates TLS**, such as nginx or Caddy, in front of a
  relay listening on loopback with `PIRC_RELAY_PLAINTEXT=true`. The proxy
  must pass WebSocket upgrades on `/v1alpha1`. Hosts and clients ping
  every 25 seconds, within nginx's default 60-second read timeout. With
  nginx:

  ```nginx
  location /v1alpha1 {
      proxy_pass http://127.0.0.1:8443;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  ```

  The relay then sees every peer as the proxy. To have `pending` and the
  log show the peer's own address, list the proxy's address in
  `PIRC_RELAY_TRUSTED_PROXIES` (here `127.0.0.1`; addresses and CIDR
  prefixes, separated by commas). The relay believes `X-Forwarded-For`
  only on connections from a listed address, and takes the rightmost
  entry that is not itself listed; it shows that as
  `<address> via <proxy>`. List only your proxies: a listed address can
  put any address in the header. The relay also counts logins in progress
  by that address, at most 8 from any one, so behind an unlisted proxy all
  peers share the proxy's 8.
- **No TLS**, with `PIRC_RELAY_PLAINTEXT=true`, only on a network that
  already encrypts, such as WireGuard or Tailscale.

**A self-signed or private-CA certificate** must be trusted by everything
that connects. pi and the web app's server run on Node, which reads extra
certificate authorities from `NODE_EXTRA_CA_CERTS`: set it to your CA's
PEM file in the environment pi starts in on every host, and in the web
app's environment file. Keep the CA's file outside `/root` and `/home`,
such as in `/etc`: the web app's unit cannot see those directories. A phone
must trust the certificate in its own settings.

## The relay on macOS (launchd)

As an administrator, in the unpacked relay:

```sh
sudo install -m 755 pirc-relay /usr/local/bin/pirc-relay
sudo install -d -o <user> -m 700 /usr/local/var/pirc-relay
sudo install -d -o <user> -m 755 /usr/local/var/log
```

`<user>` is the account the relay runs as; it owns the data directory.
Copy `service/dev.pirc.relay.plist` to `/Library/LaunchDaemons/`, owned by
root and mode 644, and edit it: `UserName` to that account, and the
settings in `EnvironmentVariables` (the table above; a TLS certificate
and key must be readable by that account). Then:

```sh
sudo launchctl bootstrap system /Library/LaunchDaemons/dev.pirc.relay.plist
sudo launchctl print system/dev.pirc.relay | head
```

As a daemon it runs from boot whether or not anyone is logged in. Its log
is `/usr/local/var/log/pirc-relay.log`. After changing the plist, run
`sudo launchctl bootout system/dev.pirc.relay` and bootstrap it again.

## The extension

The extension is published as a pi package in its own repository,
`https://github.com/pirc-dev/pirc-extension`. Its default branch follows
this repository: it gets a new build whenever a change here changes the
extension. Releases are tags there. pi installs it with `git` and `npm`,
so a host needs both. Install it pinned to a release:

```sh
pi install git:github.com/pirc-dev/pirc-extension@vX.Y.Z
```

It loads into every interactive pi session started from then on; enrol the
host once, as below. To upgrade, install the newer tag the same way:
`pi update` keeps a pinned install where it is. Installed without a tag,
it follows the default branch, and
`pi update git:github.com/pirc-dev/pirc-extension` moves it to the latest
build. Pinned or not, keep the relay at least as new as the extension.
`pi remove git:github.com/pirc-dev/pirc-extension` uninstalls it.

Without git, each release's downloads include the package,
`pirc-extension-X.Y.Z.tar.gz`: `pi install <unpacked directory>` installs
from it directly, and pi loads it from there without copying it, so keep
the directory. To upgrade, unpack the new release's beside it,
`pi install` that, and `pi remove` the old directory.

## Hosts and clients

Each host and client registers once with a one-time token, and is known
from then on by its key. Run the registry commands **as the relay's
user**, with its data directory: files they create are readable by that
user only, so a command run as root would lock the relay out. A command
refuses a data directory that belongs to another user, and says whose it
is. On Linux, with the unit above:

```sh
alias pirc-relay='sudo -u pirc-relay PIRC_RELAY_DATA_DIR=/var/lib/pirc-relay $(grep -s ^PIRC_RELAY_URL= /etc/pirc-relay/env) pirc-relay'
pirc-relay pending                     # hosts that connected without a token
pirc-relay approve <key>               # admits one; --label to rename it
pirc-relay reject <key>
pirc-relay add-host --label laptop     # prints a token, valid 15 minutes; also in the web app
pirc-relay add-client --label phone    # --ttl 1h for longer
pirc-relay add-client --label reviewers --reusable --ttl 720h   # one link for up to 20 apps (--max-uses): reviewers-1, reviewers-2...
pirc-relay list                        # PUSH, READ: a phone registered for notifications, with its read-only key
pirc-relay tokens                      # live tokens, neither used up nor expired: label, one-time or reusable, uses
pirc-relay revoke reviewers            # ends the tokens with that label; the apps they let in stay until removed
pirc-relay remove <key-prefix>         # disconnects it within a second; also in the web app
pirc-relay label <key-prefix> <name>   # renames a host or a client
```

On macOS, with the plist above, the alias is this, and `add-host` and
`add-client` there take `--url`:

```sh
alias pirc-relay='sudo -u <user> PIRC_RELAY_DATA_DIR=/usr/local/var/pirc-relay pirc-relay'
```

`approve`, `reject`, `remove` and `label` take the key, or at least its first 16
characters.

A token is used once, by one device, unless made with `--reusable`
(apps only, and only with a label): then up to `--max-uses` apps (20 by
default) can join with it until it expires, each listed under the label
with a number, so that the apps it let in are told from the rest. Each is
a full client, as any app is: it sees and drives every session, approves
and removes hosts and other apps. Give one only where a single link must
serve several devices, such as a store's reviewers, on a relay meant for
them. If it leaks, `revoke` it first, then `remove` the apps it let in:
removed while it is live, an app could join again with it.

`PIRC_RELAY_CLOSED_TO_HOSTS=true` admits no new hosts but those added with
`add-host` on the relay: a host without a token is refused rather than
asking for approval, and clients cannot make host tokens. Set it on a relay
whose apps are not all yours, such as one for store review, so that no app
can bring a computer of its own onto it.

`add-host` and `add-client` print the token alone. Given the relay's URL
as the new device reaches it, `--url wss://<address>:<port>` (or
`PIRC_RELAY_URL`), they print instead how to join with it: for a host,
the `/pirc enrol` line to run in its pi; for an app, the `pirc://join`
link and its QR code. The line or the link is on stdout, the code and
when the token expires on stderr. Set `PIRC_RELAY_URL` in
`/etc/pirc-relay/env`, where the alias above reads it (`serve` does not
use it), to leave `--url` out.

### A host

With the extension installed (above), in pi: `/pirc enrol <relay-url>`,
then approve the host on the relay. Check that the key `pending` shows is
the one `/pirc status` shows on the host before approving: the label is
whatever the host claims, and anyone who can reach the relay can ask. With
a token from `add-host`, `/pirc enrol <relay-url> <token>` needs no
approval. The URL is `wss://<address>:<port>` (or `ws://` for a plaintext
relay); the path `/v1alpha1` is added if you leave it out. `/pirc status`
shows the connection. The host's key and settings are in `~/.config/pirc/`
(`host.key`, `host.json`).

### The first phone

PiRC's app joins a relay with a code from another client, the web app's
"Add an app" or a phone already joined. For the first one, on the relay:

```sh
pirc-relay add-client --url wss://relay.example.org:8443 --label phone
```

It prints the link, a QR code and when it expires (15 minutes; `--ttl`
for longer). Scan the code with the app, or paste the link into it. The
code is drawn dark on light whatever the terminal's colours; make the
window wide enough that its lines do not wrap.

## The web app

The web app is a server of its own, an ordinary client of the relay with
its own key, which serves the page and signs browsers in with passkeys
(`docs/web.md`). Whoever signs in to it can drive every session, so serve
it on a private network if you can. It needs HTTPS, which passkeys and
notifications require (but for a browser on the same machine, which may
use `http://localhost`), and Node 22 or later at `/usr/local/bin/node`
(Node from nodejs.org, since distributions often ship older; on a minimal
Ubuntu it also needs `apt install libatomic1`; elsewhere, override
`ExecStart` in a drop-in and change the alias below). On Linux,
as root, in the unpacked web app:

```sh
useradd --system --home-dir /var/lib/pirc-web --shell /usr/sbin/nologin pirc-web
install -d -m 755 /usr/local/lib/pirc-web /etc/pirc-web
cp -R pirc-web.mjs page LICENSE NOTICE third-party-licenses.txt /usr/local/lib/pirc-web/
install -m 644 service/env.example /etc/pirc-web/env
install -m 644 service/pirc-web.service /etc/systemd/system/
install -d -o pirc-web -g pirc-web -m 700 /var/lib/pirc-web
```

In `/etc/pirc-web/env`, set its address as browsers see it
(`PIRC_WEB_ORIGIN`), and `PIRC_WEB_LISTEN` to an address on the network
the browsers use (the default, `127.0.0.1:7402`, is for a proxy on the
same machine). Passkeys are tied to the host name, so choose one that can
follow the server if it moves. For TLS, choose one, as for the relay:

- **Certificate files**: install `service/tls.conf` as
  `/etc/systemd/system/pirc-web.service.d/tls.conf` (make the directory
  first) and set its two `LoadCredential=` paths. The web app reads them when it starts, so
  restart it after every renewal.
- **A proxy that terminates TLS**, in front of the web app on loopback,
  with `PIRC_WEB_PLAINTEXT=true`. List the proxy's address in
  `PIRC_WEB_TRUSTED_PROXIES` (here `127.0.0.1`), and have it set
  `X-Forwarded-For`, as Caddy does and nginx does with
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`: the web
  app limits sign-in attempts by address, and without the list every
  browser is the proxy's address, so one script's attempts would lock out
  everyone. It believes the header as the relay does (above).

Then register it with the relay, start it, and add the first passkey:

```sh
alias pirc-web='sudo -u pirc-web PIRC_WEB_DIR=/var/lib/pirc-web $(grep -s ^NODE_EXTRA_CA_CERTS= /etc/pirc-web/env) /usr/local/bin/node /usr/local/lib/pirc-web/pirc-web.mjs'
pirc-relay add-client --url '' --label web   # on the relay's machine: the token alone, valid 15 minutes
pirc-web enrol <relay-url> <token>
systemctl daemon-reload
systemctl enable --now pirc-web
systemctl status pirc-web                    # journalctl -u pirc-web says why if it stopped
pirc-web pair                                # a link that adds a passkey, valid 10 minutes, once
```

Open the link on your phone or laptop and make a passkey there; a passkey
that syncs works on your other devices too. `pirc-web list` and
`pirc-web revoke` manage them. From the web app, "Add an app" invites
PiRC's app, and hosts asking to join can be approved there. Its one
durable directory is `/var/lib/pirc-web`; its relay key there,
`client.key`, is the account's access (Backup, below).

## Upgrading

While the protocol is `v1alpha1`, upgrade the relay, the extension and the
web app together, the relay first: each is tested only with the others
built from the same commit. A peer the relay cannot speak to is
refused with `VERSION_UNSUPPORTED`, and `/pirc status` says so.

To upgrade the relay, download the new release (or build it again),
replace the binary and restart it
(`systemctl restart pirc-relay`, or `sudo launchctl kickstart -k
system/dev.pirc.relay`). Hosts and clients reconnect on their own, and
sessions come back with them. `pirc-relay version` shows what is
installed.

To upgrade the web app, as root in the new unpacked `pirc-web-X.Y.Z`,
replace its files, the page's whole directory included, and restart it:

```sh
rm -rf /usr/local/lib/pirc-web/page
cp -R pirc-web.mjs page LICENSE NOTICE third-party-licenses.txt /usr/local/lib/pirc-web/
systemctl restart pirc-web
```

Browsers keep their passkeys and the server its key and data
(`/var/lib/pirc-web`); `pirc-web version` shows what is installed. The
extension upgrades with pi (above).

## Backup and restore

The relay's only durable state is `registry.json` in its data directory:
the keys it admits and the tokens not yet used. It is written atomically,
so a copy taken at any time is complete. Back up that file only, not the
lock file or temporary files beside it.

To restore, **stop the relay**, put the file back with the same owner and
mode (`0600`, the relay's user), and start it. A running relay notices a
changed registry by its time and size, so a restored copy might go
unnoticed until a restart. A restore brings back every key in the copy,
including any removed since it was taken: remove them again.

The web app's state is its directory, `/var/lib/pirc-web`: its relay key
(`client.key`, a secret) and the passkeys. Stop it to copy or restore it.

With Docker Compose, the two are the volumes `pirc_relay` and `pirc_web`:
stop the relay and the web app (`docker compose stop relay web`), copy
each volume out, for example with `docker run --rm -v pirc_relay:/v -v
"$PWD":/b busybox tar -C /v -czf /b/pirc_relay.tar.gz .`, and start them
again. Restore the same way, into the stopped services' volumes.

Hosts keep their own key in `~/.config/pirc/host.key`. A host that loses
it enrols again with a new token, and its old key should be removed.
