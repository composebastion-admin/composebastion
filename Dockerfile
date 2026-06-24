ARG TRIVY_VERSION=0.71.2
ARG APP_VERSION=1.0.1

FROM node:20-bookworm-slim AS deps
WORKDIR /app
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

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ARG TRIVY_VERSION
ARG APP_VERSION
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
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
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates curl rclone; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) trivy_arch="64bit" ;; \
      arm64) trivy_arch="ARM64" ;; \
      armhf) trivy_arch="ARM" ;; \
      i386) trivy_arch="32bit" ;; \
      ppc64el) trivy_arch="PPC64LE" ;; \
      s390x) trivy_arch="s390x" ;; \
      *) echo "Unsupported architecture for Trivy: ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/trivy.deb "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${trivy_arch}.deb"; \
    apt-get install -y --no-install-recommends /tmp/trivy.deb; \
    rm -f /tmp/trivy.deb; \
    apt-get purge -y --auto-remove curl; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

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
RUN mkdir -p /data/backups
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
