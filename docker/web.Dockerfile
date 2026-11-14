# The web app's image (docs/self-hosting.md, "With Docker Compose"), made
# by .github/workflows/images.yml from a release's own archive, checked
# against the release's SHA256SUMS first: the bundle and the page in the
# image are the download's, byte for byte.
#
#   docker build -f docker/web.Dockerfile --build-arg VERSION=X.Y.Z <dir>
#
# <dir> holds pirc-web-X.Y.Z.tar.gz.
FROM busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec AS unpack
ARG VERSION
ADD pirc-web-${VERSION}.tar.gz /unpack/
RUN set -eu; \
    mkdir -p /out/usr/local/lib /out/usr/local/bin /out/data; \
    mv /unpack/pirc-web-${VERSION} /out/usr/local/lib/pirc-web; \
    rm -r /out/usr/local/lib/pirc-web/service; \
    printf '#!/bin/sh\nexec node /usr/local/lib/pirc-web/pirc-web.mjs "$@"\n' > /out/usr/local/bin/pirc-web; \
    chmod 755 /out/usr/local/bin/pirc-web; \
    chmod 700 /out/data

FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
COPY --from=unpack /out/usr /usr
# Its passkeys, sessions and relay key, in a volume.
COPY --from=unpack --chown=node:node /out/data /data
ENV PIRC_WEB_DIR=/data \
    PIRC_WEB_LISTEN=0.0.0.0:7402
USER node
EXPOSE 7402
ENTRYPOINT ["pirc-web"]
CMD ["serve"]
