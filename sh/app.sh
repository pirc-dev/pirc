#!/bin/bash
# The mobile app's checks: its protocol types generated from proto/, then
# flutter analyze and flutter test (app/README.md). sh/check.sh runs it
# when Flutter is on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf app/lib/gen
node_modules/.bin/buf generate --template buf.gen.dart.yaml
cd app
flutter pub get --enforce-lockfile >/dev/null
flutter analyze
flutter test
