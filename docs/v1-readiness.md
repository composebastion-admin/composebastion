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

1. Keep `1.0.7-rc.1` untagged until every automated and manual gate passes;
   create stable `v1.0.7` only from the later protected release commit.
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
- serial PostgreSQL integration/concurrency tests with the pinned Postgres and
  Redis fixtures
- `npm run smoke:web`
- `npm run smoke:web:live` on candidates that provide the separate live browser
  suite (required for v1.1 and later)
- `npm audit --audit-level=high`
- `npm run check:actions-pinned`
- `npm run check:release-workflows`
- `npm run check:release-version`
- `npm run notices:check`
- `npm run check:compose-env`
- `npm run check:docker-context`
- `npm run acceptance:config`
- `npm run acceptance:local`
- The acceptance report must say `automatedAcceptanceQualifying: true`, identify
  one clean, stable HEAD/tree context, and show matching app/agent
  version/revision/created labels. Dirty, changed, reused-build, and skipped
  runs are diagnostic only.
- ephemeral SSH Docker-host integration
- `npm run release:verify-images` from the final clean candidate commit
- Docker Compose config validation for source, image, production, and agent
  examples.
- Four exact OCI archive builds: app and agent for `linux/amd64` and
  `linux/arm64`. Each archive must contain one matching platform manifest, the
  exact version/full-revision/commit-date labels, valid manifest/config/layer
  digests, and a passing Trivy 0.72.0 scan of a fresh OCI layout extracted from
  that exact verified archive. Preserve the ignored JSON and Markdown report
  under `test-results/release-images/`.
- The agent build records the pinned Docker Compose command dependency set under
  `/usr/share/composebastion/release-evidence/` and fails unless the only linked
  `github.com/docker/docker` package is the client-side `pkg/namesgenerator`.
  The exact-version Trivy exceptions for the Docker Engine daemon-only CVEs
  `CVE-2026-34040`, `CVE-2026-41567`, and `CVE-2026-42306` depend on that
  reachability proof. `CVE-2026-50151` is not suppressed.
- GitHub CI, CodeQL, dependency review, container scanning, secret scanning, and
  image publishing checks when configured.

## Manual Acceptance

- Fresh image install from GHCR.
- Source install update from `main`.
- Unauthenticated GHCR pulls for app and agent image tags.
- Local backup, verify, and restore drill.
- S3 and SMB backup target connection tests.
- A separately recorded restore/capture test against a real NAS and a real cloud
  or S3 account. Local Samba and MinIO fixtures do not satisfy this production
  gate.
- Confirmation that experimental labels appear only for imported rclone
  providers.
- Confirmation that Admin -> About shows version, copyright, license summary,
  and `support@composebastion.com`.
- Review the deterministic linked Go module inventories and artifact checksums
  under `/licenses/third-party/go-buildinfo/`. Direct upstream tool and Go
  license/notice texts are shipped, but transitive Go module attribution review
  is pending and remains a manual release blocker.

## GitHub Release Plumbing

- Protect `main` before V1 promotion.
- Require the release-gating checks before merges or release promotion.
- Enable or verify Dependabot alerts and secret scanning.
- Keep dependency review enabled for pull requests that change dependencies.
- Treat the second trusted CODEOWNER and protected release-governance setup as
  an externally approved gate; local automation cannot mark it complete.
- After publication, compare all four remote platform digests and both
  multi-architecture indexes with the locally scanned manifest digests before
  applying or accepting public aliases.
