# V1 Release Verification

Use this version-independent checklist for every V1 candidate. A candidate is
publishable only from one clean, protected commit after every automated release
gate and applicable manual gate has passed.

## V1 Stability Model

- Core host management, Compose operations, GitHub deploys, alerts, RBAC, audit,
  config backup/restore, and the `/api/v1` compatibility boundary are V1-stable.
- Backups, restores, restore drills, recovery points, and migration runs are part
  of V1 verification.
- Local, S3-compatible, and SMB targets are supported guided recovery storage.
- Imported Drive, OneDrive, iCloud Drive, WebDAV, SFTP, and custom rclone
  providers remain experimental.

## Publication Rules

1. Authenticate as exactly `composebastion-admin` before pushing branches,
   tags, images, releases, or version changes.
2. Publish app and agent images together from the same protected commit.
3. Confirm GHCR packages and all supported platform manifests are anonymously
   pullable.
4. Confirm both runtime images contain complete legal artifacts under
   `/licenses`, including the approved Go-module attribution bundle.
5. Never create the stable tag while a release blocker remains open.

## Automated Gates

- formatting and type checking;
- migration lint and PostgreSQL upgrade/integration/concurrency tests;
- OpenAPI generation check and release-version alignment;
- public-hygiene, notices, action-pinning, release-workflow, Compose environment,
  and exact Docker-context checks;
- unit tests and per-workspace coverage thresholds;
- mocked web smoke and the separate live web smoke suite;
- acceptance configuration and a qualifying full local acceptance run;
- ephemeral SSH Docker-host integration;
- `npm audit --audit-level=high`, Gitleaks, CodeQL, dependency review, secret
  scanning, and container scanning;
- source, published-image, production-overlay, and agent Compose validation;
- exact app and agent OCI builds for `linux/amd64` and `linux/arm64` with matching
  version, full-revision, created labels, and deterministic platform tags;
- `npm run release:verify-images` from the final clean candidate commit.

The acceptance report must record one stable HEAD/tree/context digest and say
`automatedAcceptanceQualifying: true`. Dirty, changed, skipped, or reused-build
runs are diagnostic only.

The four verified OCI archives must each contain one correct platform manifest,
valid manifest/config/layer digests, the expected labels, matching Go-module
attribution evidence, and a passing scan of the exact archive. Preserve ignored
release evidence below `test-results/release-images/`.

## Manual Release Gates

- Verify private vulnerability reporting, repository rulesets, required checks,
  immutable-release policy, Dependabot, and secret-scanning configuration.
- Verify no high-or-critical CodeQL alert is open. A test-only network alert may
  be dismissed only with recorded evidence that its destination is the isolated
  loopback acceptance stack.
- Review the linked Go-module manifest, license expressions, upstream sources,
  required texts, and checksums. Record qualified legal approval and its date;
  pending attribution is a release blocker.
- Verify Admin -> About shows the intended version, copyright, license summary,
  and `support@composebastion.com`.
- Verify unauthenticated pulls, image labels, multi-architecture indexes,
  deterministic platform tags, and the GitHub Release attestation.

Real NAS and cloud/S3 capture-and-restore tests are production-approval evidence.
They do not block publication for homelab use. Local Samba and MinIO remain the
automated protocol fixtures, and production claims must identify which real
systems were separately tested.

## Recovery And Agent Evidence

- Complete a local backup, verification, and clone restore drill.
- Test supported S3-compatible and SMB target connections.
- Confirm experimental labels apply only to imported rclone providers.
- Verify recovery readiness batches container inspection without converting
  agent rate limiting or changing inventory into a false recovery defect.
- Keep app and agent releases aligned and preserve the four-stream concurrency
  cap and trusted-LAN/firewall guidance.

## Post-Publication Verification

- Verify `gh release verify vX.Y.Z` for the published immutable release.
- Compare all remote platform and multi-architecture digests with the locally
  scanned evidence before accepting public aliases.
- Confirm version/revision labels and anonymous pulls for app and agent.
- Confirm no release or security alert remains unexpectedly open.
