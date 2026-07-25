# ComposeBastion Beta

Beta version: `v1.2.0-beta.1`.

This candidate is published from the normal GitHub repository's `beta` branch.
The app and agent images are available for `linux/amd64` and `linux/arm64`:

- `ghcr.io/composebastion-admin/composebastion-app:beta`
- `ghcr.io/composebastion-admin/composebastion-agent:beta`

The beta channel never moves `latest`, `main`, or stable version tags.

The agent image retains Docker Compose v5.3.1 compatibility while rebuilding
its bundled CLI with gRPC-Go 1.82.1. The manager image also rebuilds its pinned
Trivy 0.72.0 and rclone 1.74.4 binaries from source with gRPC-Go 1.82.1. The
linked-module inventory and third-party notices cover these patched source
builds.

## Install or update the beta

Use the Compose files from the same beta branch:

```bash
curl -fsSLO https://raw.githubusercontent.com/composebastion-admin/composebastion/beta/docker-compose.image.yml
curl -fsSLO https://raw.githubusercontent.com/composebastion-admin/composebastion/beta/.env.example
```

Preserve an existing `.env`. For a new install, copy `.env.example` to `.env`,
generate unique `APP_SECRET` and `POSTGRES_PASSWORD` values, then set:

```dotenv
COMPOSEBASTION_VERSION=beta
COMPOSEBASTION_AGENT_VERSION=beta
```

Update the manager:

```bash
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

For each image-installed agent, use `agent-compose.image.example.yml`, set
`COMPOSEBASTION_AGENT_VERSION=beta`, then pull and recreate that agent.

## What to verify

1. In Deploy, select an SSH host and paste a Git, Compose, or image source.
2. Confirm automatic source detection, Compose selection, project naming,
   ports, storage, variable defaults, warnings, and blockers.
3. Deploy, confirm the source appears in My Library, and confirm the running app
   and advanced deployment details appear in Services.
4. Redeploy the source to another host and confirm removing it from My Library
   does not remove its running containers.
5. For `http://10.0.21.40:3000/kobuslabs/linuxclitogui`, confirm the root
   Compose file is detected and the registry failure is reported as:
   `Docker Prod 1 does not trust HTTP registry 10.0.21.40:3000`.
6. As an owner/admin on a supported passwordless-sudo SSH host, confirm the
   registry repair backs up and merges `daemon.json`, restarts Docker, verifies
   engine health, resumes deployment, and records the audit event.

When reporting feedback, include the analysis and job IDs, Jobs progress,
relevant Audit entry, and screenshots of the compact review or Services drawer.
Do not include tokens, secrets, `.env` contents, or registry passwords.

## Known limitations

- Git analysis initially requires an SSH-connected host. Agent hosts support
  Compose and image inputs and return a Git capability blocker.
- Registry trust automation requires an owner/admin, a supported Linux/systemd
  Docker host, and passwordless sudo. Other hosts receive exact manual steps.
- This is a test channel and includes the pending 1.1.3 hardening work. It is
  not the supported stable release and is not covered by the `latest` tag.

## Roll back

Export a ComposeBastion configuration backup before testing. To return to the
current stable release, set both manager and agent versions to `1.1.2`, pull,
and recreate the services:

```dotenv
COMPOSEBASTION_VERSION=1.1.2
COMPOSEBASTION_AGENT_VERSION=1.1.2
```

Do not run `docker compose down -v`; keep PostgreSQL, Redis, backups, and other
volumes. Migration 031 is additive, so the stable app ignores its new tables
and nullable source link. Keep the backup for restoring encrypted beta source
configuration if you return to the beta later.
