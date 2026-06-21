# Release Process

ComposeBastion is a pre-1.0 TypeScript/npm workspaces project with a Fastify API,
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
- Image tags must include `latest` for `main`, the package version such as
  `0.9.6`, release tags such as `v0.9.6`, branch tags, and `sha-*` tags.
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

## Pre-1.0 Release Verification

Run these before tagging a public release:

```bash
npm run typecheck
npm run lint:migrations
npm run openapi:check --workspace @composebastion/api
npm test
npm run smoke:web
npm audit --omit=dev --audit-level=high
docker compose config
docker compose -f docker-compose.image.yml config
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml config
docker compose -f agent-compose.image.example.yml config
docker build --target runtime -t composebastion-app:v0.9-local .
docker build -f Dockerfile.agent --target runtime -t composebastion-agent:v0.9-local .
```

After publishing, verify unauthenticated pulls:

```bash
docker pull ghcr.io/composebastion-admin/composebastion-app:0.9.6
docker pull ghcr.io/composebastion-admin/composebastion-agent:0.9.6
```

## Post-Push Verification

- Check GitHub Actions for CI, CodeQL, dependency review, container scans, and
  any image publishing jobs.
- Confirm scanner alerts on the protected branch after scans refresh; alerts can
  lag until the target branch is rescanned.
- Distinguish Dependabot or bot PRs opened after a release push from actual
  release failures.
- Close linked issues only after the fix is released or merged to the intended
  branch.
