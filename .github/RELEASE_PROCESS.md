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

- Build both runtime images before release:
  - `docker build --target runtime -t composebastion-app:<version> .`
  - `docker build -f Dockerfile.agent --target runtime -t composebastion-agent:<version> .`
- Scan both images for high/critical vulnerabilities.
- Publish container images only when the user or release plan explicitly asks.
- After publishing, verify the GitHub Actions run and the registry/package page
  instead of assuming the push succeeded.

## Changelog Expectations

- Stable releases should state user-facing changes, fixes, security notes,
  migration/config changes, and known limitations.
- Beta/staging releases should include test notes: what to verify, where to look
  for logs/screenshots, and any rollback or known-risk notes.

## Post-Push Verification

- Check GitHub Actions for CI, CodeQL, dependency review, container scans, and
  any image publishing jobs.
- Confirm scanner alerts on the protected branch after scans refresh; alerts can
  lag until the target branch is rescanned.
- Distinguish Dependabot or bot PRs opened after a release push from actual
  release failures.
- Close linked issues only after the fix is released or merged to the intended
  branch.
