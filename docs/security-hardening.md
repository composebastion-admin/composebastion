# Security Hardening

Use this checklist before exposing ComposeBastion outside a trusted private network.

## Required

- Set a unique `APP_SECRET` with at least 32 characters.
- Set a URL-safe `POSTGRES_PASSWORD`, for example with `openssl rand -hex 32`,
  because image installs interpolate it into `DATABASE_URL`.
- Set `SECURE_COOKIES=true` behind HTTPS.
- Use a reverse proxy that preserves the original client IP only from trusted
  proxy hops.
- Set `CORS_ORIGINS` for any cross-origin UI/API deployment; mutating browser
  requests are rejected when their `Origin` is neither same-host nor configured.
- Restrict agent port `8090` to the manager network.
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

## Regression Checks

- `npm run lint:migrations`
- `npm run openapi:check`
- `npm run typecheck`
- `npm test`
- `npm run smoke:web`
- `npm audit --omit=dev --audit-level=high`

For `v1.0.0`, run CI, CodeQL, Container Scan, Publish Images, and the refreshed
GitHub code-scanning view before tagging the release.
