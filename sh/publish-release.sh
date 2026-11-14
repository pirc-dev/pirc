#!/bin/bash
# Publishes a release on GitHub, for download (docs/self-hosting.md): the
# archives and SHA256SUMS that sh/release.sh wrote, attached to a GitHub
# release of the tag vX.Y.Z, which must already be pushed there.
#
#   sh/publish-release.sh <release-dir>
#
# <release-dir> is dist/pirc-X.Y.Z; snapshots are refused. Needs gh, signed
# in with write access to the repository (GH_TOKEN, or gh auth login).
set -euo pipefail

die() { echo "publish-release: $*" >&2; exit 1; }

repository=pirc-dev/pirc

[ $# -eq 1 ] || die "usage: sh/publish-release.sh <release-dir>"
[ -d "$1" ] || die "no directory $1"
release=$(cd "$1" && pwd)
cd "$(dirname "$0")/.."
version=$(basename "$release")
version=${version#pirc-}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a release (snapshots are not published): $release"
command -v gh >/dev/null || die "needs gh on PATH"
[ ! -e "$release/MACOS_UNSIGNED" ] || die "$release has macOS relays not signed with a Developer ID (PIRC_MACOS_UNSIGNED)"
(cd "$release" && shasum -a 256 -c --quiet SHA256SUMS) || die "$release does not match its SHA256SUMS"

# Exactly the files the checksums name, and every one of them.
files=("$release/SHA256SUMS")
while read -r _ name; do files+=("$release/$name"); done < "$release/SHA256SUMS"
expected=$(printf '%s\n' "pirc-relay-${version}-"{linux-amd64,linux-arm64,darwin-amd64,darwin-arm64}.tar.gz \
  "pirc-web-${version}.tar.gz" "pirc-extension-${version}.tar.gz" | sort)
[ "$(awk '{ print $2 }' "$release/SHA256SUMS" | sort)" = "$expected" ] || die "$release/SHA256SUMS does not list the release's archives"

# The tag, here and on GitHub, is the commit the release was built from.
commit=$(git rev-parse "v${version}^{commit}") || die "no tag v${version} here"
[ "$(cat "$release/COMMIT")" = "$commit" ] || die "$release was not built from v${version} ($commit)"
remote=$(gh api "repos/${repository}/commits/v${version}" --jq .sha) || die "no tag v${version} on GitHub"
[ "$remote" = "$commit" ] || die "v${version} on GitHub is ${remote}, here ${commit}"

# What it changes, as CHANGELOG.md says at the tag, above how to install.
changes=$(git show "v${version}:CHANGELOG.md" | sh/changelog.sh "$version" -) || die "CHANGELOG.md at v${version} has no section for it"
notes="${changes}

PiRC ${version}: the relay for Linux and macOS, the web app and the pi extension.
Installing them: https://pirc.dev/self-hosting/. Check a download against SHA256SUMS with \`sha256sum -c --ignore-missing SHA256SUMS\` (on macOS, \`shasum -a 256 -c --ignore-missing SHA256SUMS\`)."
gh release create "v${version}" --repo "$repository" --verify-tag --title "PiRC ${version}" --notes "$notes" "${files[@]}"
