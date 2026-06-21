# ComposeBastion OpenAPI

Generated from `apps/api/src/openapi/document.ts`.

Stable JSON endpoints are documented under `/api/v1/*`. Existing `/api/*` endpoints remain compatibility aliases before 1.0.

| Method | Path | Auth | Summary |
|--------|------|------|---------|
| GET | `/api/v1/health` | public | Basic API health check |
| GET | `/api/v1/health/ready` | public | Composite readiness check |
| GET | `/api/v1/auth/setup-state` | public | Read setup state |
| POST | `/api/v1/auth/setup` | public | Create the first owner account |
| POST | `/api/v1/auth/login` | public | Create a session cookie |
| POST | `/api/v1/auth/logout` | session | Destroy the current session |
| GET | `/api/v1/auth/me` | session | Read the current signed-in user |
| GET | `/api/v1/auth/sessions` | session | List active sessions for current user |
| DELETE | `/api/v1/auth/sessions/{id}` | session | Revoke one active session |
| GET | `/api/v1/hosts` | viewer | List Docker hosts |
| POST | `/api/v1/hosts` | operator | Create a Docker host |
| GET | `/api/v1/hosts/{id}/resources` | viewer | List host resource inventory |
| GET | `/api/v1/hosts/{id}/image-cleanup` | operator | Preview removable and blocked Docker images |
| POST | `/api/v1/hosts/{id}/actions` | operator | Enqueue a typed Docker action |
| GET | `/api/v1/hosts/{hostId}/metrics` | viewer | Read one host metrics snapshot |
| GET | `/api/v1/hosts/metrics` | viewer | Read fleet metrics snapshot |
| GET | `/api/v1/hosts/{hostId}/metrics-stream` | viewer | SSE host metrics stream |
| GET | `/api/v1/hosts/{hostId}/containers/{containerId}/logs` | viewer | Read container logs |
| GET | `/api/v1/hosts/{hostId}/containers/{containerId}/logs-stream` | viewer | SSE container log stream |
| GET | `/api/v1/hosts/{hostId}/containers/{containerId}/inspect` | viewer | Read redacted/full container inspect details by role |
| POST | `/api/v1/hosts/{hostId}/containers/{containerId}/exec` | operator | Run audited container exec |
| GET | `/api/v1/hosts/{hostId}/containers/usage-stream` | viewer | SSE container usage stream |
| GET | `/api/v1/hosts/{hostId}/terminal` | admin | Interactive host terminal websocket |
| GET | `/api/v1/jobs` | viewer | List operation jobs |
| GET | `/api/v1/jobs/status` | viewer | Read worker queue status |
| GET | `/api/v1/jobs/{id}` | viewer | Read one operation job |
| POST | `/api/v1/jobs/{id}/retry` | operator | Retry a failed or canceled operation job |
| POST | `/api/v1/jobs/{id}/cancel` | operator | Cancel a queued operation job |
| GET | `/api/v1/backups` | viewer | List backups |
| GET | `/api/v1/backups/health` | viewer | Read backup health |
| POST | `/api/v1/backups` | operator | Create a volume backup |
| GET | `/api/v1/backups/{id}/download` | operator | Download a backup archive |
| GET | `/api/v1/recovery/targets` | viewer | List recovery backup targets |
| POST | `/api/v1/recovery/targets` | operator | Create a recovery backup target |
| GET | `/api/v1/recovery/targets/{id}` | viewer | Read one recovery backup target |
| PATCH | `/api/v1/recovery/targets/{id}` | operator | Update a recovery backup target |
| DELETE | `/api/v1/recovery/targets/{id}` | operator | Delete a recovery backup target |
| POST | `/api/v1/recovery/targets/{id}/test` | operator | Test a recovery backup target connection |
| POST | `/api/v1/recovery/analyze` | viewer | Analyze app recovery data locations |
| GET | `/api/v1/recovery/readiness` | viewer | List app recovery readiness scores |
| POST | `/api/v1/recovery/readiness/analyze` | viewer | Analyze one app recovery readiness score |
| POST | `/api/v1/recovery/profiles/lookup` | viewer | Find the saved recovery profile for an app |
| PUT | `/api/v1/recovery/profiles` | operator | Create or update an app recovery profile |
| GET | `/api/v1/recovery/profiles/{id}` | viewer | Read one app recovery profile |
| DELETE | `/api/v1/recovery/profiles/{id}` | operator | Delete an app recovery profile |
| GET | `/api/v1/recovery/points` | viewer | List recovery points |
| POST | `/api/v1/recovery/points` | operator | Create a recovery point |
| POST | `/api/v1/recovery/points/{id}/drill` | operator | Enqueue a clone-only recovery restore drill |
| GET | `/api/v1/apps` | viewer | List managed apps |
| GET | `/api/v1/image-updates` | viewer | List image update intelligence |
| GET | `/api/v1/image-updates/preview` | viewer | Preview an image update action |
| GET | `/api/v1/image-scanner/status` | viewer | Read vulnerability scanner availability |
| GET | `/api/v1/alerts/channels` | operator | List alert notification channels |
| POST | `/api/v1/alerts/channels` | operator | Create alert notification channel |
| POST | `/api/v1/alerts/channels/{id}/test` | operator | Send alert channel test notification |
| GET | `/api/v1/alerts/channels/test-history` | viewer | List recent alert channel test history |
| GET | `/api/v1/alerts/channels/{id}/test-history` | viewer | List alert channel test history |
| GET | `/api/v1/alerts/rules` | operator | List alert rules |
| POST | `/api/v1/alerts/rules` | operator | Create alert rule |
| GET | `/api/v1/alerts/silences` | viewer | List alert silences |
| POST | `/api/v1/alerts/silences` | operator | Create alert silence |
| DELETE | `/api/v1/alerts/silences/{id}` | operator | Delete alert silence |
| GET | `/api/v1/alerts/history` | viewer | List alert history events |
| GET | `/api/v1/audit` | admin | List audit events |
| GET | `/api/v1/users` | admin | List users |

## Non-JSON Contracts

### GET /api/v1/hosts/{hostId}/metrics-stream

Auth: viewer.
Transport: Server-Sent Events (`text/event-stream`).
- Events: `stats`, `error`, `ping`.
- `stats` payload is `{ stats: HostStats }`; errors use `{ error }` and the stream remains reconnectable.

### GET /api/v1/hosts/{hostId}/containers/{containerId}/logs-stream

Auth: viewer.
Transport: Server-Sent Events (`text/event-stream`).
- Events: `message`, `error`, `ping`, `end`.
- `message` payload is `{ line: string }` and preserves blank lines plus leading/trailing whitespace.

### GET /api/v1/hosts/{hostId}/containers/usage-stream

Auth: viewer.
Transport: Server-Sent Events (`text/event-stream`).
- Events: `usage`, `error`, `ping`.
- `usage` payload is `{ stats }` with Docker stats rows; malformed rows are surfaced as `error` events.

### GET /api/v1/hosts/{hostId}/terminal

Auth: admin.
Transport: WebSocket upgrade.
- WebSocket route for owner/admin shell access on SSH-capable hosts.
- Authentication and authorization failures are returned before upgrade with the standard error envelope.

### GET /api/v1/backups/{id}/download

Auth: operator.
Transport: attachment download stream.
- Returns an attachment stream on success.
- Validation, authorization, missing-file, and unsupported-remote failures use the standard JSON error envelope with `requestId`.

