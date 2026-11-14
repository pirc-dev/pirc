# The relay's image (docs/self-hosting.md, "With Docker Compose"), made by
# .github/workflows/images.yml from a release's own archive for the
# platform, checked against the release's SHA256SUMS first: the binary in
# the image is the download's, byte for byte.
#
#   docker build -f docker/relay.Dockerfile --build-arg VERSION=X.Y.Z <dir>
#
# <dir> holds pirc-relay-X.Y.Z-linux-<arch>.tar.gz for each platform built.
FROM busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec AS unpack
ARG VERSION
ARG TARGETARCH
ADD pirc-relay-${VERSION}-linux-${TARGETARCH}.tar.gz /unpack/
RUN set -eu; \
    from=/unpack/pirc-relay-${VERSION}-linux-${TARGETARCH}; \
    mkdir -p /out/usr/local/bin /out/usr/share/doc/pirc-relay /out/data; \
    mv "$from/pirc-relay" /out/usr/local/bin/; \
    mv "$from/LICENSE" "$from/NOTICE" "$from/third_party" /out/usr/share/doc/pirc-relay/; \
    chmod 700 /out/data

# Static, so nothing but the binary: no shell, run as nonroot (65532).
FROM gcr.io/distroless/static-debian13:nonroot@sha256:aafe993665bf6200db38a02c11a9351e782a84b6a45e7f33b6695638c88e3931
COPY --from=unpack /out/usr /usr
# The registry, in a volume; the relay refuses a directory owned by
# another user.
COPY --from=unpack --chown=65532:65532 /out/data /data
ENV PIRC_RELAY_DATA_DIR=/data \
    PIRC_RELAY_LISTEN=:8443
EXPOSE 8443
ENTRYPOINT ["pirc-relay"]
CMD ["serve"]
