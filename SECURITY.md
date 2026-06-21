# Security Policy

Please do not publicly disclose security vulnerabilities before they have been
reviewed.

Preferred reporting path:

- Use GitHub private vulnerability reporting if it is enabled for
  `composebastion-admin/composebastion`.
- If private reporting is not available, open a minimal public Security Report
  issue and ask for a private contact path before sharing sensitive details:
  https://github.com/composebastion-admin/composebastion/issues

Do not include secrets, credentials, customer data, exploit details for active
systems, or confidential commercial information in public issues. Ask for a
private contact path before sharing sensitive details.

Include:

- affected version or commit;
- description of the issue;
- reproduction steps;
- potential impact;
- any suggested mitigation.

We will review reports as soon as practical.

## Supported Versions

ComposeBastion is still pre-1.0. Security fixes are expected to target the
current `main` branch and the latest public release unless a separate written
support agreement applies.

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

## Security Gates

- Treat CodeQL, dependency review, `npm audit`, container/image scans, secret
  scanning, and image publishing checks as release gates when configured.
- Scanner findings may remain visible until the protected or target branch is
  rescanned. A fix is not fully cleared in GitHub until the relevant branch scan
  refreshes.
- Prefer narrow suppressions with clear comments only for confirmed false
  positives or protocol-required compatibility. Do not broadly hide or blanket
  ignore scanner findings.
- Dependency and container updates from Dependabot should be reviewed as normal
  release-impact changes, not assumed to be release failures.
