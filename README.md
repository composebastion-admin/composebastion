<p align="center">
  <img src="apps/web/public/brand/dockermender-lockup.svg" alt="Dockermender" width="420">
</p>

<h1 align="center">Dockermender</h1>

<p align="center">
  A self-hosted control room for Docker hosts, Compose apps, recovery points,
  GitHub deploys, alerts, and day-two operations.
</p>

<p align="center">
  <a href="https://github.com/Admin-DockerMender/dockermender/releases/tag/v0.9"><img alt="Release" src="https://img.shields.io/badge/release-v0.9-e0a23f"></a>
  <a href="https://github.com/Admin-DockerMender/dockermender/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Admin-DockerMender/dockermender/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20.11-3f7f5f">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ed">
</p>

Dockermender gives you one private web console for operating multiple Docker
servers. Add hosts over SSH or the optional host agent, see what is running,
deploy Compose apps from GitHub, create recovery points, test restores, and keep
operators out of raw shell work for routine actions.

## Install In 5 Minutes

Prerequisites: Docker Engine, Docker Compose v2, Git, and OpenSSL.

```bash
git clone https://github.com/Admin-DockerMender/dockermender.git
cd dockermender
cp .env.example .env
```

Edit `.env` and set at least:

```bash
APP_SECRET=<unique random value from: openssl rand -base64 48>
POSTGRES_PASSWORD=<unique database password>
```

Start Dockermender:

```bash
docker compose up -d --build
```

Open `http://localhost:8080`, create the first owner account, and add your first
Docker host.

For production installs with a reverse proxy and persistent backup storage, use
the [installation guide](docs/installation.md).

## Why Operators Use It

| Need | Dockermender gives you |
|------|------------------------|
| Multi-host visibility | Containers, images, networks, volumes, Compose stacks, host metrics, and job history across all connected hosts. |
| Safer Docker actions | Typed jobs for start, stop, restart, remove, pull, prune, deploy, backup, restore, and migration workflows. |
| GitHub deploys | Track private or public GitHub Compose repositories with encrypted read-only tokens, branch discovery, preview, deploy, and redeploy. |
| Recovery confidence | Recovery points, storage targets, readiness scoring, restore drills, profiles, clone restores, and migration runs. |
| Team operations | Owner/admin/operator/viewer roles, active sessions, audit logs, request IDs, rate limits, and alert history. |
| Practical security | Encrypted secrets, origin checks, credentialed CORS controls, Docker-only agent endpoints, and viewer-safe inspect output. |

## Core Workflows

1. Add a Docker host over SSH or the host agent.
2. Review inventory in Services, Containers, Images, Networks, and Volumes.
3. Deploy or track Compose apps from GitHub.
4. Create recovery points and run clone-only restore drills.
5. Watch Admin -> Operations for worker health, backup health, and failed jobs.
6. Add alert channels and metric thresholds for the services that matter.

## Guides

- [Installation and production setup](docs/installation.md)
- [Connect Docker hosts](docs/connect-hosts.md)
- [Deploy Compose apps from GitHub](docs/deploy-from-github.md)
- [Recovery, backups, and restore drills](docs/recovery-guide.md)
- [Daily operations runbook](docs/operations-runbook.md)
- [Security hardening checklist](docs/security-hardening.md)
- [API contract notes](docs/api-contracts.md)
- [OpenAPI summary](docs/openapi.md)

## Production Checklist

- Use a unique `APP_SECRET` and `POSTGRES_PASSWORD`.
- Mount recovery storage outside the container, for example
  `/srv/dockermender/backups`.
- Put Dockermender behind HTTPS and set `SECURE_COOKIES=true`.
- Set `CORS_ORIGINS` when the UI and API are served from different origins.
- Restrict agent port `8090` to the manager network.
- Configure `BACKUP_HOST_PATH_ALLOWED_ROOTS` for production host-path recovery.
- Test at least one recovery point, verify, and clone restore drill before
  relying on a backup target.

## What Ships In v0.9

- Multi-host Docker inventory and management.
- SSH and optional host-agent connection modes.
- Compose deploys, GitHub repository tracking, branch checks, and redeploy jobs.
- Recovery points, recovery profiles, storage targets, restore drills, readiness
  scoring, and migration workflows.
- Host metrics, host metric alerts, email/webhook notifications, alert silences,
  and alert history.
- RBAC, active session management, audit events, route rate limits, request IDs,
  generated OpenAPI docs, and CI gates.

## Repository Rules

- Canonical repository: `https://github.com/Admin-DockerMender/dockermender`.
- Pushes, tags, releases, and version updates must use the
  `admin-dockermender` GitHub account.
- `v0.9` is the first public version for this repository.
- Do not reintroduce old personal owner, repository, image, or user fixtures.

## Development

```bash
npm install
npm run typecheck
npm test
npm run smoke:web
```

Useful checks:

```bash
npm run lint:migrations
npm run openapi:check
npm audit --omit=dev --audit-level=high
```
