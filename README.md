<p align="center">
  <img src="apps/web/public/brand/composebastion-lockup.svg" alt="ComposeBastion" width="420">
</p>

<h1 align="center">ComposeBastion</h1>

<p align="center">
  A self-hosted control room for Docker hosts, Compose apps, recovery points,
  GitHub deploys, alerts, and day-two operations.
</p>

<p align="center">
  <a href="https://github.com/composebastion-admin/composebastion/releases"><img alt="Release" src="https://img.shields.io/badge/release-v0.9.7-e0a23f"></a>
  <a href="https://github.com/composebastion-admin/composebastion/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/composebastion-admin/composebastion/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/composebastion-admin/composebastion/pkgs/container/composebastion-app"><img alt="Container image" src="https://img.shields.io/badge/ghcr.io-composebastion--app-2496ed"></a>
  <a href="LICENSE.md"><img alt="License" src="https://img.shields.io/badge/license-source--available-df7d27"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D20.11-3f7f5f">
  <img alt="Docker" src="https://img.shields.io/badge/docker-compose-2496ed">
</p>

ComposeBastion gives you one private web console for operating multiple Docker
servers. Add hosts over SSH or the optional host agent, see what is running,
deploy Compose apps from GitHub, create recovery points, test restores, and keep
operators out of raw shell work for routine actions.

ComposeBastion can be installed either from published container images or from a
full source checkout. The published image path is the simplest option for NAS
devices, Proxmox Docker VMs/LXCs, Portainer stacks, and any native Docker host on
`linux/amd64` or `linux/arm64`.

## Product Screenshots

![ComposeBastion fleet dashboard](docs/assets/screenshots/dashboard-overview.png)

| Services and recovery | Containers and image cleanup |
|-----------------------|------------------------------|
| ![Services inventory with source tracking and update status](docs/assets/screenshots/services-inventory.png) | ![Container inventory with live usage, web links, and console actions](docs/assets/screenshots/containers-console.png) |
| ![Recovery Center with completed, partial, and failed recovery points](docs/assets/screenshots/recovery-center.png) | ![Image cleanup preview with removable and blocked image candidates](docs/assets/screenshots/images-cleanup.png) |

| Deploy and operations | Security and observability |
|-----------------------|----------------------------|
| ![Tracked GitHub repositories ready for branch checks and deploys](docs/assets/screenshots/github-deploy.png) | ![Host metrics across the demo fleet](docs/assets/screenshots/host-metrics.png) |
| ![Built-in and custom app catalog templates](docs/assets/screenshots/catalog-templates.png) | ![Alert rules, silences, and notification history](docs/assets/screenshots/alerts-rules-history.png) |

| Recovery workflows | Admin controls |
|--------------------|----------------|
| ![App migration planning and execution options](docs/assets/screenshots/recovery-move.png) | ![Operations dashboard with readiness, backup health, and failed job guidance](docs/assets/screenshots/admin-operations.png) |
| ![Recovery backup storage targets](docs/assets/screenshots/backup-storage.png) | ![Users, sessions, and host settings](docs/assets/screenshots/users-and-sessions.png) |

## Install In 5 Minutes

Prerequisites: Docker Engine, Docker Compose v2, and OpenSSL. Git is only needed
for the source-build install.

### Option A: Pull The Published Image

```bash
mkdir -p composebastion
cd composebastion
curl -fsSLO https://raw.githubusercontent.com/composebastion-admin/composebastion/main/docker-compose.image.yml
curl -fsSLO https://raw.githubusercontent.com/composebastion-admin/composebastion/main/.env.example
cp .env.example .env
```

Edit `.env` and set at least:

```bash
APP_SECRET=<unique random value from: openssl rand -base64 48>
POSTGRES_PASSWORD=<URL-safe database password from: openssl rand -hex 32>
```

Start ComposeBastion:

```bash
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

Open `http://localhost:8080`, create the first owner account, and choose
`Include demo workspace` if you want a ready-made showcase. The demo seeds
multiple hosts, Compose apps, GitHub deployments, alerts, backups, recovery
points, storage targets, image scans, migration runs, and catalog templates.
You can remove it later like any other demo data.

