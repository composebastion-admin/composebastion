# Changelog

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
