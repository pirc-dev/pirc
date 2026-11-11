# The push gateway

`pirc-gateway` wakes phones for relays. A phone in the background is
reached only through Apple's or Google's push service, which takes pushes
only with the app publisher's credentials, and a self-hosted relay cannot
hold those. So the publisher runs the gateway, which holds them, and any
relay may ask it to wake a phone. The push carries nothing: the phone
connects to its relay and writes the notification itself (`design.md`,
section 12, step 13).

It is run by the publisher, not by self-hosters, at
`https://push.pirc.dev`. `sh/build.sh gateway <dir>` builds it, with its
systemd unit.

## What it does

- **`POST /v1/register`**, from the app: the app sends its push token and
  gets back a handle, which it gives to its relay (`RegisterPush`). The
  body is
  `{"platform": "apns"|"fcm", "token": …, "environment": "development"|"production", "app": "dev.pirc.app", "version": "x.y.z"}`.
  `environment` says whether the token is for Apple's test servers (a
  development build) or its real ones, and is refused for `fcm`. `app` must
  be one the gateway serves (`--apps`). `version` is only counted. The
  answer is `200 {"handle": …}`, `400 {"error": …}` for anything malformed,
  `429` with `Retry-After`, or `503` with `Retry-After` when the gateway has
  no credentials for that platform, or for that APNs environment, yet.
- **`POST /v1/wake`**, from a relay, with `{"handle": …}`. The answer is
  `200` when the push service took the push, `410` when the handle or its
  token is no longer valid, `429` with `Retry-After`, `502` when the push
  service refused for another reason, or `503` with `Retry-After` when the
  gateway has no credentials for the handle's platform or APNs
  environment. On `404` or `410`
  the relay drops the registration, and the app registers again when it is
  next opened; on anything else it keeps it.
- **`GET /healthz`** answers `OK`.

No call needs authentication: the push carries nothing worth taking, and
the gateway is open to every relay, as ntfy's, Matrix's and Nextcloud's
are.

### The handle

A handle is the push target (platform, environment, app and token)
encrypted and authenticated with the gateway's key: AES-256-GCM under a
random nonce, base64url, with a version byte in front. Each call gives a
different handle for the same token. The gateway stores nothing: it opens
the handle a relay sends.

**Changing the key invalidates every handle.** The gateway then answers
`410` for every wake, relays drop the registrations, and each app
registers again when it is next opened; until then its phone is not woken.
There is one key, with no rotation in which an old key still opens
handles. That is enough for now.

### The pushes

- **APNs**: `apns-push-type: alert`, `apns-priority: 10`, the app as
  `apns-topic`, expiring after 24 hours, with the body
  `{"aps": {"alert": {"title": "PiRC", "body": "A session needs you"}, "mutable-content": 1, "sound": "default"}}`.
  The app's notification extension replaces the text. There is no
  category, thread or collapse ID.
- **FCM**: a data-only message, `{"wake": "1"}`, high priority, kept for
  24 hours. There is no notification block and no collapse key.

### When a token is gone

`410` means the handle or its token is no longer valid, and only then,
because a relay drops a registration on it. It answers a handle this
gateway's key did not make, one for an app no longer in `--apps`, and:

- **From Apple:** `410 Unregistered`, or `400 BadDeviceToken`. Any other
  `400` (a bad topic, say) is a fault of the gateway's, and is answered
  `502`.
- **From Google:** `UNREGISTERED`, or `INVALID_ARGUMENT` whose field
  violation names `message.token`. Google also answers `INVALID_ARGUMENT` for
  a malformed message. If that were taken as the token's fault, a bug in the
  gateway's payload would make every relay drop every Android phone.

A gateway without a platform's credentials answers `503` for it, not
`410`: started without them, or before they exist, or with a key file gone
after a restart, it would otherwise make every relay drop every phone of
that platform.

### Limits

Kept in memory, in one-minute windows:

