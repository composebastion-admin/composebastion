# Changelog

## [v1.1.2] - 2026-07-18

### Added
- Added validated `AGENT_READ_RATE_LIMIT`, `AGENT_RUN_RATE_LIMIT`,
  `AGENT_FILE_RATE_LIMIT`, and `AGENT_STREAM_RATE_LIMIT` settings to both
  supported agent Compose install paths. Blank values retain the existing
  defaults; invalid or unsafe values stop agent startup with an actionable
  error.
- Logged the effective non-secret agent rate-limit configuration at startup.

### Fixed
- Batched recovery-readiness container inspection by host in groups of at most
  100 containers, with no more than two hosts inspected concurrently.
- Added one bounded inventory refresh and retry for container inventory races.
  A persistent batch failure is now reported as analysis unavailable instead
  of being presented as a recovery defect caused by agent `429` responses.

### Security
- Preserved the existing per-minute, per-source-IP, per-endpoint limiter
  semantics and the four-stream concurrency cap. Raising the new limits weakens
  an availability safeguard and does not change the trusted-LAN and firewall
  requirements for the Docker-socket-backed agent.

### Configuration
- Agent configuration changes require recreating or restarting the agent.
- This patch adds no database migration, UI setting, or manager/OpenAPI change.

## [v1.1.1] - 2026-07-11

### Fixed
- Restored the documented `DATABASE_URL` Compose override so existing
  installations keep using the credentials stored in their persistent
  PostgreSQL volume after upgrading from releases that used the legacy URL.
- Kept fresh installations secure by deriving `DATABASE_URL` from the required
  URL-safe `POSTGRES_PASSWORD` whenever the override is empty or unset.
- Added a Docker-backed persistent-volume upgrade regression and explicit
  database credential recovery guidance.

## [v1.1.0] - 2026-07-11

### Added
- Added opt-in manager and agent hardening overlays, per-workspace V8 coverage
  enforcement, and a separate Playwright suite against the live application
  stack.

### Changed
- Moved source builds, CI, and runtime images to Node 24 Active LTS and raised
  the source-build engine requirement to Node `>=24`.
- Updated Playwright, React Router, Lucide, `concurrently`, compatible
  patch/minor dependencies, and the supported GitHub Action majors.

### Security
- Updated CI scanning to Trivy `0.72.0` and rebuilt the embedded Trivy `0.72.0`
  scanner from its reviewed source commit with Go `1.26.5` and ORAS Go `2.6.2`
  to remove the `CVE-2026-50151` path; the finding is never suppressed.
- Added per-architecture scans for both runtime images and stable aggregate
  scan gates that must pass before a release workflow can publish either image.
- Required explicit agent bind addresses, rejected placeholder agent tokens,
  made agent health depend on Docker and Compose, and separated read/stream
  capacity from the Docker mutation limiter.
- Added DNS-pinned, redirect-controlled registry access with private-network and
  credential boundaries, and restricted arbitrary image-tag lookup to operators.
- Pinned every GitHub Action to an immutable commit after the 2026 Trivy action
  supply-chain incident, and added an automated pinning gate.
- Serialized first-owner setup and owner mutations so concurrent requests cannot
  create multiple initial owners or remove the final active owner.

### Fixed
- Forwarded the documented SMTP, proxy, CORS/cookie, agent, webhook, S3,
  backup, interval, and scanner settings consistently through both production
  Compose installation paths.
- Added an automated Compose environment-routing check and local acceptance
  harness so configuration regressions fail before release.
- Fixed worker alert subjects so joined notification-channel fields cannot
  replace the alert rule name.
- Fixed recovery verification for remote-only targets by rehydrating missing
  artifacts from their remote copy before checksum validation.
- Fixed same-host clone restores for custom Compose networks by allocating a
  non-overlapping Docker network and dropping captured static addresses.
- Added worker heartbeats, fenced leases, safe stale-job recovery, linked-record
  failure reconciliation, and fail-closed worker readiness.
- Made PostgreSQL job insertion durable when Redis wake-up publication is
  unavailable.
- Bound migration execution to a freshly revalidated, single-use plan and
  rejected stale source or target state before destructive work.
- Corrected SemVer ordering for stable, prerelease, and build-metadata versions.
- Added role-aware browser controls, typed confirmation for permanent data
  deletion/import, and truthful terminal audit disclosure.

### Configuration

- Added required `COMPOSEBASTION_AGENT_BIND_ADDRESS` for agent examples and
  optional `COMPOSEBASTION_HTTP_BIND_ADDRESS` for published manager installs.
