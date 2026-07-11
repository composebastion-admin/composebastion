# Release Process

ComposeBastion is a TypeScript/npm workspaces project with a Fastify API,
React/Vite web UI, optional host agent, Postgres migrations, Docker Compose
deployment, and runtime Docker images.

## Branches

- `main` is the current stable/public branch and the branch targeted by push CI.
- Short-lived feature or `codex/` branches should branch from `main`.
- Use `dev` for active integration work only if the maintainer establishes that
  branch for a release cycle.
- Use `beta` for staging/beta test releases only if the maintainer establishes
  that branch. Promote to `main` only after smoke testing passes.

## Required Checks

Run the same gates CI expects before release:

- `npm run typecheck`
- `npm run lint:migrations`
- `npm run openapi:check`
- `npm run check:release-version`
- `npm run notices:check`
- `npm run check:actions-pinned`
- `npm run check:release-workflows`
- `npm run check:compose-env`
- `npm run check:docker-context`
- `npm run acceptance:config`
- `npm test`
- `npm run smoke:web`
- `npm audit --audit-level=high`
- the serial PostgreSQL integration/concurrency suite, ephemeral SSH integration,
  and full live-stack acceptance
- `npm run release:verify-images` from the final clean candidate commit
- Docker compose config validation and runtime image builds when Docker or
  deployment files changed
- CodeQL, dependency review, container/image scanning, secret scanning, and
  image publishing checks when configured

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
- Main image publishes must include `main` and a full-commit
  `sha-<40-character-sha>` index. Only a verified stable tag may move `latest`.
  Immutable version tags such as `${VERSION}` and `v${VERSION}` must only be published
  from `v*` git tags.
- The workflow builds each app/agent architecture once as an OCI archive,
  scans that exact archive, and requires all four scans before copying any
  archive to GHCR. Stable tags promote the protected commit's existing SHA
  indexes and never rebuild them.
- `npm run release:verify-images` applies the same invariant locally. It requires
  a clean checkout; builds app and agent for `linux/amd64` and `linux/arm64`
  exactly once; verifies the archive, manifest, config, platform, and release
  labels; extracts each verified archive to a fresh OCI layout; and scans that
  exact content with the immutable Trivy 0.72.0 image.
  Its ignored JSON, Markdown, OCI, and scan reports are written below
  `test-results/release-images/`.
- Multi-arch image publishing targets `linux/amd64` and `linux/arm64` so NAS
  devices, Proxmox Docker guests, and native Docker servers can install without
  building from source.
- After publishing, verify the GitHub Actions run and the registry/package page
  instead of assuming the push succeeded.
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
- Review each image's deterministic linked Go module inventories and artifact
  checksums under `/licenses/third-party/go-buildinfo/`. Direct upstream tool
  and Go license/notice texts are shipped, but transitive Go module attribution
  review is pending and remains a manual release blocker.
- Keep `support@composebastion.com` as the private contact path for commercial
  licensing and written permission.

## V1 Release Gates

- Treat V1 as feature-complete, documented, and release-gated.
- `/api/v1` is the V1 compatibility boundary. Breaking changes require a new
  major version or documented compatibility plan.
- Protect `main`, require release-gating checks before promotion, and enable or
  verify Dependabot alerts and secret scanning before final V1.
- Use `docs/v1-readiness.md` as the release verification checklist.

## Release Verification

Run these before tagging a public release:

```bash
RELEASE_APP_SECRET="$(openssl rand -hex 32)"
RELEASE_AGENT_TOKEN="$(openssl rand -hex 32)"
RELEASE_POSTGRES_PASSWORD="$(openssl rand -hex 32)"
npm run typecheck
npm run lint:migrations
npm run openapi:check --workspace @composebastion/api
npm run check:release-version
npm run notices:check
npm run check:actions-pinned
npm run check:release-workflows
npm run check:compose-env
npm run check:docker-context
npm run acceptance:config
npm test
COMPOSEBASTION_INTEGRATION=1 \
  DATABASE_URL="${RELEASE_TEST_DATABASE_URL:?point this at disposable Postgres}" \
  REDIS_URL="${RELEASE_TEST_REDIS_URL:?point this at disposable Redis}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  NODE_ENV=test \
  npm run test --workspace @composebastion/api -- --no-file-parallelism
npm run smoke:web
npm audit --audit-level=high
npm run acceptance:local
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
npm run release:verify-images
```

The three release-check credentials above are generated for the current shell
only. Do not print, persist, or commit them; generate a new set for every run.

Set `RELEASE_TEST_DATABASE_URL` and `RELEASE_TEST_REDIS_URL` to isolated,
disposable services using the same pinned images as the `Postgres integration
tests` CI job. The explicit API command runs the PostgreSQL concurrency suite
serially. The local acceptance runner separately supplies pinned Postgres,
Redis, and SSH fixtures and exercises the live API and worker. On the v1.1
candidate, also run `npm run smoke:web:live` against that live stack; keep the
mocked `npm run smoke:web` suite as a separate fast gate.

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
manifest, and config digests and the exact candidate version, full commit SHA,
and commit timestamp. It does not replace the post-publication comparison of
remote platform/index digests with the scanned digests.

The pinned MinIO and Samba fixtures prove reproducible protocol behavior only.
A real NAS and a real cloud/S3 target must still be tested and recorded manually
before production approval.

After publishing, verify unauthenticated pulls:

```bash
VERSION="$(node -p "require('./package.json').version")"
docker pull "ghcr.io/composebastion-admin/composebastion-app:${VERSION}"
docker pull "ghcr.io/composebastion-admin/composebastion-agent:${VERSION}"
docker pull "ghcr.io/composebastion-admin/composebastion-app:v${VERSION}"
docker pull "ghcr.io/composebastion-admin/composebastion-agent:v${VERSION}"
```

## Post-Push Verification

- Check GitHub Actions for CI, CodeQL, dependency review, container scans, and
  any image publishing jobs.
- Confirm scanner alerts on the protected branch after scans refresh; alerts can
  lag until the target branch is rescanned.
- For every `v${VERSION}` release, verify CI, CodeQL, Container Scan, Publish Images,
  and code-scanning alerts after the scan refresh.
- Distinguish Dependabot or bot PRs opened after a release push from actual
  release failures.
- Close linked issues only after the fix is released or merged to the intended
  branch.
