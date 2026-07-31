# Release Process

ComposeBastion is a TypeScript/npm workspaces project with a Fastify API,
React/Vite web UI, optional host agent, Postgres migrations, Docker Compose
deployment, and runtime Docker images.

## Branches

- `main` is the current stable/public branch.
- Short-lived feature or `codex/` branches should branch from `main`.
- Use `dev` for active integration work only if the maintainer establishes that
  branch for a release cycle.
- `beta` is the established staging/test branch. It receives push CI, CodeQL,
  container scans, and isolated app/agent image publication. Promote to `main`
  only after beta verification passes.
- Pull requests targeting `dev` receive CodeQL, dependency review, container
  scanning, and non-publishing image-build checks. Push publication remains
  restricted to `main` and `beta`; a `dev` push must never publish images.

## Required Checks

Run the same gates CI expects before release:

- `node scripts/bootstrap-npm.mjs` followed by the exact locked `npm ci`
- `npm run check:npm-version`
- `npm run check:npm-install-policy`
- `npm run typecheck`
- `npm run lint:migrations`
- `npm run openapi:check`
- `npm run check:release-version`
- `npm run check:public-hygiene`
- `npm run check:gitleaks`
- `npm run check:go-attribution:release`
- `npm run test:go-attribution-policy`
- `npm run test:container-config-policy`
- `npm run test:release-image-policy`
- `npm run test:release-alias-policy`
- `npm run test:acceptance-policy`
- `npm run notices:check`
- `npm run check:actions-pinned`
- `npm run check:release-workflows`
- `npm run check:compose-env`
- `npm run check:docker-context`
- `npm run check:container-config`
- `npm run acceptance:config`
- `npm run acceptance:assert-report` after the live acceptance run
- `npm test`
- `npm run smoke:web:qualification`
- `npm audit --audit-level=high`
- the serial PostgreSQL integration/concurrency suite, ephemeral SSH integration,
  and full live-stack acceptance
- both exact public upgrade baselines: `1.1.2` current-stable
  upgrade/rollback/re-upgrade on retained volumes, and the `1.0.6` legacy
  long-hop upgrade
- `npm run release:verify-images` from the final clean candidate commit
- Docker compose config validation and runtime image builds when Docker or
  deployment files changed
- CodeQL, dependency review, container/image scanning, secret scanning, and
  image publishing checks when configured

Go-module legal approval and evidence from real NAS/cloud infrastructure remain
mandatory before beta, main, or public image publication. They are explicitly
deferred for a non-publishing `dev` qualification and do not make that evidence
valid for a public release.

## Version Bumps

- Keep the root `package.json`, workspace package versions, and
  `package-lock.json` aligned.
- Update generated OpenAPI docs when API contracts change.
- Include tests for changed behavior and update release notes or `CHANGELOG.md`
  for user-visible changes.

## Tags

- Use `vX.Y.Z` for stable releases.
- RC/beta tags are local or staging identifiers only; the publication workflow
  intentionally accepts stable `vX.Y.Z` tags and rejects prerelease tags.
- Create tags only from the intended release branch after checks pass.
- Verify the authenticated GitHub account and remote before pushing tags.

## Docker And Images

- ComposeBastion ships two first-party GHCR images:
  - `ghcr.io/composebastion-admin/composebastion-app`
  - `ghcr.io/composebastion-admin/composebastion-agent`
- The app image is used by both the API/web service and the worker. Keep
  `docker-compose.image.yml`, `.env.example`, README install commands, and
  `docs/installation.md` aligned whenever runtime environment variables or
  version defaults change.
- Build both runtime images with the exact candidate version before release.
- Scan both images for high/critical vulnerabilities.
- Publish container images for every public release and every merge to `main`
  through `.github/workflows/publish-images.yml`.
- Every push to `beta` publishes both scanned multi-architecture images to the
  moving `beta` alias and immutable full-commit tags. Beta publication must
  never move `main`, `latest`, or stable version aliases.
