ARG TRIVY_VERSION=0.72.0
ARG TRIVY_SOURCE_COMMIT=8a32853686209a428179bb3a1688802b25691564
ARG TRIVY_SOURCE_SHA256=5a922c388846d11345ce8283e4373be312458f002abc667c3cd1f77c43163725
ARG TRIVY_ORAS_VERSION=v2.6.2
ARG RCLONE_VERSION=1.74.4
ARG RCLONE_SOURCE_COMMIT=5bc93a2a7ab0ebd0a11352bc4968eabeffb18027
ARG RCLONE_SHA256_AMD64=fe435e0c36228e7c2f116a8701f01127bb1f694005fc11d1f27186c8bca4115d
ARG RCLONE_SHA256_ARM64=97685285c9ad6a0cf17d5844115d2a67245af6444db672187074bd9c358de419
ARG RCLONE_LICENSE_SHA256=8cd2e9e750b90a04b7d82dbbca3930c696ae0309d7c10464f90a44f45754cd04
ARG APP_VERSION=source

FROM node:20-alpine3.22@sha256:8f47899606d000b0704e992f927fe7335adcd0d6c98851600072fb6e14a13e60 AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

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
RUN set -eux; \
    apk add --no-cache ca-certificates curl; \
    curl -fsSLo /tmp/trivy-source.tar.gz "https://github.com/aquasecurity/trivy/archive/${TRIVY_SOURCE_COMMIT}.tar.gz"; \
    echo "${TRIVY_SOURCE_SHA256}  /tmp/trivy-source.tar.gz" | sha256sum -c -; \
    mkdir -p /src /out/licenses; \
    tar -xzf /tmp/trivy-source.tar.gz -C /src --strip-components=1; \
    cd /src; \
    go get "oras.land/oras-go/v2@${TRIVY_ORAS_VERSION}"; \
    test "$(go list -m -f '{{.Version}}' oras.land/oras-go/v2)" = "${TRIVY_ORAS_VERSION}"; \
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
    test -s /out/licenses/go-buildinfo/trivy.modules.tsv; \
    cd /out/licenses; \
    sha256sum trivy-LICENSE.txt trivy-NOTICE.txt oras-go-LICENSE.txt go-LICENSE.txt go-PATENTS.txt go-buildinfo/trivy.modules.tsv \
      | LC_ALL=C sort > go-buildinfo/trivy.artifacts.sha256

FROM node:20-alpine3.22@sha256:8f47899606d000b0704e992f927fe7335adcd0d6c98851600072fb6e14a13e60 AS tools
ARG TARGETARCH
ARG RCLONE_VERSION
ARG RCLONE_SOURCE_COMMIT
ARG RCLONE_SHA256_AMD64
ARG RCLONE_SHA256_ARM64
ARG RCLONE_LICENSE_SHA256
RUN set -eux; \
    apk add --no-cache ca-certificates curl unzip; \
    case "${TARGETARCH}" in \
      amd64) rclone_arch="amd64"; rclone_sha256="${RCLONE_SHA256_AMD64}" ;; \
      arm64) rclone_arch="arm64"; rclone_sha256="${RCLONE_SHA256_ARM64}" ;; \
      *) echo "Unsupported tools architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /out/licenses; \
    curl -fsSLo /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${rclone_arch}.zip"; \
    echo "${rclone_sha256}  /tmp/rclone.zip" | sha256sum -c -; \
    curl -fsSLo /tmp/rclone-LICENSE "https://raw.githubusercontent.com/rclone/rclone/${RCLONE_SOURCE_COMMIT}/COPYING"; \
    echo "${RCLONE_LICENSE_SHA256}  /tmp/rclone-LICENSE" | sha256sum -c -; \
    unzip -j /tmp/rclone.zip "rclone-v${RCLONE_VERSION}-linux-${rclone_arch}/rclone" -d /out; \
    chmod 0755 /out/rclone; \
    env -u RCLONE_VERSION /out/rclone version; \
    install -m 0644 /tmp/rclone-LICENSE /out/licenses/rclone-LICENSE.txt

FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS rclone-evidence
ENV GOTOOLCHAIN=local
COPY --from=tools /out/rclone /out/rclone
COPY --from=tools /out/licenses/rclone-LICENSE.txt /out/licenses/rclone-LICENSE.txt
RUN set -eux; \
    mkdir -p /out/licenses/go-buildinfo; \
    go version -m /out/rclone \
      | awk -F '\t' '$2 == "mod" || $2 == "dep" || $2 == "=>" { print $2 "\t" $3 "\t" $4 "\t" $5 }' \
      | LC_ALL=C sort -u > /out/licenses/go-buildinfo/rclone.modules.tsv; \
    grep -F 'github.com/rclone/rclone' /out/licenses/go-buildinfo/rclone.modules.tsv; \
    cd /out/licenses; \
    sha256sum rclone-LICENSE.txt go-buildinfo/rclone.modules.tsv \
      | LC_ALL=C sort > go-buildinfo/rclone.artifacts.sha256

FROM node:20-alpine3.22@sha256:8f47899606d000b0704e992f927fe7335adcd0d6c98851600072fb6e14a13e60 AS runtime
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
COPY --from=tools /out/rclone /usr/local/bin/rclone
COPY --from=trivy-builder /out/licenses/ /licenses/third-party/
COPY --from=rclone-evidence /out/licenses/ /licenses/third-party/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build /app/infra ./infra
COPY LICENSE.md LICENSING_SUMMARY.md COMMERCIAL-LICENSE.md NOTICE.md THIRD-PARTY-NOTICES.md TRADEMARKS.md /licenses/
COPY LICENSES /licenses/LICENSES
RUN mkdir -p /data/backups
RUN set -eux; \
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
    sha256sum -c go-buildinfo/rclone.artifacts.sha256
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