- Source Compose now consistently requires `POSTGRES_PASSWORD`; production
  secure-cookie defaults still permit an explicit `false` value.
- Added additive migrations `029_worker_reliability.sql` and
  `030_migration_plan_binding.sql`; no existing public route was removed.

## [v1.0.6] - 2026-07-06

> Superseded for production readiness by the pending `v1.0.7` scanner fix. The
> published `v1.0.6` app image embeds Trivy `0.71.2`, which is reported for
> `CVE-2026-50151`.

### Added
- Added first-class private GitHub repository access checks for tracked repos,
  including encrypted per-repo token status, token rotation, token clearing, and
  validation of repository metadata, refs, Compose contents, tags, and releases.
- Added host-side read-only `git ls-remote` checks for Clone & Deploy workflows
  that use GitHub deploy keys instead of app-managed clone tokens.
- Added tracked GitHub Clone/Build Deploy defaults so private repos with
  `build:` contexts can deploy from a host-side checkout using read-only deploy
  keys.

### Changed
- Reused stored private GitHub credentials for Services GitHub version discovery
  and commit update checks by repository URL.
- Updated Services redeploy precedence so clone-built tracked GitHub apps use
  host-side `git pull` plus Compose redeploy.
- Updated Services image-tag refreshes so prerelease channels like `beta` can
  surface the latest matching prerelease.
- Updated private GitHub repo documentation for read-only fine-grained tokens,
  read-only deploy keys, and multi-repo host setup.
- Bumped workspace, generated OpenAPI, runtime image defaults, and release docs
  to `1.0.6`.

## [v1.0.5] - 2026-07-01

### Fixed
- Kept ComposeBastion self-update discovery aligned with published `latest`
  tags and clarified service update status and actions.

## [v1.0.4] - 2026-06-30

### Fixed
- Triggered an immediate inventory sync after a Docker host is added so the
  new host becomes useful without waiting for the next background interval.

## [v1.0.3] - 2026-06-27

### Fixed
- Improved the Hosts empty state and inline add-host workflow for first-run
  installations.

## [v1.0.2] - 2026-06-25

### Changed
- Bumped package, generated OpenAPI, runtime image, Docker default, test, and
  documentation versions to `1.0.2`.

### Fixed
- Hardened Playwright smoke navigation for CI by waiting for DOM readiness and
  serving the web app from a production preview build instead of the Vite dev
  server.

## [v1.0.1] - 2026-06-25

### Added
- Added an admin-only ComposeBastion self-update flow for image installs running
  on an SSH-managed manager host.
- Added persistent success feedback after container image updates complete.
- Added an inline Hosts add form so Add host opens inside the Hosts workspace
  instead of only changing the top-left action area.

### Changed
- Bumped package, generated OpenAPI, runtime image, Docker default, test, and
  documentation versions to `1.0.1`.
- Updated installation, upgrade, operations, RBAC, and OpenAPI documentation for
  the self-update workflow and its SSH/image-install constraints.

## [v1.0.0] - 2026-06-21

### Added
- Promoted image-only installs as a first-class V1 path for NAS devices,
  Proxmox Docker guests, Portainer stacks, and native Docker hosts.
- Added an authenticated Admin About surface with version, copyright,
  source-available license summary, commercial contact, and legal document links.
- Added runtime image license bundles under `/licenses` for app and agent images.

### Changed
- Bumped package, generated OpenAPI, runtime image, and documentation versions to
  `1.0.0`.
- Updated V1 docs around the stable `/api/v1` contract, config backup/restore,
  agent image lifecycle, and supported recovery storage targets.
- Standardized licensing contact on `support@composebastion.com` and copyright
  ownership on ComposeBastion Admin.

### Fixed
- Removed outdated public `v0.9`/V1-readiness wording from active release docs.
- Removed release-beta labels from backup and restore-run UI surfaces for V1.

## [v0.9.9] - 2026-06-21

### Added
- Added Beta labels to backup inventory, restore/migration jobs, Recovery Center
  backup and restore-run navigation, and related smoke coverage.
- Added the V1 readiness checklist covering release gates, supported install
  paths, Beta/experimental recovery areas, upgrade expectations, and GHCR
  verification.

### Changed
- Bumped the package and generated OpenAPI versions to `0.9.9`.
- Updated GitHub and product documentation to describe the V1 hardening path:
  `0.9.x` patches, `v1.0.0-rc.1`, then `v1.0.0`.
- Cleaned local duplicate `* 2.*` workspace files so root release gates can run
  from a clean tree.