- Main image publishes must include `main`, deterministic per-platform
  `sha-<40-character-sha>-amd64` and `sha-<40-character-sha>-arm64` tags, and a
  multi-platform `sha-<40-character-sha>` index. Only a verified stable tag may
  move `latest`.
  Immutable version tags such as `${VERSION}` and `v${VERSION}` must only be published
  from `v*` git tags.
- The workflow builds each app/agent architecture once as an OCI archive,
  scans that exact archive, and requires all four scans before copying any
  archive to GHCR. It generates an SPDX JSON SBOM from each exact passing OCI
  layout, verifies the copied final root filesystem and legal bundle, then
  attaches signed SBOM attestations to all four platform digests and signed
  build provenance to both verified indexes before moving a branch alias.
  Stable tags verify those attestations, promote the protected commit's
  existing SHA indexes, and never rebuild them.
- `npm run release:verify-images` applies the same invariant locally. It requires
  a clean checkout; builds app and agent for `linux/amd64` and `linux/arm64`
  exactly once; verifies the archive, manifest, config, platform, and release
  labels; proves the exact candidate legal documents, linked-Go attribution
  manifest, and component third-party artifacts inside each image; extracts
  each verified archive to a fresh OCI layout; and scans that exact content
  with the immutable Trivy 0.72.0 image.
  Its ignored JSON, Markdown, OCI, and scan reports are written below
  `test-results/release-images/`.
- Multi-arch image publishing targets `linux/amd64` and `linux/arm64` so NAS
  devices, Proxmox Docker guests, and native Docker servers can install without
  building from source.
- After publishing, verify the GitHub Actions run and the registry/package page
  instead of assuming the push succeeded.
- Treat an alias-reconciliation failure as a public-state incident: compare app
  and agent alias digests with the recorded index pair before retrying or
  announcing the release.
- Before moving an existing app/agent alias pair, the workflow captures both
  prior digests, verifies attested pairs from one source revision, and records
  the pair. If reconciliation fails, it attempts to restore and verify every
  alias with a genuine prior digest. A `verified` rollback is required;
  `rollback-failed` is a public-state incident that blocks retry and
  announcement. GHCR cannot safely delete only one newly created tag when its
  manifest is shared. A one-sided new alias is left at the exact new digest,
  marked `partial-blocked`, and stops later alias phases. A fully reconciled new
  exact/minor pair is retained if a later alias fails, with
  `failed-retained-new-pair` evidence, while the workflow attempts to restore
  every older alias. Every completed workflow attempt uploads paired
  reconciliation evidence; runner loss or cancellation may prevent upload and
  therefore also blocks announcement.
- The first attestation-aware migration has an explicit, expiring allowlist in
  `.github/legacy-alias-bootstrap.json` for the exact observed unattested
  `beta`, `main`, and `latest` digest pairs. A legacy pair is admitted only when
  its alias, ref, two digests, shared revision labels, canonical repositories,
  pending status, and expiry all match exactly; evidence records
  `legacy-unattested` because this label/digest allowlist is not cryptographic
  provenance. Duplicate or approximate matches fail closed. Remove or retire
  each entry after its one-time channel migration.
- GHCR cannot atomically update tags across the app and agent repositories, so
  even a successful run has a brief mismatch window. Moving aliases are
  discovery hints, not a paired deployment identity. Production consumers must
  resolve one reviewed release record and use both `sha-<40-character-sha>`
  indexes. Automated self-update must not independently follow `latest` until
  it consumes a single durable, signed release-pair manifest. That manifest is
  not yet published, so moving-alias self-update is outside the
  production-qualified release path.
- After the first GHCR publish, confirm package visibility is public enough for
  unauthenticated `docker pull` installs.

## Changelog Expectations

- Stable releases should state user-facing changes, fixes, security notes,
  migration/config changes, and known limitations.
- Beta/staging releases should include test notes: what to verify, where to look
  for logs/screenshots, and any rollback or known-risk notes.

## Legal And License Review

