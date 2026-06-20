# Changelog

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
