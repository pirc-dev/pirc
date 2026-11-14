#!/bin/bash
# Reads CHANGELOG.md. Each change adds its line under "## Unreleased", at
# the top; at a release, that heading becomes "## X.Y.Z (date)" in a commit
# before the tag.
#
#   sh/changelog.sh X.Y.Z [file]          prints the release's section,
#                                         without its heading, for its
#                                         GitHub notes (sh/publish-release.sh);
#                                         fails when there is none or it is
#                                         empty (sh/release.sh)
#   sh/changelog.sh --unreleased [file]   prints what is under Unreleased,
#                                         nothing when it is empty, which a
#                                         release requires (sh/release.sh)
#
# file is CHANGELOG.md by default, - for stdin.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { echo "usage: sh/changelog.sh X.Y.Z|--unreleased [file]" >&2; exit 2; }
[ $# -ge 1 ] && [ $# -le 2 ] || usage
case "$1" in
  --unreleased) heading=Unreleased ;;
  # A version, so that a release never takes Unreleased's lines as its own.
  *) [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || usage; heading=$1 ;;
esac
file=${2:-CHANGELOG.md}

# The lines under the heading, up to the next; blank ones at either end
# dropped.
section=$(awk -v v="$heading" '
  /^## / { if (found) exit; split($0, h, " "); if (h[2] == v) { found = 1; next } }
  found { lines[++n] = $0 }
  END {
    first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
    last = n; while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
    for (i = first; i <= last; i++) print lines[i]
  }
' "$file")

if [ "$heading" = Unreleased ]; then
  [ -z "${section//[[:space:]]/}" ] || printf '%s\n' "$section"
  exit 0
fi
if [ -z "${section//[[:space:]]/}" ]; then
  echo "changelog: CHANGELOG.md has no section for ${heading}" >&2
  exit 1
fi
printf '%s\n' "$section"