- Confirm project code, documentation, images, icons, screenshots, and other
  assets are owned by ComposeBastion Admin or included with compatible
  permission.
- Review earlier public tags before making historical license claims.
- Keep `LICENSE.md`, `LICENSING_SUMMARY.md`, `COMMERCIAL-LICENSE.md`,
  `NOTICE.md`, `THIRD-PARTY-NOTICES.md`, `TRADEMARKS.md`, and `LICENSES/`
  aligned before publishing images.
- Confirm app and agent runtime images contain those legal artifacts under
  `/licenses`.
- Review each image's deterministic linked Go-module inventory against the
  checked-in manifest and verify the runtime texts and checksums under
  `/licenses/third-party/go-modules/`. Every consuming binary, source URL, SPDX
  expression, version/replacement, required license/notice file, and checksum
  must be covered. Qualified legal approval must be dated; a pending review is a
  release blocker.
- Keep `support@composebastion.com` as the private contact path for commercial
  licensing and written permission.

## V1 Release Gates

- Treat V1 as feature-complete, documented, and release-gated.
- `/api/v1` is the V1 compatibility boundary. Breaking changes require a new
  major version or documented compatibility plan.
- Keep the sole-maintainer `main-release-gate` and `release-tags` rulesets active,
  require release-gating checks before promotion, and verify private
  vulnerability reporting, immutable releases, Dependabot, and secret scanning.
- Use `docs/v1-readiness.md` as the release verification checklist.

## Release Verification

Run these before tagging a public release:

```bash
RELEASE_APP_SECRET="$(openssl rand -hex 32)"
RELEASE_AGENT_TOKEN="$(openssl rand -hex 32)"
RELEASE_POSTGRES_PASSWORD="$(openssl rand -hex 32)"
node scripts/bootstrap-npm.mjs
npm ci --engine-strict --strict-allow-scripts --dangerously-allow-all-scripts=false --ignore-scripts=false
npm run check:npm-version
npm run check:npm-install-policy
npm run typecheck
npm run lint:migrations
npm run check:postgres-upgrade
npm run openapi:check
npm run check:release-version
npm run check:public-hygiene
npm run check:gitleaks
npm run check:go-attribution:release
npm run test:go-attribution-policy
npm run test:container-config-policy
npm run test:release-image-policy
npm run test:release-alias-policy
npm run test:acceptance-policy
npm run notices:check
npm run check:actions-pinned
npm run check:release-workflows
npm run check:compose-env
npm run check:docker-context
npm run check:container-config
npm run acceptance:config
npm test
COMPOSEBASTION_INTEGRATION=1 \
  DATABASE_URL="${RELEASE_TEST_DATABASE_URL:?point this at disposable Postgres}" \
  REDIS_URL="${RELEASE_TEST_REDIS_URL:?point this at disposable Redis}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  NODE_ENV=test \
npm run test --workspace @composebastion/api -- --no-file-parallelism
npx playwright install chromium firefox webkit
npm run smoke:web:qualification
npm run coverage
npm audit --audit-level=high
npm run acceptance:local
npm run acceptance:assert-report
POSTGRES_PASSWORD="${RELEASE_POSTGRES_PASSWORD}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  docker compose config
POSTGRES_PASSWORD="${RELEASE_POSTGRES_PASSWORD}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  docker compose -f docker-compose.image.yml config
POSTGRES_PASSWORD="${RELEASE_POSTGRES_PASSWORD}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  docker compose -f docker-compose.yml -f docker-compose.prod.example.yml config
AGENT_TOKEN="${RELEASE_AGENT_TOKEN}" \
  COMPOSEBASTION_AGENT_BIND_ADDRESS=127.0.0.1 \
  docker compose -f agent-compose.image.example.yml config
POSTGRES_PASSWORD="${RELEASE_POSTGRES_PASSWORD}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  COMPOSEBASTION_UID=1000 COMPOSEBASTION_GID=1000 \
  docker compose -f docker-compose.image.yml -f docker-compose.hardened.yml config
AGENT_TOKEN="${RELEASE_AGENT_TOKEN}" \
  COMPOSEBASTION_AGENT_BIND_ADDRESS=127.0.0.1 \
  docker compose -f agent-compose.image.example.yml -f agent-compose.hardened.yml config
test -z "$(git status --porcelain=v1 --untracked-files=all)"
npm run release:verify-images
```

