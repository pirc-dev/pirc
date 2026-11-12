#!/bin/sh
# Runner's first build phase. The store build, the one with the paywall,
# is asked for with --dart-define=PIRC_STORE=true (lib/app/store.dart); a
# build from source has none. An archive, which is what goes to the App
# Store, says which it is, true or false, so that a store release that
# forgets it stops rather than go out without the paywall. Flutter gives
# the defines in DART_DEFINES (Generated.xcconfig), base64,
# comma-separated.
store=
found=
for d in $(echo "${DART_DEFINES:-}" | tr ',' ' '); do
  kv=$(echo "$d" | base64 -D)
  case "$kv" in
    PIRC_STORE=*) store=${kv#PIRC_STORE=}; found=1 ;;
  esac
done
if [ -n "$found" ] && [ "$store" != true ] && [ "$store" != false ]; then
  echo "error: PIRC_STORE is true, a store build, or false, a build from source, not \"$store\"."
  exit 1
fi
if [ -z "$found" ] && [ "$ACTION" = install ]; then
  echo "error: An archive is for the App Store: say whether it is the store build, with --dart-define=PIRC_STORE=true (with the paywall) or false (without)."
  exit 1
fi
