#!/bin/bash
# Every check, in order; run this before pushing. GitHub runs it too
# (.github/workflows/check.yml).
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; }

step "install"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --silent

step "buf format"
node_modules/.bin/buf format --diff --exit-code

step "buf lint"
node_modules/.bin/buf lint

step "buf breaking (against origin/master)"
if git rev-parse --verify --quiet origin/master:proto >/dev/null; then
  node_modules/.bin/buf breaking --against '.git#branch=origin/master,subdir=proto'
else
  echo "skipped: origin/master has no proto/ yet"
fi

step "generate"
sh/generate.sh

step "go vet, test"
# The hosted mode is built only with its tag until it ships (docs/design.md,
# step 14), so both builds are vetted and the tagged one is tested too.
(cd relay && go vet ./... && go vet -tags hosted ./... && go test ./... && go test -tags hosted ./cmd/pirc-relay)

step "push gateway: no AGPL package among its dependencies"
# The gateway is MIT; the relay's server, registry and hosted mode are AGPL-3.0.
agpl=$(cd relay && go list -deps -test ./cmd/pirc-gateway ./internal/gateway \
  | grep -E '^pirc\.dev/relay/internal/(server|registry|hosted)( |$)' || true)
if [ -n "$agpl" ]; then
  echo "the gateway depends on: $agpl" >&2
  exit 1
fi

step "release builds: the relay, the gateway and the extension carry only what NOTICE lists"
built=$(mktemp -d)
sh/build.sh relay "$built/relay" >/dev/null
sh/build.sh gateway "$built/gateway" >/dev/null
sh/build.sh extension "$built/extension" >/dev/null
rm -rf "$built"

step "tsc"
node_modules/.bin/tsc -p .
node_modules/.bin/tsc -p web/page

step "web app: build the page"
(cd web/page && ../node_modules/.bin/vite build --logLevel warn)

step "round trip: TypeScript encodes, Go decodes"
node --experimental-transform-types --no-warnings sh/roundtrip.ts encode \
  | (cd relay && go run ./cmd/framedump) \
  | node --experimental-transform-types --no-warnings sh/roundtrip.ts compare

step "cases/e2e: regenerating them changes no file"
node --experimental-transform-types --no-warnings e2e/test/gen.ts --check

step "e2e, relay client, extension and web app: unit tests"
# e2e's include Noise against cases/noise/ and cases/e2e/channel.json, and
# the same files with every static key in Node's WebCrypto
# (e2e/test/noise-webcrypto.test.ts).
node --experimental-transform-types --no-warnings --test e2e/test/*.test.ts relay-client/test/*.test.ts extension/test/*.test.ts web/test/*.test.ts

step "mobile app: generate, analyze, test"
if command -v flutter >/dev/null; then
  sh/app.sh
else
  echo "skipped: needs flutter on PATH"
fi

step "notification extension: generate, swift test"
# It uses CryptoKit, which only Apple's platforms have.
if [ "$(uname)" = Darwin ] && command -v swift >/dev/null; then
  sh/notices.sh
else
  echo "skipped: needs swift on macOS"
fi

step "end to end: relay, pi with the extension, a client; the web app"
if command -v pi >/dev/null && command -v tmux >/dev/null; then
  echo "pi $(pi --version)"
  node --experimental-transform-types --no-warnings extension/test/e2e.ts
  node --experimental-transform-types --no-warnings web/test/e2e.ts
  # What a release before the hosted relay does with host.json's
  # pirc-e2e: value, and answers kept across a /reload from it and back.
  node --experimental-transform-types --no-warnings extension/test/old-code.ts
else
  echo "skipped: needs pi and tmux on PATH"
fi