The three release-check credentials above are generated for the current shell
only. Do not print, persist, or commit them; generate a new set for every run.

Set `RELEASE_TEST_DATABASE_URL` and `RELEASE_TEST_REDIS_URL` to isolated,
disposable services using the same pinned images as the `Postgres integration
tests` CI job. The explicit API command runs the PostgreSQL concurrency suite
serially. The local acceptance runner separately supplies pinned Postgres,
Redis, and SSH fixtures and exercises the live API and worker. It invokes
`npm run smoke:web:live:qualification` against that live stack and requires
Chromium, Firefox, and WebKit at desktop and mobile widths. The mocked
`npm run smoke:web` suite remains a fast developer check, but it is not a
release-qualification gate.

The qualifying acceptance run must also start and finish on the same clean
candidate commit. Its report records the full HEAD/tree identity and commit
timestamp and verifies matching version/revision/created labels on the app and
agent. Candidate and source builds use a temporary context materialized from
that exact commit; the context digest must remain stable through the run, so
ignored local files cannot enter a qualifying image. Dirty, changed,
`--skip-build`, and `--skip-upgrade` runs are explicitly nonqualifying even when
every executed scenario passes.

The image verifier must be the last local gate after the candidate commit is
created because it deliberately rejects a dirty checkout or a HEAD change. A
passing report proves all four images were built from an exact Git-derived
context and that their local OCI archives match their recorded archive,
manifest, and config digests; exact title/source/vendor/license/version labels;
full commit SHA and commit timestamp; and verified runtime legal-artifact
digests. It does not replace the post-publication comparison of remote
platform/index digests with the scanned digests.

The strict attribution command above is required for `beta`, `main`, and stable
tag publication. A pending review may still be inspected locally, but it must
not be published to a public branch alias.

The pinned MinIO and Samba fixtures prove reproducible protocol behavior only.
A real NAS and a real cloud/S3 target must still be tested and recorded manually
before production approval. Those external tests are production evidence, not a
blocker for a release whose stated scope is homelab publication.

After publishing, verify unauthenticated pulls:

```bash
VERSION="$(node -p "require('./package.json').version")"
docker pull "ghcr.io/composebastion-admin/composebastion-app:${VERSION}"
docker pull "ghcr.io/composebastion-admin/composebastion-agent:${VERSION}"
docker pull "ghcr.io/composebastion-admin/composebastion-app:v${VERSION}"
docker pull "ghcr.io/composebastion-admin/composebastion-agent:v${VERSION}"
```

For a beta branch publication, version aliases are intentionally absent.
Verify `:beta`, the immutable `sha-${REVISION}` indexes, and both
`sha-${REVISION}-{amd64,arm64}` platform tags instead.

## Post-Push Verification

- Check GitHub Actions for CI, CodeQL, dependency review, container scans, and
  any image publishing jobs.
- Confirm scanner alerts on the protected branch after scans refresh; alerts can
  lag until the target branch is rescanned.
- For every `v${VERSION}` release, verify CI, CodeQL, Container Scan, Publish Images,
  and code-scanning alerts after the scan refresh.
- Verify digest-qualified app and agent index provenance with
  `gh attestation verify oci://IMAGE@DIGEST --repo
  composebastion-admin/composebastion`. Verify each platform SPDX attestation
  separately with the same command plus
  `--predicate-type https://spdx.dev/Document/v2.3`; also constrain the signer
  workflow and source commit as the publication workflow does.
- Distinguish Dependabot or bot PRs opened after a release push from actual
  release failures.
- Close linked issues only after the fix is released or merged to the intended
  branch.
