#!/bin/bash
# Generate the protocol's Go and TypeScript code from proto/ (git ignores
# the output: relay/internal/pb/, protocol/gen/).
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf relay/internal/pb protocol/gen
node_modules/.bin/buf generate
