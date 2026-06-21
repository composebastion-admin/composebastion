# API Contracts

ComposeBastion exposes stable route families through `/api/v1/*` during the
`v0.9` hardening line and into the V1 release-candidate cycle. Existing UI and
trusted clients can keep using `/api/*`; those routes remain compatible aliases
for the same backend behavior during the V1 transition.

## Compatibility Boundary

- Prefer additive response changes and keep existing request fields working
  unless a security fix requires otherwise.
- `/api/v1` is the public compatibility boundary. New public route families
  should be documented there before release.
- After `v1.0.0-rc.1`, no breaking `/api/v1` change should ship without
  restarting the release-candidate cycle.
- Error responses should use the existing envelope shape:
  `{ error: string, code?: string, requestId?: string | null, issues?: unknown[] }`.
- The request ID is copied from `x-request-id` when provided and is included in
  standardized API errors for log correlation.
- `/api/v1/*` aliases proxy stable JSON routes. Streaming/SSE, websocket,
  terminal, and file-download endpoints use explicit `/api/v1` handlers instead
  of the alias proxy so their transport behavior is documented and testable.
- Every response that may contain secret material must be reviewed against the
  RBAC matrix before it becomes part of the contract.

## Current Route Families

| Family | Contract status |
|--------|-----------------|
| Auth/session | Stable enough for UI use; token material is never returned. |
| Hosts/resources | Stable enough for UI use; host secrets are redacted. |
| Containers/compose/apps | Stable enough for UI use; mutations are typed jobs. |
| Backups/recovery | Stable for documented local, S3, SMB, backup health attention, recovery-point, drill, and restore workflows in v0.9. |
| Metrics/alerts | Stable enough for UI use; stats may degrade gracefully when host data is unavailable. |
| Admin/config/users/audit | Stable for documented admin workflows and config backup/restore in v0.9. |

## OpenAPI Plan

The current checked artifacts are:

- `docs/openapi.json`
- `docs/openapi.md`

They are generated from `apps/api/src/openapi/document.ts` and checked in CI with
`npm run openapi:check`. Zod/shared schemas should remain the source of truth
where practical; streaming endpoints, file downloads, auth/session behavior, and
websocket/SSE contracts are documented manually in the generated markdown. The
current artifact includes concrete response envelopes for auth/session, hosts,
jobs, alerts, recovery, image intelligence, backups, audit, and users.

## Explicit Non-JSON v1 Routes

- `GET /api/v1/hosts/:hostId/metrics-stream` emits `stats`, `error`, and `ping`
  SSE events.
- `GET /api/v1/hosts/:hostId/containers/usage-stream` emits Docker stats SSE
  events for the container table/detail drawer.
- `GET /api/v1/hosts/:hostId/containers/:containerId/logs-stream` emits log
  `message` events and preserves blank lines plus leading/trailing whitespace.
- `GET /api/v1/backups/:id/download` streams a backup archive attachment on
  success and uses the standard JSON error envelope on rejection.
- `GET /api/v1/hosts/:hostId/terminal` is the owner/admin-gated websocket upgrade
  boundary for SSH-capable host terminals.
