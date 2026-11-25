#!/bin/sh
# Runner's first build phase. It also stops a hosted build without the
# notification extension's hosted path, and the other way round. The store build, the one with the paywall,
# is asked for with --dart-define=PIRC_STORE=true (lib/app/store.dart); a
# build from source has none. An archive, which is what goes to the App
# Store, says which it is, true or false, so that a store release that
# forgets it stops rather than go out without the paywall. Flutter gives
# the defines in DART_DEFINES (Generated.xcconfig), base64,
# comma-separated.
store=
found=
hosted=
for d in $(echo "${DART_DEFINES:-}" | tr ',' ' '); do
  kv=$(echo "$d" | base64 -D)
  case "$kv" in
    PIRC_STORE=*) store=${kv#PIRC_STORE=}; found=1 ;;
    PIRC_HOSTED=*) hosted=${kv#PIRC_HOSTED=} ;;
  esac
done
# A build with the hosted relay compiles the notification extension's
# hosted path (Flutter/Hosted.xcconfig, app/README.md), and only it does,
# since both targets take the same xcconfig.
case " ${OTHER_SWIFT_FLAGS:-} " in
  *" -DPIRC_HOSTED "*) flag=true ;;
  *) flag=false ;;
esac
if [ "$hosted" = true ] && [ "$flag" != true ]; then
  echo "error: PIRC_HOSTED is true, but ios/Flutter/Hosted.xcconfig does not set -DPIRC_HOSTED: its notification extension would have no hosted path (app/README.md)."
  exit 1
fi
if [ "$hosted" != true ] && [ "$flag" = true ]; then
  echo "error: ios/Flutter/Hosted.xcconfig sets -DPIRC_HOSTED, but this build is not hosted (PIRC_HOSTED is not true): remove the file."
  exit 1
fi
if [ -n "$found" ] && [ "$store" != true ] && [ "$store" != false ]; then
  echo "error: PIRC_STORE is true, a store build, or false, a build from source, not \"$store\"."
  exit 1
fi
if [ -z "$found" ] && [ "$ACTION" = install ]; then
  echo "error: An archive is for the App Store: say whether it is the store build, with --dart-define=PIRC_STORE=true (with the paywall) or false (without)."
  exit 1
fi
