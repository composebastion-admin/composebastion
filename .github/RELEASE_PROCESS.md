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
- `npm test`
- `npm run smoke:web`
- `npm audit --omit=dev --audit-level=high`
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
- Use `vX.Y.Z-beta.N` for beta/staging releases.
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
- Build both runtime images before release:
  - `docker build --target runtime -t composebastion-app:<version> .`
  - `docker build -f Dockerfile.agent --target runtime -t composebastion-agent:<version> .`
- Scan both images for high/critical vulnerabilities.
- Publish container images for every public release and every merge to `main`
  through `.github/workflows/publish-images.yml`.
- Main image publishes must include `latest`, branch tags, and `sha-*` tags.
  Immutable version tags such as `${VERSION}` and `v${VERSION}` must only be published
  from `v*` git tags.
- The workflow must build both app and agent images before publishing either
  image so version tags are not created from a partial runtime build.
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
npm run typecheck
npm run lint:migrations
npm run openapi:check --workspace @composebastion/api
npm test
npm run smoke:web
npm audit --omit=dev --audit-level=high
npm run check:compose-env
npm run acceptance:config
docker compose config
POSTGRES_PASSWORD=composebastion-ci-password \
  APP_SECRET=ci-test-secret-which-is-at-least-32-chars-long \
  docker compose -f docker-compose.image.yml config
POSTGRES_PASSWORD=composebastion-ci-password \
  APP_SECRET=ci-test-secret-which-is-at-least-32-chars-long \
  docker compose -f docker-compose.yml -f docker-compose.prod.example.yml config
AGENT_TOKEN=ci-test-agent-token-which-is-at-least-32-chars-long \
  docker compose -f agent-compose.image.example.yml config
docker build --target runtime -t composebastion-app:v1-local .
docker build -f Dockerfile.agent --target runtime -t composebastion-agent:v1-local .
```

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
