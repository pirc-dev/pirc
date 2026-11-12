#!/bin/bash
# Builds a release into dist/ (docs/design.md, section 12, steps 9 and 15):
# the relay for Linux and macOS on amd64 and arm64, the web app and the
# extension, each an archive, and their checksums. sh/publish-release.sh
# puts them on GitHub for download; sh/publish-extension.sh publishes the
# extension to its own repository.
#
#   sh/release.sh              the release tagged vX.Y.Z at HEAD
#   sh/release.sh --snapshot   a test build of HEAD, versioned X.Y.Z-dev+<commit>
#
# Needs a clean tree, Go, Node with corepack, pi, tmux and openssl: the
# end-to-end tests run against what was built before the checksums are
# written, and a missing tool fails the release rather than skipping it.
#
# A release signs the macOS relays with a Developer ID and has Apple
# notarise them, which needs rcodesign and zip and three files, given by
# path: PIRC_MACOS_SIGN_KEY, the certificate's private key, and
# PIRC_MACOS_SIGN_CERT, the Developer ID Application certificate, both PEM;
# PIRC_NOTARY_KEY, an App Store Connect API key as
# `rcodesign encode-app-store-connect-api-key` writes it. Without them a
# release fails, unless PIRC_MACOS_UNSIGNED=1 says to build one without:
# Go signs the arm64 relay ad hoc and leaves the amd64 one unsigned. Such a
# release is marked MACOS_UNSIGNED, which sh/publish-release.sh refuses. A
# snapshot signs only if they are given.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "release: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

snapshot=false
case "${1:-}" in
  "") ;;
  --snapshot) snapshot=true ;;
  *) die "usage: sh/release.sh [--snapshot]" ;;
esac

for tool in go node corepack pi tmux openssl; do
  command -v "$tool" >/dev/null || die "needs $tool on PATH"
done
[ -z "$(git status --porcelain)" ] || die "the tree has uncommitted changes"

sign_macos=false
if [ -n "${PIRC_MACOS_SIGN_KEY:-}${PIRC_MACOS_SIGN_CERT:-}${PIRC_NOTARY_KEY:-}" ]; then
  sign_macos=true
elif ! $snapshot && [ "${PIRC_MACOS_UNSIGNED:-}" != 1 ]; then
  die "a release signs and notarises the macOS relays: set PIRC_MACOS_SIGN_KEY, PIRC_MACOS_SIGN_CERT and PIRC_NOTARY_KEY, or PIRC_MACOS_UNSIGNED=1 to build without"
fi
if $sign_macos; then
  for var in PIRC_MACOS_SIGN_KEY PIRC_MACOS_SIGN_CERT PIRC_NOTARY_KEY; do
    [ -r "${!var:-}" ] || die "$var must name a readable file"
  done
  for tool in rcodesign zip; do
    command -v "$tool" >/dev/null || die "needs $tool on PATH to sign the macOS relays"
  done
fi

commit=$(git rev-parse --short=12 HEAD)
# The version the build gives: the tag at HEAD, else a -dev one, which only
# a snapshot may be (the tree is clean, so never .dirty).
version=$(sh/build.sh version)
if [[ $version == *-dev+* ]] && ! $snapshot; then
  die "HEAD has no vX.Y.Z tag; tag it, or pass --snapshot for a test build"
fi
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-dev\+[0-9a-f]+)?$ ]] || die "not a release version: $version"

out="dist/pirc-${version}"
rm -rf "$out"
mkdir -p "$out"
echo "PiRC ${version} (${commit}) into ${out}"

step "install"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile --silent
sh/generate.sh

# tar_c DIR NAME ARCHIVE: DIR/NAME as ARCHIVE, owned by root and writable
# by its owner alone, whoever built it and with whatever umask, and without
# macOS's extended attributes and metadata files, which other tars warn
# about.
tar_c() {
  chmod -R u=rwX,go=rX "$1/$2"
  if tar --version | grep -q bsdtar; then
    COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata --uid 0 --gid 0 --uname root --gname root -C "$1" -czf "$3" "$2"
  else
    tar --owner=root:0 --group=root:0 -C "$1" -czf "$3" "$2"
  fi
}

# --- The relay, for each platform ---------------------------------------

