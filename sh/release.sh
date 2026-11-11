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

# Archives without macOS's extended attributes and metadata files, which
# other tars warn about.
tar_c() {
  if tar --version | grep -q bsdtar; then
    COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata "$@"
  else
    tar "$@"
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
  tar_c -C "$out" -czf "$out/$name.tar.gz" "$name"
  echo "$name.tar.gz"
  if [ "$platform" = "$host_platform" ]; then host_relay="$PWD/$out/$name/pirc-relay"; fi
done
# The end-to-end test runs this machine's, which sh/build.sh does not run
# when GOOS and GOARCH are set.
[ -n "$host_relay" ] || die "no relay is built for this machine ($host_platform)"
[ "$("$host_relay" version)" = "$version" ] || die "the relay does not report version $version"

# --- The web app ----------------------------------------------------------

step "web app"
web="$out/pirc-web-${version}"
sh/build.sh web "$web"
tar_c -C "$out" -czf "$web.tar.gz" "pirc-web-${version}"
echo "pirc-web-${version}.tar.gz"

# --- The extension -----------------------------------------------------
#
# It runs on every host, from the extension's own repository
# (sh/publish-extension.sh); its archive is for installing without git.

step "extension"
ext="$out/pirc-extension-${version}"
sh/build.sh extension "$ext"
tar_c -C "$out" -czf "$ext.tar.gz" "pirc-extension-${version}"
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