## [v0.9.8] - 2026-06-21

### Added

- Added backup health attention items to `/api/backups/health` and the Backup
  inventory panel. Failed and partial backups are prioritized ahead of
  verification and restore-drill reminders, with recommended next actions for
  each affected backup.
- Documented the backup health response shape in the generated OpenAPI contract,
  including attention reasons and severity values.

### Changed

- Bumped the workspace, agent, API, web, shared package, package lock, and
  generated OpenAPI versions to `0.9.8`.
- Updated GitHub-facing install, upgrade, release, and operator documentation
  for the `v0.9.8` release line.

### Verified

- Local API and web typechecks passed.
- Targeted backup and backup-drill tests passed.
- The shared package was typechecked against tracked source files because
  unrelated local duplicate `* 2.*` files are present in this checkout.

## [v0.9.7] - 2026-06-21

### Changed

- Bumped the workspace, runtime image labels, README badge, and generated
  OpenAPI contract to `0.9.7`.
- Updated published-image documentation so production installs generate a
  URL-safe `POSTGRES_PASSWORD` with `openssl rand -hex 32`.
- Updated GHCR publishing so `main` publishes moving tags only (`latest`,
  branch tags, and `sha-*`), while immutable release tags such as `0.9.7`,
  `v0.9.7`, and the `0.9` minor tag publish only from `v*` git tags.

### Fixed

- Fixed image install guidance that could generate a database password with `/`
  and produce an invalid `DATABASE_URL`.
- Fixed OpenAPI version drift by deriving the generated API document version
  from the API package version.
- Added a pre-publish build pass for both app and agent images so release tags
  are published only after both runtime images build successfully.

### Verified

- GitHub CI, CodeQL, Container Scan, and Publish Images passed for `main`.
- The `v0.9.7` tag publish succeeded for both app and agent images on
  `linux/amd64` and `linux/arm64`.
- GitHub code scanning reported 0 open alerts after the release scan refreshed.

## [v0.9.6] - 2026-06-21

### Added

- Added buildless GHCR image install files for the manager and optional host
  agent, with NAS, Proxmox Docker guest, and native Docker host guidance.
- Added a multi-arch image publishing workflow for `linux/amd64` and
  `linux/arm64` app and agent images.
- Added v0.9.6 release verification commands covering typecheck, migrations,
  OpenAPI, tests, browser smoke, audit, Compose config validation, and image
  builds.

### Changed

- Bumped the workspace, runtime images, and generated OpenAPI contract to
  `0.9.6`.
- Updated installation, upgrade, and release documentation so source updates and
  published images stay aligned.
- Documented `/api/v1` as the public API compatibility boundary and exposed runtime
  version metadata through the health endpoint.
- Promoted local, S3-compatible, and SMB recovery storage targets as v0.9-supported
  while labeling imported rclone cloud/custom providers as experimental.
- Updated app/agent compatibility guidance so agent mode is a supported host
  connection path.

### Fixed

- Hardened config backup import errors so bad passphrases, wrong products,
  unsupported formats, and malformed payloads return client-facing validation
  errors before any import transaction starts.

## [v0.9.4] - 2026-06-20

### Added

- Added a full ComposeBastion screenshot gallery covering Docker inventory,
  image cleanup, GitHub deploys, recovery workflows, alerts, admin operations,
  users, registries, audit, and guided help.
- Added source-available licensing documents, commercial-use guidance,
  trademark notices, contribution guidance, and third-party dependency notices.

### Changed

- Bumped the workspace version to `0.9.4`.
- Expanded README and how-to documentation so the public GitHub page shows the
  product more completely before install.

## [v0.9] - 2026-06-20

### Added

- Established ComposeBastion under the canonical
  `composebastion-admin/composebastion` repository.
- Set `v0.9` as the first public repository version.
- Documented the repository rule that pushes, tags, releases, and version
  updates must use the `composebastion-admin` GitHub account.
- Included the current Docker host management, GitHub deploy, recovery,
  alerting, RBAC, OpenAPI, and CI baseline for the first public push.

### Changed

- Standardized internal workspace, CI, Docker, database, local storage, and
  agent path defaults under the ComposeBastion namespace.
- Cleaned public docs so the repository starts with a fresh `v0.9` release
  history for the public baseline.
- Updated package metadata to point at
  `https://github.com/composebastion-admin/composebastion`.

### Removed

- Removed stale backlog and personal editor launch files.
- Removed personal owner, image, email, and path fixtures from tests and docs.
- Removed legacy config-backup app-name compatibility from the fresh repo
  baseline.
