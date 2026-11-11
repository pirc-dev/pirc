#!/bin/bash
# The iOS notification extension's core: its protocol types generated from
# proto/, then swift test (app/ios/PircNotices). sh/check.sh runs it when
# Swift is on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf app/ios/PircNotices/Sources/PircNotices/gen
node_modules/.bin/buf generate --template buf.gen.swift.yaml
cd app/ios/PircNotices
swift test "$@"
