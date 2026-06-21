# Recommended Labels

ComposeBastion does not currently use label-sync automation. Create or update
these labels manually in GitHub, or wire this list into a future label-sync
workflow.

## Type

- `type: bug` - Reproducible product defect.
- `type: feature` - New behavior or capability.
- `type: support` - Installation, deployment, upgrade, or usage help.
- `type: security` - Vulnerability reports, scanner findings, or hardening work.
- `type: docs` - Documentation-only changes.
- `type: refactor` - Internal cleanup without intended behavior change.
- `type: dependencies` - Dependency, lockfile, base image, or toolchain updates.

## Area

- `area: ui` - React/Vite web UI, accessibility, browser smoke.
- `area: api` - Fastify API, OpenAPI, routes, services.
- `area: database` - Postgres schema, migrations, query behavior.
- `area: docker` - Docker Engine, Compose, images, containers, volumes, networks.
- `area: imports` - Compose import, app catalog, template, or source import flows.
- `area: auth` - Login, sessions, RBAC, rate limits, secrets, cookies.
- `area: security` - SSRF, scanners, dependency review, CodeQL, secret handling.
- `area: ci` - GitHub Actions, release gates, test automation.
- `area: agent` - Optional host agent and agent compatibility.
- `area: ssh` - SSH host connections and preflight checks.
- `area: github-deploy` - GitHub repository tracking and deploy workflows.
- `area: recovery` - Recovery center, restore, migration, readiness.
- `area: backups` - Backup capture, retention, storage targets, encryption.
- `area: alerts` - Host metrics, alerts, silences, notification channels.
- `area: docs` - README and docs site content.

## Priority

- `priority: low` - Useful but not time sensitive.
- `priority: medium` - Normal planned work.
- `priority: high` - Blocks important workflows or affects safety/reliability.

## Status

- `status: needs info` - Waiting for reproducible steps, logs, screenshots, or environment details.
- `status: ready` - Clear enough to implement or verify.
- `status: blocked` - Waiting on an external dependency, decision, or release gate.

## Release

- `release: beta` - Beta or staging branch/release work.
- `release: main` - Stable `main` branch/release work.

## Triage Notes

- Prefer one `type:*` label and one or more `area:*` labels.
- Add priority only after impact is understood.
- Remove `status: needs info` when the issue has enough context to act.
- Use `release: beta` for beta/staging verification and `release: main` only
  when the fix or release is intended for stable.
