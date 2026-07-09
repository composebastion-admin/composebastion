# Security Hardening

Use this checklist before exposing ComposeBastion outside a trusted private network.

## Required

- Set a unique `APP_SECRET` with at least 32 characters. Production rejects the
  known fallback and `.env.example` placeholder values.
- Set a URL-safe `POSTGRES_PASSWORD`, for example with `openssl rand -hex 32`,
  because image installs interpolate it into `DATABASE_URL`.
- Keep the production `SECURE_COOKIES=true` default behind HTTPS. Set it to
  `false` only for a trusted direct-HTTP evaluation.
- Use a reverse proxy that preserves the original client IP only from trusted
  proxy hops.
- Set `CORS_ORIGINS` for any cross-origin UI/API deployment; mutating browser
  requests are rejected when their `Origin` is neither same-host nor configured.
- Set the required `COMPOSEBASTION_AGENT_BIND_ADDRESS` to a trusted
  manager-reachable interface and restrict agent port `8090` to the manager.
- Treat any process with Docker-socket access, including the root agent, as
  host-root-equivalent.
- Use least-privilege SSH users that can run Docker but do not have broad host
  shell access unless operators intentionally need it.

## Recommended

- Keep `ALLOW_PRIVATE_AGENT_URLS=false` in production unless the manager is
  intentionally deployed inside the same private network as agents.
- Keep `ALLOW_PRIVATE_WEBHOOK_URLS=false` in production unless alert webhooks
  intentionally target an internal service such as a private ntfy/Gotify relay.
  Webhook delivery pins the DNS result it validated for the outgoing request.
- Keep the focused route-rate-limit defaults enabled. They add stricter buckets
  around host mutations, host files, backups/downloads, config import/export,
  live streams, terminals, and other Docker-facing operations.
- Configure `BACKUP_HOST_PATH_ALLOWED_ROOTS` when host-path backups/restores should
  be limited to approved directories.
- Rotate backup encryption keys by adding new keys before removing old keys.
- Review active sessions regularly and revoke unfamiliar devices.
- Keep viewer accounts read-only; do not expose host files, archives, terminal, or
  full container env to viewers.
- Evaluate the [opt-in container hardening overlays](container-hardening.md).
  Prepare backup and Trivy-cache ownership before enabling manager non-root
  mode, and retain the documented Docker-socket trust boundary for the agent.

## Regression Checks

- `npm run lint:migrations`
- `npm run openapi:check`
- `npm run typecheck`
- `npm test`
- `npm run coverage`
- `npm run smoke:web`
- `npm audit --audit-level=high`
- `npm run check:actions-pinned`
- `npm run check:release-version`
- `npm run check:compose-env`
- `npm run acceptance:config`

For a local release candidate, also run the full live acceptance suite and
scan the app and agent for both supported architectures. Do not tag it until
the deferred governance and manual production-readiness gates are complete.

## Emergency Owner Recovery

First-run setup remains closed once any user record exists, even if a legacy
database has accidentally disabled every owner. The normal API deliberately
cannot bypass that invariant. If no active owner remains:

1. Back up Postgres and stop the `app` and `worker` services.
2. Generate a bcrypt password hash with the same `bcryptjs` dependency shipped
   in the app image; do not put the plaintext password in shell history.
3. Connect to Postgres as the database operator and, inside one transaction,
   update the chosen existing user to `role = 'owner'`, set `is_active = true`,
   replace `password_hash`, and delete that user's rows from `sessions`.
4. Restart the services, sign in with the temporary password, rotate it through
   the Users screen, and record the recovery in the operator change log.

Never delete all user rows to reopen public setup, and never perform this
procedure while the API or worker can concurrently mutate accounts.
