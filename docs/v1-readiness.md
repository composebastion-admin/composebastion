# V1 Readiness

ComposeBastion is using the `v0.9` line to finish V1 hardening. V1 readiness
means the core product is feature-complete, documented, and release-gated; it
does not mean every recovery provider has graduated from Beta or experimental
status.

## V1 Stability Model

- Core host management, Compose operations, GitHub deploys, alerts, RBAC, audit,
  config backup/restore, and the `/api/v1` compatibility boundary are intended
  to be V1-stable after the release-candidate cycle.
- Backups, restores, restore drills, recovery points, and migration runs are
  included in V1 but remain labeled Beta until broader real-world restore proof
  is complete.
- Local, S3-compatible, and SMB backup targets are the supported guided storage
  targets for the V1 candidate.
- Drive, OneDrive, iCloud Drive, WebDAV, SFTP, and custom rclone targets remain
  experimental imported-rclone workflows.

## Release Path

1. Publish one or more `0.9.x` hardening releases for cleanup, docs, and release
   automation fixes.
2. Publish `v1.0.0-rc.1` only after all automated gates pass locally and on
   GitHub.
3. Promote to `v1.0.0` only when the RC has no release-blocking issues, image
   tags publish correctly, and docs match the final support story.
4. Restart the RC cycle for any breaking `/api/v1` change after the first RC.

## Required Gates

- `npm run typecheck`
- `npm run lint:migrations`
- `npm run openapi:check --workspace @composebastion/api`
- `npm test`
- `npm run smoke:web`
- `npm audit --omit=dev --audit-level=high`
- Docker Compose config validation for source, image, production, and agent
  examples.
- Runtime image builds for both app and agent.
- GitHub CI, CodeQL, dependency review, container scanning, secret scanning, and
  image publishing checks when configured.

## Manual Acceptance

- Fresh image install from GHCR.
- Upgrade from the latest `v0.9` release.
- Unauthenticated GHCR pulls for app and agent image tags.
- Local backup, verify, and restore drill.
- S3 and SMB backup target connection tests.
- Confirmation that Beta and experimental labels appear where expected.

## GitHub Release Plumbing

- Protect `main` before V1 promotion.
- Require the release-gating checks before merges or release promotion.
- Enable or verify Dependabot alerts and secret scanning.
- Keep dependency review enabled for pull requests that change dependencies.

