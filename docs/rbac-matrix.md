# RBAC Matrix

ComposeBastion uses four roles: `owner`, `admin`, `operator`, and `viewer`.
Permissions are additive from right to left: owner and admin include operator
capabilities, and operator includes viewer capabilities.

## Role Intent

| Role | Intended use |
|------|--------------|
| `viewer` | Read-only operations dashboards, inventory, metrics, logs, and non-secret inspect data. |
| `operator` | Day-to-day Docker operations: start/stop/restart, deploy, backups, restores, registry login, file access, and alert setup. |
| `admin` | Account and platform administration, including users, audit, config import/export, and operator capabilities. |
| `owner` | First administrator and full system owner. Same product permissions as admin, reserved for highest trust. |

## Route Groups

| Area | Viewer | Operator | Admin / Owner | Notes |
|------|--------|----------|---------------|-------|
| Hosts and inventory | Read | Mutate/check/sync | Mutate/check/sync | Host secrets are never returned. |
| Containers | Logs/stats/inspect/usage | Exec, backup, mutate, migrate | Exec, backup, mutate, migrate | Inspect env values are redacted for viewers. |
| Compose, apps, catalog | Read | Deploy/update/rollback/remove | Deploy/update/rollback/remove | All mutations flow through typed jobs. |
| Backups and recovery | Read recovery points | Create, restore, verify, drill, delete | Create, restore, verify, drill, delete | Download is operator-gated because archives may contain secrets. |
| Host files and terminal | None | File browser/read/write | Terminal access | Host terminal is admin/owner only. |
| Alerts | Read status/history/silences/test history | Manage rules/channels/silences/tests | Manage rules/channels/silences/tests | Viewer reads expose alert metadata only; mutations remain operator-gated. |
| Registries | None | Full management | Full management | Registry credentials may expose operational secrets. |
| Jobs | Read | Read | Read | Job creation is done through the feature-specific operator routes. |
| Audit | None | None | Read | Audit details are administrative records. |
| Users and config import/export | None | None | Full management | Config export may include encrypted secret material. |
| Auth sessions | Own sessions | Own sessions | Own sessions | Users can revoke only their own sessions. |

## Contributor Rules

- Every new `/api/*` route must use `requireRole([...])`, manually call
  `readSession(request)`, or be added to the public-route exception list in the
  route authorization coverage test.
- Mutations must be at least operator-gated and audited when they change host,
  Docker, credential, recovery, user, or platform state.
- Viewer routes must not return secret material. Redact env values, credentials,
  tokens, private keys, archive contents, and host file contents unless the route
  is intentionally operator/admin gated.
- Prefer additive response changes before 1.0; document any shape that becomes
  part of the compatibility contract.
