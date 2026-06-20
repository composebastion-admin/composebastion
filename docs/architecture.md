# Architecture

ComposeBastion is an npm workspace monorepo:

| Package | Role |
|---------|------|
| `apps/api` | Fastify HTTP API, Postgres, job enqueue, static web |
| `apps/api` worker | Background jobs, host checks, inventory sync, alerts |
| `apps/web` | React UI (Vite) |
| `apps/agent` | Optional per-host Docker command proxy |
| `packages/shared` | Zod schemas and shared types |

## Request flow

1. Browser loads the SPA from the API container (`WEB_DIST_DIR`).
2. Cookie session auth gates `/api/*` routes (role-based).
3. Stable JSON routes are also reachable under `/api/v1/*`; streaming, websocket,
   and file-transfer routes have explicit `/api/v1` handlers and generated
   contract notes.
4. Operators enqueue **typed** Docker actions → `operation_jobs` table.
5. Worker claims jobs, runs SSH or agent transport, stores results.
6. Redis pub/sub wakes the worker; polling is a fallback.

## Web shell

- The dashboard shell owns host scope, refresh state, global search, navigation,
  and job activity.
- Heavy panels and the host terminal drawer are lazy-loaded. The shell renders a
  skeleton fallback while tab chunks load, which keeps the initial bundle smaller.

## Live operations

- Container usage and single-host metrics use server-sent events from the API.
- Fleet host metrics use short cached snapshots so the overview can poll without
  opening one live stream per host or per browser.
- SSH hosts collect live host stats from one fixed `/proc` snapshot command.
- Agent hosts collect live host stats through `GET /api/host-stats`, which reads
  fixed `/proc` files and mount stats directly instead of executing a shell.
- SSH and agent container log follow stream raw Docker log lines so formatting is
  preserved. Agent live logs require a compatible agent version.
- Queued jobs can be canceled before worker pickup. Failed and canceled jobs can
  be retried by cloning the original typed action into a fresh queued job.

## Alerts

- The worker evaluates alert rules every 30 seconds.
- Alert channel test attempts are stored so operators can verify recent email or
  webhook test health.
- Host/container availability rules still use the inventory and host status paths.
- Host metric threshold rules use fleet host snapshots, store params as JSON, track
  `breaching_since`, and reuse the existing notification cooldown.

## Data

- **Postgres**: users, hosts, resource snapshots, compose stacks, backups, jobs, audit.
- **Volume**: backup archives under `BACKUP_DIR`.

## Security model

- No arbitrary shell from the UI — only `dockerActionSchema` types.
- SSH secrets encrypted with `APP_SECRET`.
- Production refuses the default `APP_SECRET`.
- Container inspect masks environment values for viewers.
- Active session APIs return safe metadata only and revoke sessions by `user_id`.
- Route authorization coverage tests require every API route to declare RBAC,
  manual session auth, or an explicit public exception.
- Standard API errors include a `requestId` that mirrors `x-request-id` when
  supplied by the caller.
- API and worker logs carry structured request/job/host/action/duration/status
  fields for correlation with audit and job records.

## Release guardrails

- Migration filenames are linted in CI. The published duplicate `018` prefix is
  a legacy exception; new migrations must use the next clean number.
- OpenAPI artifacts are generated from `apps/api/src/openapi/document.ts` and
  checked in CI.
- CI runs mocked Playwright browser smoke tests for setup, keyboard/theme,
  mobile navigation/Admin flows, dialogs, alerts, sessions, job actions,
  recovery drills, container detail drawers, image previews, and Operations
  flows.
- CI validates production Compose config and builds both app and agent runtime
  images before changes are accepted on `main`.