- **Registrations:** 10 a minute from one address.
- **Wakes:** 6 a minute for one token, through whichever handle.

Wakes are not limited by address, because a relay sends every phone's wakes
from one address. The relay itself sends at most one wake per phone every
10 seconds, with one more at the end of that window.

### What it keeps and learns

The gateway keeps the counters, logged hourly: registrations by platform and
app version, and wakes by outcome. It learns which relay's address woke
which push token, and when. It logs a push service's refusals without the
token.

## Running it

```sh
pirc-gateway genkey > /etc/pirc-gateway/key      # base64; keep it secret
pirc-gateway serve \
  --key-file /etc/pirc-gateway/key \
  --apns-key-file /etc/pirc-gateway/AuthKey.p8 --apns-key-id KEYID --apns-team-id TEAMID \
  --apns-sandbox-key-file /etc/pirc-gateway/AuthKey-sandbox.p8 --apns-sandbox-key-id KEYID2 \
  --fcm-credentials-file /etc/pirc-gateway/firebase.json
```

| Variable | Flag | Default |
|---|---|---|
| `PIRC_GATEWAY_LISTEN` | `--listen` | `127.0.0.1:8444` |
| `PIRC_GATEWAY_KEY_FILE` | `--key-file` | required |
| `PIRC_GATEWAY_APPS` | `--apps` | `dev.pirc.app` |
| `PIRC_GATEWAY_APNS_KEY_FILE` | `--apns-key-file` | none: no APNs for production builds |
| `PIRC_GATEWAY_APNS_KEY_ID` | `--apns-key-id` | |
| `PIRC_GATEWAY_APNS_TEAM_ID` | `--apns-team-id` | |
| `PIRC_GATEWAY_APNS_SANDBOX_KEY_FILE` | `--apns-sandbox-key-file` | none: no APNs for development builds |
| `PIRC_GATEWAY_APNS_SANDBOX_KEY_ID` | `--apns-sandbox-key-id` | |
| `PIRC_GATEWAY_FCM_CREDENTIALS_FILE` | `--fcm-credentials-file` | none: no FCM |
| `PIRC_GATEWAY_TRUSTED_PROXIES` | `--trusted-proxies` | none |

It starts with no push service, logging a warning, and answers `503` for
each one until given its credentials. It serves plain HTTP, behind a proxy
that terminates TLS: give that proxy's address in `--trusted-proxies` so
that the limits count the real client's address.

The credentials come from the publisher's accounts, never from the
repository:

- **APNs:** token-based keys (`.p8`) made in the Apple developer account,
  with their key IDs and the team ID: one for Apple's production servers
  (`--apns-key-file`), which App Store and TestFlight builds' tokens use,
  and one for its sandbox (`--apns-sandbox-key-file`), which development
  builds' tokens use. A key limited to the app's topic, so that a leaked one
  can push to nothing else, serves only one environment. A key that serves
  both may be given as each. The gateway signs a provider token with each
  and renews it every 50 minutes.
- **FCM:** the JSON key of a service account of the app's Firebase project,
  with permission to send messages. The gateway exchanges it for an access
  token.

Under systemd, `service/` in the build has the unit, which reads the key
from `/etc/pirc-gateway/key`; the drop-ins `apns.conf`, `apns-sandbox.conf`
and `fcm.conf` add each push service's credentials, and `env.example` the settings.

A relay is pointed at the gateway with `--push-gateway`
(`docs/self-hosting.md`).

## Testing

`go test ./internal/gateway/` (in `relay/`, and in `sh/check.sh`) runs the
gateway against stubs of Apple's and Google's endpoints. It checks:

- the requests the gateway makes, its signed tokens, and the payloads;
- which refusals count as a token gone;
- the handles and the limits.

The publisher's gateway, `push.pirc.dev`, has woken apps for real through
both Apple's and Google's servers; `app/README.md` says how to watch it
with a simulator or an emulator.