For production installs with a reverse proxy and persistent backup storage, use
the [installation guide](docs/installation.md).

Use the published image install for NAS devices, Proxmox Docker VMs/LXCs,
Portainer stacks, and home servers. Use the source build only when you are
developing ComposeBastion or intentionally customizing the checkout.

Published images:

- `ghcr.io/composebastion-admin/composebastion-app`
- `ghcr.io/composebastion-admin/composebastion-agent`

Main builds publish `latest`, branch tags, and `sha-*` tags. Release tags
publish immutable version tags such as `0.9.7` and `v0.9.7`. Use `latest` for
simple homelab/NAS updates, or pin a version in `.env` for controlled
production upgrades.

### Option B: Build From Source

```bash
git clone https://github.com/composebastion-admin/composebastion.git
cd composebastion
cp .env.example .env
```

Set `APP_SECRET` and `POSTGRES_PASSWORD` in `.env`, then start:

```bash
docker compose up -d --build
```

## Update Commands

Image install:

```bash
cd ~/composebastion
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

Source install:

```bash
cd ~/composebastion
git pull --ff-only
docker compose up -d --build app worker
```

## Why Operators Use It

| Need | ComposeBastion gives you |
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

## Product Demo Workspace

For screenshots, sales demos, or first-run evaluation, seed the demo workspace
during owner setup. It creates a full synthetic environment with online SSH and
agent hosts, a recovery target, stateful app stacks, source links, image update
intelligence, vulnerability scan summaries, alert history, backup schedules,
recovery drills, and migration examples. Demo hosts are tagged `demo` and use
simulated Docker actions, so you can click through workflows without needing
three real servers.

| GitHub deploy tracking | Catalog templates |
|------------------------|-------------------|
| ![Tracked GitHub repositories ready for branch checks and deploys](docs/assets/screenshots/github-deploy.png) | ![Built-in and custom app catalog templates](docs/assets/screenshots/catalog-templates.png) |

| Hosts and files | Images and updates |
|-----------------|--------------------|
| ![Demo host inventory with SSH and agent connection modes](docs/assets/screenshots/hosts-inventory.png) | ![Image inventory and scanner status](docs/assets/screenshots/images-inventory.png) |
| ![Host file browser for Compose folders](docs/assets/screenshots/host-files.png) | ![Image update intelligence with affected services](docs/assets/screenshots/image-updates.png) |

The full screenshot tour is in the [how-to guide](docs/how-to.md).

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
  `/srv/composebastion/backups`.
- Put ComposeBastion behind HTTPS and set `SECURE_COOKIES=true`.
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
- Image-only install files and published GHCR images for NAS devices, Proxmox
  Docker guests, Portainer stacks, and native Docker hosts on `linux/amd64` or
  `linux/arm64`.
- v0.9 config backup/restore for hosts, tracked repos, registries, alerts, users,
  Compose stacks, recovery schedules, storage targets, and operator settings.

## Repository Rules

- Canonical repository: `https://github.com/composebastion-admin/composebastion`.
- Pushes, tags, releases, and version updates must use the
  `composebastion-admin` GitHub account.
- `v0.9` is the first public release line for this repository; do not promote to
  `v1.0` until the stable-release checklist is complete.
- Do not reintroduce personal owner, repository, image, or user fixtures.

## License

ComposeBastion is source-available, not open source. Free use is allowed for home
labs, home use, private use, personal learning, and private non-commercial
testing.

Business, company, employer, client, customer, MSP, SaaS, hosted, government,
school, nonprofit, production, non-production, testing, staging,
proof-of-concept, evaluation, or organizational use requires prior written
approval or a purchased license.

Public forks, mirrors, republished copies, public derivative projects, package
republishing, and container image republishing require prior written approval or
a purchased license.

See [LICENSE.md](LICENSE.md), [LICENSING_SUMMARY.md](LICENSING_SUMMARY.md), and
[COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md). Third-party dependency notices
are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

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
