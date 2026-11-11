#!/bin/bash
# Builds one part of PiRC at HEAD into a directory, ready to install
# (docs/design.md, section 12, step 9; docs/self-hosting.md).
#
#   sh/build.sh relay|gateway|web|extension <out-dir>
#   sh/build.sh version      prints the version a build would have
#
# The relay and the gateway are built for this machine (or for GOOS and GOARCH, when set).
# The version is the tag at HEAD (vX.Y.Z gives X.Y.Z), else the last tag's
# version with -dev+<commit>, and .dirty when the tree has changes.
#
# Expects the dependencies installed and the protocol generated (pnpm
# install, sh/generate.sh), as sh/check.sh and sh/release.sh leave them.
# Builds are reproducible: the same commit gives the same files, so a
# deployment can tell which parts changed by comparing them, with the version
# masked.
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "build: $*" >&2; exit 1; }

usage="usage: sh/build.sh relay|gateway|web|extension <out-dir>, or sh/build.sh version"
[ $# -ge 1 ] || die "$usage"
what=$1

commit=$(git rev-parse --short=12 HEAD)
dirty=$([ -z "$(git status --porcelain)" ] || echo .dirty)
if [ -z "$dirty" ] && tag=$(git describe --exact-match --tags --match 'v[0-9]*.[0-9]*.[0-9]*' HEAD 2>/dev/null); then
  version=${tag#v}
else
  last=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || echo v0.0.0)
  version="${last#v}-dev+${commit}${dirty}"
fi

if [ "$what" = version ]; then
  echo "$version"
  exit 0
fi
[ $# -eq 2 ] || die "$usage"
out=$2
rm -rf "$out"
mkdir -p "$out"
out=$(cd "$out" && pwd)

# The third-party code the bundles carry, as NOTICE lists it.
js_dirs=(bufbuild-protobuf ws)

# The MIT licence alone, for a part under it: the root LICENSE without its
# paragraph on which directories it covers, which means nothing outside
# the repository.
mit() {
  sed '/^This licence covers everything in this repository/,/^$/d' LICENSE > "$1"
  [ "$(sed -n 5p "$1")" = "Permission is hereby granted, free of charge, to any person obtaining a copy" ] \
    && ! grep -q 'This licence covers' "$1" || die "the MIT licence was not cut from LICENSE"
}

case "$what" in
  relay)
    # The modules the binary links besides its own, as NOTICE and
    # third_party/ list them; a change there must update both.
    relay_modules="github.com/coder/websocket v1.8.15
google.golang.org/protobuf v1.36.12
rsc.io/qr v0.2.0"
    mkdir -p "$out/third_party" "$out/service"
    # -buildvcs=false and an empty -buildid: Go would otherwise stamp the
    # commit, and a hash of the whole binary (version included), into it, and
    # builds of the same code at two commits would differ beyond the version.
    (cd relay && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=${version}" -o "$out/pirc-relay" ./cmd/pirc-relay)
    linked=$(go version -m "$out/pirc-relay" | awk '$1 == "dep" { print $2, $3 }')
    [ "$linked" = "$relay_modules" ] || die "the relay links modules NOTICE does not list:
$linked"
    # The relay is AGPL-3.0 (relay/cmd/pirc-relay/LICENSE).
    cp relay/cmd/pirc-relay/LICENSE "$out/LICENSE"
    cp NOTICE "$out/"
    for d in go golang.org-x coder-websocket go-protobuf rsc-qr; do cp -R "third_party/$d" "$out/third_party/"; done
    cp relay/service/* "$out/service/"
    if [ -z "${GOOS:-}${GOARCH:-}" ]; then
      [ "$("$out/pirc-relay" version)" = "$version" ] || die "the relay does not report version $version"
    fi
    ;;

  gateway)
    # The push gateway, run by the publisher (docs/gateway.md). It links
    # no module besides its own, only the Go standard library.
    gateway_modules=""
    mkdir -p "$out/third_party" "$out/service"
    (cd relay && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=${version}" -o "$out/pirc-gateway" ./cmd/pirc-gateway)
    linked=$(go version -m "$out/pirc-gateway" | awk '$1 == "dep" { print $2, $3 }')
    [ "$linked" = "$gateway_modules" ] || die "the gateway links modules NOTICE does not list:
$linked"
    mit "$out/LICENSE"
    cp NOTICE "$out/"
    for d in go golang.org-x; do cp -R "third_party/$d" "$out/third_party/"; done
    cp relay/cmd/pirc-gateway/service/* "$out/service/"
    if [ -z "${GOOS:-}${GOARCH:-}" ]; then
      [ "$("$out/pirc-gateway" version)" = "$version" ] || die "the gateway does not report version $version"
    fi
    ;;

  extension)
    # The package pi installs, as published to the extension's own
    # repository: a manifest, the bundle and the entry point that loads it
    # (extension/loader.js), after the one that hands it pi's own modules
    # (extension/pi-parts.js), licences and a README.
    mkdir -p "$out/third_party"
    node --experimental-transform-types --no-warnings sh/bundle.ts extension "$version" "$out/pirc.js"
    cp extension/loader.js "$out/loader.js"
    cp extension/pi-parts.js "$out/pi-parts.js"
    node -e '
      const [version, out] = process.argv.slice(1);
      const src = JSON.parse(require("fs").readFileSync("extension/package.json", "utf8"));
      const pkg = {
        name: "pirc-extension",
        version,
        description: "PiRC: puts every interactive pi session on a PiRC relay",
        license: "MIT",
        homepage: "https://pirc.dev",
        type: "module",
        keywords: ["pi-package"],
        pi: { extensions: ["./pi-parts.js", "./loader.js"] },
        peerDependencies: src.peerDependencies,
      };
      require("fs").writeFileSync(out, JSON.stringify(pkg, null, 2) + "\n");
    ' "$version" "$out/package.json"
    mit "$out/LICENSE"
    cp NOTICE extension/README.md "$out/"
    for d in "${js_dirs[@]}"; do cp -R "third_party/$d" "$out/third_party/"; done
    ;;

  web)
    # AGPL-3.0 (web/LICENSE). The server's bundle, with the built page
    # beside it, where it looks for it; each carries the licences of the
    # third-party code in it (NOTICE).
    mkdir -p "$out/service"
    (cd web/page && ../node_modules/.bin/vite build --logLevel warn --outDir "$out/page" --emptyOutDir)
    node --experimental-transform-types --no-warnings sh/bundle.ts web "$version" "$out/pirc-web.mjs"
    cp web/LICENSE "$out/LICENSE"
    cp NOTICE "$out/"
    cp web/service/* "$out/service/"
    [ -s "$out/page/third-party-licenses.txt" ] && [ -s "$out/third-party-licenses.txt" ] || die "the web app's third-party licences were not written"
    [ "$(node "$out/pirc-web.mjs" version)" = "$version" ] || die "the web app does not report version $version"
    ;;

  *) die "$usage" ;;
esac

echo "built ${what} ${version} into ${out}"
