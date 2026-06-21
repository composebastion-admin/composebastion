# V1 Release Verification

ComposeBastion V1 is feature-complete, documented, release-gated, and published
as matching app and agent images.

## V1 Stability Model

- Core host management, Compose operations, GitHub deploys, alerts, RBAC, audit,
  config backup/restore, and the `/api/v1` compatibility boundary are V1-stable.
- Backups, restores, restore drills, recovery points, and migration runs are
  included in V1 release verification.
- Local, S3-compatible, and SMB backup targets are the supported guided storage
  targets for V1.
- Drive, OneDrive, iCloud Drive, WebDAV, SFTP, and custom rclone targets remain
  experimental imported-rclone workflows.

## Release Rules

1. Tag `v1.0.0` only after automated and manual gates pass.
2. Publish app and agent images together.
3. Confirm GHCR packages are public and pullable.
4. Confirm Docker images include legal artifacts under `/licenses`.
5. Use `support@composebastion.com` for commercial licensing and written
   permission requests.

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
- Source install update from `main`.
- Unauthenticated GHCR pulls for app and agent image tags.
- Local backup, verify, and restore drill.
- S3 and SMB backup target connection tests.
- Confirmation that experimental labels appear only for imported rclone
  providers.
- Confirmation that Admin -> About shows version, copyright, license summary,
  and `support@composebastion.com`.

## GitHub Release Plumbing

- Protect `main` before V1 promotion.
- Require the release-gating checks before merges or release promotion.
- Enable or verify Dependabot alerts and secret scanning.
- Keep dependency review enabled for pull requests that change dependencies.