relay_platforms=(linux-amd64 linux-arm64 darwin-amd64 darwin-arm64)
host_platform="$(go env GOOS)-$(go env GOARCH)"
host_relay=""
for platform in "${relay_platforms[@]}"; do
  step "relay, $platform"
  name="pirc-relay-${version}-${platform}"
  GOOS=${platform%-*} GOARCH=${platform#*-} sh/build.sh relay "$out/$name"
  if [ "$platform" = "$host_platform" ]; then host_relay="$PWD/$out/$name/pirc-relay"; fi
done

# Signed with the hardened runtime, which notarisation requires, and
# notarised in one submission. A bare program cannot have its ticket stapled,
# so macOS looks the ticket up when it first runs one that was downloaded.
if $sign_macos; then
  step "relay, signing and notarising for macOS"
  notary="$out/notary.zip"
  for platform in "${relay_platforms[@]}"; do
    [[ $platform == darwin-* ]] || continue
    name="pirc-relay-${version}-${platform}"
    rcodesign sign --for-notarization --pem-file "$PIRC_MACOS_SIGN_KEY" --pem-file "$PIRC_MACOS_SIGN_CERT" \
      --code-signature-flags runtime --binary-identifier dev.pirc.relay \
      "$out/$name/pirc-relay"
    (cd "$out" && zip -q "notary.zip" "$name/pirc-relay")
  done
  submission=$(rcodesign notary-submit --api-key-path "$PIRC_NOTARY_KEY" "$notary" 2>&1 | tee /dev/stderr |
    sed -n 's/^created submission ID: \([0-9a-f-]*\)$/\1/p')
  [ -n "$submission" ] || die "notarisation: no submission ID from rcodesign"
  # Apple's first answers for a new certificate took an hour, and one failed
  # poll ends rcodesign's wait, so it waits again, up to two hours in all;
  # the outcome is then read from the submission's log, not assumed.
  # Five failed waits are not a passing fault but a wrong key or ID.
  deadline=$((SECONDS + 7200))
  failures=0
  until rcodesign notary-wait --api-key-path "$PIRC_NOTARY_KEY" \
      --max-wait-seconds $((deadline - SECONDS > 60 ? deadline - SECONDS : 60)) "$submission" 2>&1 |
      grep -v '^poll state'; [ "${PIPESTATUS[0]}" = 0 ]; do
    failures=$((failures + 1))
    [ $SECONDS -lt $deadline ] || die "notarisation: no answer for submission $submission in two hours"
    [ $failures -lt 5 ] || die "notarisation: waiting on submission $submission failed five times"
    sleep 30
  done
  # Read whole: grep -q would stop reading, and rcodesign fails on the closed
  # pipe.
  notary_log=$(rcodesign notary-log --api-key-path "$PIRC_NOTARY_KEY" "$submission")
  grep -q '"status": "Accepted"' <<<"$notary_log" ||
    die "notarisation: submission $submission was not accepted: $notary_log"
  rm "$notary"
else
  echo "macOS relays not signed with a Developer ID"
  $snapshot || echo "the macOS relays are not signed with a Developer ID" > "$out/MACOS_UNSIGNED"
fi

for platform in "${relay_platforms[@]}"; do
  name="pirc-relay-${version}-${platform}"
  tar_c "$out" "$name" "$out/$name.tar.gz"
  echo "$name.tar.gz"
done
# The end-to-end test runs this machine's, which sh/build.sh does not run
# when GOOS and GOARCH are set.
[ -n "$host_relay" ] || die "no relay is built for this machine ($host_platform)"
[ "$("$host_relay" version)" = "$version" ] || die "the relay does not report version $version"

# --- The web app ----------------------------------------------------------

step "web app"
web="$out/pirc-web-${version}"
sh/build.sh web "$web"
tar_c "$out" "pirc-web-${version}" "$web.tar.gz"
echo "pirc-web-${version}.tar.gz"

# --- The extension -----------------------------------------------------
#
# It runs on every host, from the extension's own repository
# (sh/publish-extension.sh); its archive is for installing without git.

step "extension"
ext="$out/pirc-extension-${version}"
sh/build.sh extension "$ext"
tar_c "$out" "pirc-extension-${version}" "$ext.tar.gz"
echo "pirc-extension-${version}.tar.gz"

# --- Checks against what was built ------------------------------------------

step "end to end, against the built relay, extension and web app"
export PIRC_E2E_RELAY_BIN="$host_relay" PIRC_E2E_EXTENSION="$PWD/$ext" PIRC_E2E_VERSION="$version"
node --experimental-transform-types --no-warnings extension/test/e2e.ts
PIRC_E2E_WEB="$PWD/$web/pirc-web.mjs" node --experimental-transform-types --no-warnings web/test/e2e.ts

step "checksums"
# The staged directories stay beside their archives: sh/publish-extension.sh
# publishes the extension's, and it is what was tested.
(cd "$out" && shasum -a 256 -- *.tar.gz > SHA256SUMS && cat SHA256SUMS)
# The commit it was built from, which sh/publish-release.sh checks the tag
# against.
echo "$(git rev-parse HEAD)" > "$out/COMMIT"
echo
echo "release ${version} in ${out}"
