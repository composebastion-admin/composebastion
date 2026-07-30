ARG TRIVY_VERSION=0.72.0
ARG TRIVY_SOURCE_COMMIT=8a32853686209a428179bb3a1688802b25691564
ARG TRIVY_SOURCE_SHA256=5a922c388846d11345ce8283e4373be312458f002abc667c3cd1f77c43163725
ARG TRIVY_ORAS_VERSION=v2.6.2
ARG RCLONE_VERSION=1.74.4
ARG RCLONE_SOURCE_COMMIT=5bc93a2a7ab0ebd0a11352bc4968eabeffb18027
ARG RCLONE_SOURCE_SHA256=1d604c49673ddbb8829563c6768d3d69cd0a8ddc4a0beec3b42a9dae3ea34a63
ARG RCLONE_LICENSE_SHA256=8cd2e9e750b90a04b7d82dbbca3930c696ae0309d7c10464f90a44f45754cd04
ARG GO_GRPC_VERSION=1.82.1
ARG GO_TEXT_VERSION=0.39.0
ARG APP_VERSION=source

FROM node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY scripts/bootstrap-npm.mjs scripts/bootstrap-npm.mjs
RUN node scripts/bootstrap-npm.mjs
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --engine-strict --strict-allow-scripts --dangerously-allow-all-scripts=false --ignore-scripts=false

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS trivy-builder
ENV GOTOOLCHAIN=local
ARG TARGETOS
ARG TARGETARCH
ARG TRIVY_VERSION
ARG TRIVY_SOURCE_COMMIT
ARG TRIVY_SOURCE_SHA256
ARG TRIVY_ORAS_VERSION
ARG GO_GRPC_VERSION
ARG GO_TEXT_VERSION
RUN set -eux; \
    apk add --no-cache ca-certificates curl; \
    curl -fsSLo /tmp/trivy-source.tar.gz "https://github.com/aquasecurity/trivy/archive/${TRIVY_SOURCE_COMMIT}.tar.gz"; \
    echo "${TRIVY_SOURCE_SHA256}  /tmp/trivy-source.tar.gz" | sha256sum -c -; \
    mkdir -p /src /out/licenses; \
    tar -xzf /tmp/trivy-source.tar.gz -C /src --strip-components=1; \
    cd /src; \
    go get "oras.land/oras-go/v2@${TRIVY_ORAS_VERSION}"; \
    go get "google.golang.org/grpc@v${GO_GRPC_VERSION}"; \
    go get "golang.org/x/text@v${GO_TEXT_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' oras.land/oras-go/v2)" = "${TRIVY_ORAS_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' google.golang.org/grpc)" = "v${GO_GRPC_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' golang.org/x/text)" = "v${GO_TEXT_VERSION}"; \
    go test oras.land/oras-go/v2/content/file -run '^Test_extractTarDirectory_HardLink$'; \
    CGO_ENABLED=0 GOEXPERIMENT=jsonv2 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
      go build -mod=readonly -buildvcs=false -trimpath \
        -ldflags="-s -w -extldflags '-static' -X github.com/aquasecurity/trivy/pkg/version/app.ver=${TRIVY_VERSION}" \
        -o /out/trivy ./cmd/trivy; \
    go version -m /out/trivy | grep -F "oras.land/oras-go/v2" | grep -F "${TRIVY_ORAS_VERSION}"; \
    install -m 0644 /src/LICENSE /out/licenses/trivy-LICENSE.txt; \
    install -m 0644 /src/NOTICE /out/licenses/trivy-NOTICE.txt; \
    install -m 0644 "$(go env GOPATH)/pkg/mod/oras.land/oras-go/v2@${TRIVY_ORAS_VERSION}/LICENSE" /out/licenses/oras-go-LICENSE.txt; \
    install -m 0644 /usr/local/go/LICENSE /out/licenses/go-LICENSE.txt; \
    install -m 0644 /usr/local/go/PATENTS /out/licenses/go-PATENTS.txt; \
    mkdir -p /out/licenses/go-buildinfo; \
    go version -m /out/trivy \
      | awk -F '\t' '$2 == "mod" || $2 == "dep" || $2 == "=>" { print $2 "\t" $3 "\t" $4 "\t" $5 }' \
      | LC_ALL=C sort -u > /out/licenses/go-buildinfo/trivy.modules.tsv; \
    sed -i "s#(devel)#v${TRIVY_VERSION}#" /out/licenses/go-buildinfo/trivy.modules.tsv; \
    test -s /out/licenses/go-buildinfo/trivy.modules.tsv; \
    cd /out/licenses; \
    sha256sum trivy-LICENSE.txt trivy-NOTICE.txt oras-go-LICENSE.txt go-LICENSE.txt go-PATENTS.txt go-buildinfo/trivy.modules.tsv \
      | LC_ALL=C sort > go-buildinfo/trivy.artifacts.sha256

FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS rclone-builder
ENV GOTOOLCHAIN=local
ARG TARGETOS
ARG TARGETARCH
ARG RCLONE_VERSION
ARG RCLONE_SOURCE_COMMIT
ARG RCLONE_SOURCE_SHA256
ARG RCLONE_LICENSE_SHA256
ARG GO_GRPC_VERSION
ARG GO_TEXT_VERSION
RUN set -eux; \
    apk add --no-cache ca-certificates curl; \
    curl -fsSLo /tmp/rclone-source.tar.gz "https://github.com/rclone/rclone/archive/${RCLONE_SOURCE_COMMIT}.tar.gz"; \
    echo "${RCLONE_SOURCE_SHA256}  /tmp/rclone-source.tar.gz" | sha256sum -c -; \
    mkdir -p /src /out/licenses/go-buildinfo; \
    tar -xzf /tmp/rclone-source.tar.gz -C /src --strip-components=1; \
    echo "${RCLONE_LICENSE_SHA256}  /src/COPYING" | sha256sum -c -; \
    cd /src; \
    go get "google.golang.org/grpc@v${GO_GRPC_VERSION}"; \
    go get "golang.org/x/text@v${GO_TEXT_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' google.golang.org/grpc)" = "v${GO_GRPC_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' golang.org/x/text)" = "v${GO_TEXT_VERSION}"; \
    CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
      go build -mod=readonly -buildvcs=false -trimpath \
        -ldflags="-s -w -X github.com/rclone/rclone/fs.Version=v${RCLONE_VERSION}" \
        -o /out/rclone .; \
    chmod 0755 /out/rclone; \
    env -u RCLONE_VERSION /out/rclone version | grep -F "rclone v${RCLONE_VERSION}"; \
    go version -m /out/rclone | grep -F "go1.26.5"; \
    install -m 0644 /src/COPYING /out/licenses/rclone-LICENSE.txt; \
    go version -m /out/rclone \
      | awk -F '\t' '$2 == "mod" || $2 == "dep" || $2 == "=>" { print $2 "\t" $3 "\t" $4 "\t" $5 }' \
      | LC_ALL=C sort -u > /out/licenses/go-buildinfo/rclone.modules.tsv; \
    sed -i -e "s#(devel)#v${RCLONE_VERSION}#" -e "s#v${RCLONE_VERSION}+dirty#v${RCLONE_VERSION}#" /out/licenses/go-buildinfo/rclone.modules.tsv; \
    grep -F 'github.com/rclone/rclone' /out/licenses/go-buildinfo/rclone.modules.tsv; \
    cd /out/licenses; \
    sha256sum rclone-LICENSE.txt go-buildinfo/rclone.modules.tsv \
      | LC_ALL=C sort > go-buildinfo/rclone.artifacts.sha256

FROM scratch AS app-tools-artifacts
COPY --from=trivy-builder /out /trivy
COPY --from=rclone-builder /out /rclone

FROM node:24-alpine3.22@sha256:191c9f0080fcbbc6547a85dc0ff7988072214a355aabdc1d2ec55a7dae5eea8a AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG APP_VERSION
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
ARG TRIVY_VERSION
ARG RCLONE_VERSION
ENV COMPOSEBASTION_VERSION="${APP_VERSION}" \
    COMPOSEBASTION_REVISION="${VCS_REF}" \
    COMPOSEBASTION_BUILD_DATE="${BUILD_DATE}"
LABEL org.opencontainers.image.title="ComposeBastion" \
      org.opencontainers.image.description="Self-hosted Docker host manager, web UI, API, worker, recovery, and operations console" \
      org.opencontainers.image.url="https://github.com/composebastion-admin/composebastion" \
      org.opencontainers.image.source="https://github.com/composebastion-admin/composebastion" \
      org.opencontainers.image.vendor="ComposeBastion Admin" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="LicenseRef-ComposeBastion-SourceAvailable-PrivateUse-1.0"
RUN set -eux; \
    apk add --no-cache 'libcrypto3=3.5.7-r0' 'libssl3=3.5.7-r0'; \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=trivy-builder /out/trivy /usr/local/bin/trivy
COPY --from=rclone-builder /out/rclone /usr/local/bin/rclone
COPY --from=trivy-builder /out/licenses/ /licenses/third-party/
COPY --from=rclone-builder /out/licenses/ /licenses/third-party/
COPY LICENSES/go-modules/ /licenses/third-party/go-modules/
COPY scripts/go-attribution.mjs /tmp/go-attribution.mjs
COPY scripts/go-attribution-review.mjs /tmp/go-attribution-review.mjs
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/infra ./infra
COPY LICENSE.md LICENSING_SUMMARY.md COMMERCIAL-LICENSE.md NOTICE.md THIRD-PARTY-NOTICES.md TRADEMARKS.md /licenses/
COPY LICENSES /licenses/LICENSES
RUN mkdir -p /data/backups /var/cache/composebastion/trivy && \
    chown -R 1000:1000 /data/backups /var/cache/composebastion
RUN set -eux; \
    node -e "Promise.all([import('@composebastion/shared'), import('semver')])"; \
    trivy --version | grep -F "Version: ${TRIVY_VERSION}"; \
    env -u RCLONE_VERSION rclone version | grep -F "rclone v${RCLONE_VERSION}"; \
    test -s /licenses/third-party/trivy-LICENSE.txt; \
    test -s /licenses/third-party/trivy-NOTICE.txt; \
    test -s /licenses/third-party/oras-go-LICENSE.txt; \
    test -s /licenses/third-party/rclone-LICENSE.txt; \
    test -s /licenses/third-party/go-LICENSE.txt; \
    test -s /licenses/third-party/go-PATENTS.txt; \
    test -s /licenses/third-party/go-buildinfo/trivy.modules.tsv; \
    test -s /licenses/third-party/go-buildinfo/trivy.artifacts.sha256; \
    test -s /licenses/third-party/go-buildinfo/rclone.modules.tsv; \
    test -s /licenses/third-party/go-buildinfo/rclone.artifacts.sha256; \
    cd /licenses/third-party; \
    sha256sum -c go-buildinfo/trivy.artifacts.sha256; \
    sha256sum -c go-buildinfo/rclone.artifacts.sha256; \
    node /tmp/go-attribution.mjs verify \
      --manifest /licenses/third-party/go-modules/manifest.json \
      --inventory trivy=/licenses/third-party/go-buildinfo/trivy.modules.tsv \
      --inventory rclone=/licenses/third-party/go-buildinfo/rclone.modules.tsv; \
    rm /tmp/go-attribution.mjs /tmp/go-attribution-review.mjs
USER 1000:1000
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
