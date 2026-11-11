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
(cd relay && go vet ./... && go test ./...)

step "push gateway: no AGPL package among its dependencies"
# The gateway is MIT; the relay's server and registry are AGPL-3.0.
agpl=$(cd relay && go list -deps -test ./cmd/pirc-gateway ./internal/gateway \
  | grep -E '^pirc\.dev/relay/internal/(server|registry)( |$)' || true)
if [ -n "$agpl" ]; then
  echo "the gateway depends on: $agpl" >&2
  exit 1
fi

step "tsc"
node_modules/.bin/tsc -p .
node_modules/.bin/tsc -p web/page

step "web app: build the page"
(cd web/page && ../node_modules/.bin/vite build --logLevel warn)

step "round trip: TypeScript encodes, Go decodes"
node --experimental-transform-types --no-warnings sh/roundtrip.ts encode \
  | (cd relay && go run ./cmd/framedump) \
  | node --experimental-transform-types --no-warnings sh/roundtrip.ts compare

step "relay client, extension and web app: unit tests"
node --experimental-transform-types --no-warnings --test relay-client/test/*.test.ts extension/test/*.test.ts web/test/*.test.ts

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
else
  echo "skipped: needs pi and tmux on PATH"
fi
