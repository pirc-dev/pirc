#!/bin/bash
# Publishes the extension package to the extension's own public repository,
# from which pi installs it (docs/self-hosting.md).
#
#   sh/publish-extension.sh <release-dir> <checkout>
#   sh/publish-extension.sh --build <package-dir> <checkout>
#
# A release: <release-dir> is what sh/release.sh wrote (dist/pirc-X.Y.Z),
# and the commit is tagged vX.Y.Z. Snapshot builds are refused.
#
# A build: <package-dir> is what `sh/build.sh extension` wrote, from any
# commit; it is committed on the default branch, untagged, which is what an
# install without a tag follows. Nothing is committed when the package is
# the same as what is there.
#
# <checkout> is a clone of the extension's repository, clean and on its
# default branch. Its contents are replaced by the package, committed and
# pushed.
set -euo pipefail

die() { echo "publish-extension: $*" >&2; exit 1; }

tag=true
if [ "${1:-}" = --build ]; then
  tag=false
  shift
fi
[ $# -eq 2 ] || die "usage: sh/publish-extension.sh <release-dir> <checkout>, or --build <package-dir> <checkout>"

if $tag; then
  release=$1 checkout=$2
  version=$(basename "$release")
  version=${version#pirc-}
  [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a release (snapshots are not published): $release"
  pkg="$release/pirc-extension-${version}"
  [ -f "$pkg/package.json" ] || die "no extension package in $release"
  (cd "$release" && shasum -a 256 -c --quiet SHA256SUMS) || die "$release does not match its SHA256SUMS"
  tar -xzOf "$pkg.tar.gz" "pirc-extension-${version}/pirc.js" | cmp -s - "$pkg/pirc.js" || die "$pkg differs from its archive"
else
  pkg=$1 checkout=$2
  [ -f "$pkg/package.json" ] || die "no extension package in $pkg"
  version=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$pkg/package.json")
fi

git -C "$checkout" rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout: $checkout"
[ -z "$(git -C "$checkout" status --porcelain)" ] || die "$checkout has uncommitted changes"
if $tag && git -C "$checkout" rev-parse --verify --quiet "refs/tags/v${version}" >/dev/null; then
  die "$checkout already has v${version}"
fi
# A new repository has nothing to pull.
if git -C "$checkout" rev-parse --verify --quiet HEAD >/dev/null; then
  git -C "$checkout" pull --ff-only --quiet
fi

# Everything but .git is the package's.
find "$checkout" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$pkg/." "$checkout/"
git -C "$checkout" add -A
if ! $tag && git -C "$checkout" diff --cached --quiet; then
  echo "pirc-extension ${version}: the same as what is published, nothing to do"
  exit 0
fi
git -C "$checkout" commit --quiet -m "pirc-extension ${version}"
if $tag; then
  git -C "$checkout" tag -a "v${version}" -m "pirc-extension ${version}"
fi
git -C "$checkout" push --quiet --follow-tags origin HEAD
echo "published pirc-extension ${version}: $(git -C "$checkout" rev-parse --short HEAD)$($tag && echo ", tag v${version}")"
