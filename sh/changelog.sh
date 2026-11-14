#!/bin/bash
# Prints a release's section of CHANGELOG.md, without its heading, for its
# GitHub notes (sh/publish-release.sh); fails when there is none, or it is
# empty, so that a release is not built or published without its notes
# (sh/release.sh).
#
#   sh/changelog.sh X.Y.Z [file]     file: CHANGELOG.md by default, - for stdin
set -euo pipefail
cd "$(dirname "$0")/.."

[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: sh/changelog.sh X.Y.Z [file]" >&2; exit 2; }
version=$1
file=${2:-CHANGELOG.md}
# The lines under its heading, up to the next; blank ones at either end
# dropped.
section=$(awk -v v="$version" '
  /^## / { if (found) exit; split($0, h, " "); if (h[2] == v) { found = 1; next } }
  found { lines[++n] = $0 }
  END {
    first = 1; while (first <= n && lines[first] ~ /^[[:space:]]*$/) first++
    last = n; while (last >= first && lines[last] ~ /^[[:space:]]*$/) last--
    for (i = first; i <= last; i++) print lines[i]
  }
' "$file")
if [ -z "${section//[[:space:]]/}" ]; then
  echo "changelog: CHANGELOG.md has no section for ${version}" >&2
  exit 1
fi
printf '%s\n' "$section"
