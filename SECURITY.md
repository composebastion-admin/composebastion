# Security

Report vulnerabilities privately to the repository owner.

## Deployment

- Set a unique `APP_SECRET` (32+ characters) before production use.
- Enable `SECURE_COOKIES=true` behind HTTPS.
- Restrict agent port `8090` to the manager network only.
- Override default Postgres credentials in production.

## Practices

- SSH keys and registry passwords are encrypted at rest.
- Docker operations are allowlisted via typed job actions, not arbitrary shell.
- The optional host agent accepts bearer-authenticated Docker operations only.
- Host metrics from the agent read a fixed `/proc` allowlist and mount stats
  directly; there are no user-controlled file paths and no shell execution.
- Container inspect redacts environment variable values for viewers. Operators,
  admins, and owners can see full env when their role already permits mutation.
- Active session APIs never return token hashes. Revoke operations are scoped to
  the authenticated user's own sessions and are audited.
- Session activity timestamps are throttled to avoid a database write on every
  authenticated request.
