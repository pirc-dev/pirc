#!/bin/sh
# The last build phase of Runner and of Notifications: what the built
# Info.plist tells App Store Connect about encryption. A build with the
# hosted relay (-DPIRC_HOSTED in OTHER_SWIFT_FLAGS, from
# Flutter/Hosted.xcconfig, app/README.md) uses standard encryption beyond
# the system's (libsodium, Noise). Once Apple has accepted the encryption
# documentation, Hosted.xcconfig gives its code as PIRC_ENCRYPTION_CODE and
# the build says ITSAppUsesNonExemptEncryption true with that code; until
# then neither key is there, since App Store Connect refuses true without the
# code of a declaration it has, and the questions are answered for the build
# in App Store Connect. Any other build says false, as the source Info.plist
# does. Set in the built file, before signing, never in the source.
set -eu
plist="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"
pb=/usr/libexec/PlistBuddy
case " ${OTHER_SWIFT_FLAGS:-} " in
  *" -DPIRC_HOSTED "*) hosted=true ;;
  *) hosted=false ;;
esac
if "$pb" -c "Print :ITSAppEncryptionExportComplianceCode" "$plist" >/dev/null 2>&1; then
  "$pb" -c "Delete :ITSAppEncryptionExportComplianceCode" "$plist"
fi
if [ "$hosted" != true ]; then
  "$pb" -c "Set :ITSAppUsesNonExemptEncryption false" "$plist"
  echo "encryption: ITSAppUsesNonExemptEncryption false"
elif [ -n "${PIRC_ENCRYPTION_CODE:-}" ]; then
  "$pb" -c "Set :ITSAppUsesNonExemptEncryption true" "$plist"
  "$pb" -c "Add :ITSAppEncryptionExportComplianceCode string ${PIRC_ENCRYPTION_CODE}" "$plist"
  echo "encryption: ITSAppUsesNonExemptEncryption true, with its code"
else
  "$pb" -c "Delete :ITSAppUsesNonExemptEncryption" "$plist"
  echo "encryption: neither key, until Apple gives the code; answer the questions for this build in App Store Connect"
fi
