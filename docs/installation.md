# Installation Guide

This guide gets ComposeBastion running locally first, then hardens it for a
server deployment.

## Requirements

- Linux host, VM, NAS app platform, or Proxmox Docker guest for the
  ComposeBastion manager.
- Docker Engine and Docker Compose v2.
- OpenSSL for generating secrets.
- Network access from the manager to each Docker host you plan to manage.
- Git only when building from source.

The published images support `linux/amd64` and `linux/arm64`, which covers most
Proxmox Docker VMs, Synology/QNAP-style NAS devices with native Docker support,
Unraid, TrueNAS SCALE Docker-compatible setups, and standard Linux servers.
Older ARMv7 NAS devices are not a release target unless Docker, Compose v2, and
the base images all support the device.

## Which Install Should I Use?

- Use the image install for NAS devices, Proxmox Docker VMs/LXCs, Portainer
  stacks, home servers, and normal production hosts.
- Use the source build install when developing ComposeBastion or intentionally
  customizing the repository checkout.
- Use the agent image install on remote Docker hosts that should report
  heartbeats, live logs, host stats, and run queued Docker work locally.

## Current Published Release

The most recent published stable release is `v1.0.6`, but its embedded scanner
is superseded for production readiness by the pending `1.0.7` remediation. It
is not being presented as the latest verified production release.

- App image: `ghcr.io/composebastion-admin/composebastion-app`
- Agent image: `ghcr.io/composebastion-admin/composebastion-agent`
- Exact release tags: `1.0.6` and `v1.0.6`
- Moving `main` alias, stable-only `latest`, and full-commit `sha-*` indexes

Existing `1.0.6` installations may remain pinned while preparing an upgrade,
but new production installs should wait for the verified `1.0.7` release. Use
`main` only when you intentionally test protected-branch candidates.

Runtime app and agent images include ComposeBastion license, notice, trademark,
and third-party notice files under `/licenses`.

## Image Install

Use this path when you want to run ComposeBastion without cloning or building the
full repository.

Download the image Compose file and environment template:

```bash
mkdir -p composebastion
cd composebastion
curl -fsSLO https://raw.githubusercontent.com/composebastion-admin/composebastion/main/docker-compose.image.yml
curl -fsSLO https://raw.githubusercontent.com/composebastion-admin/composebastion/main/.env.example
cp .env.example .env
```

Generate secrets:

```bash
openssl rand -base64 48 # APP_SECRET
openssl rand -hex 32    # POSTGRES_PASSWORD, URL-safe for DATABASE_URL
```

Edit `.env`:

```bash
APP_SECRET=<first generated value>
POSTGRES_PASSWORD=<second generated value>
COMPOSEBASTION_VERSION=latest
COMPOSEBASTION_BACKUP_DIR=/srv/composebastion/backups
# Trusted direct-HTTP evaluation only; keep true when using HTTPS.
SECURE_COOKIES=false
```

The literal placeholder copied from `.env.example` is intentionally rejected
in production; replace it with the generated `APP_SECRET` before starting.

Start the stack:

```bash
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

Open `http://<manager-ip>:8080`, create the first owner account, then add a
Docker host. The `SECURE_COOKIES=false` setting is only for this trusted
direct-HTTP evaluation path; do not expose it to an untrusted network, and set
it back to `true` when HTTPS is configured. For production change control, pin
`COMPOSEBASTION_VERSION` to a release tag such as `1.0.6` instead of `latest`.

## Source Build Install

Clone the repository:

```bash
git clone https://github.com/composebastion-admin/composebastion.git
cd composebastion
cp .env.example .env
```

Generate secrets:

```bash
openssl rand -base64 48 # APP_SECRET
openssl rand -hex 32    # POSTGRES_PASSWORD, URL-safe for DATABASE_URL
```

Edit `.env`:

```bash
APP_SECRET=<first generated value>
POSTGRES_PASSWORD=<second generated value>
```

The literal placeholder copied from `.env.example` is intentionally rejected
in production; replace it with the generated `APP_SECRET` before starting.

Start the stack:

```bash
docker compose up -d --build
```

Open `http://localhost:8080`, create the first owner account, then add a Docker
host. For evaluation or a guided product tour, enable `Include demo workspace`
during owner setup. It seeds demo-tagged hosts, apps, alerts, backups, recovery
points, image intelligence, migration history, and catalog templates that use
simulated Docker actions.

Useful commands:

```bash
docker compose ps
docker compose logs -f app worker
docker compose down
```

## NAS And Proxmox Notes

- Use `docker-compose.image.yml` for NAS devices, Portainer stacks, and Proxmox
  guests where building from source is slow or storage-constrained.
- Store `COMPOSEBASTION_BACKUP_DIR` on persistent NAS or VM storage, not inside a
  temporary container filesystem.
- On Proxmox, prefer a small Docker VM. LXC can work only when Docker is already
  functioning correctly in that container with nesting and storage configured.
- If using a reverse proxy, keep `COMPOSEBASTION_HTTP_PORT` bound only to the
  trusted LAN or proxy network and keep the production `SECURE_COOKIES=true`
  default.
- Managed hosts still need native Docker support. SSH mode requires `docker`,
  `docker compose`, and Docker socket access for the configured SSH user.

## Production Install

Create a persistent backup directory on the manager host:

```bash
sudo mkdir -p /srv/composebastion/backups
sudo chown -R root:root /srv/composebastion
sudo chmod 750 /srv/composebastion /srv/composebastion/backups
```

Set production environment values in `.env`:

```bash
APP_SECRET=<unique random value>
POSTGRES_PASSWORD=<URL-safe database password from: openssl rand -hex 32>
COMPOSEBASTION_BACKUP_DIR=/srv/composebastion/backups
COMPOSEBASTION_HTTP_BIND_ADDRESS=127.0.0.1
SECURE_COOKIES=true
CORS_ORIGINS=https://composebastion.example.com
BACKUP_HOST_PATH_ALLOWED_ROOTS=/srv,/home/docker
```

Validate the production Compose configuration:

```bash
docker compose -f docker-compose.image.yml config
```

Start production mode from published images:

```bash
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

If you are building from source instead, validate and start with:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml config
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml up -d --build
```

Watch startup:

```bash
docker compose -f docker-compose.image.yml logs -f app worker
```

## Reverse Proxy Notes

The published-image Compose file binds port `8080` to
`COMPOSEBASTION_HTTP_BIND_ADDRESS` (`0.0.0.0` by default for quick-start
compatibility). Set it to `127.0.0.1` for a reverse proxy on the manager host,
or to a trusted LAN address when the proxy is external. The source production
override resets the host port entirely, so a Compose-network proxy can be the
only entry point.

Your proxy should:

- Terminate HTTPS.
- Forward HTTP traffic to the `app` service on port `8080`.
- Preserve websocket upgrades for the host terminal route.
- Preserve standard forwarding headers.

Production Compose renders use `SECURE_COOKIES=true` by default. Set it to
`false` explicitly only for a trusted direct-HTTP evaluation; secure cookies
require the browser-facing URL to use HTTPS.

## First Live Test

1. Add one disposable Docker host.
2. Create a small test container with a named volume.
3. Create a recovery point.
4. Run a restore drill.
5. Restore the point as a clone.
6. Add an SMB or S3 backup target.
7. Repeat the verify and clone restore flow using that target.

## Updating Image Installs

Image installs can be updated in-app from Admin -> Operations ->
ComposeBastion self-update. Configure the manager host as the SSH-mode host
that runs ComposeBastion, set the Compose directory and file, choose `latest`
or a pinned release tag, then start the update handoff. The app writes
`.composebastion-self-update.sh` and `.composebastion-self-update.log` in the
Compose directory, starts the script detached from the worker, pulls the app and
worker images, and restarts those services. The browser may disconnect briefly
while the new app container starts.

Use the manual commands below when the manager host is not managed over SSH,
when running a source checkout, or when you want to inspect each step yourself.

For homelab/NAS installs following `latest`:

```bash
cd ~/composebastion
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

For pinned production installs, edit `COMPOSEBASTION_VERSION` in `.env`, then
run:

```bash
cd ~/composebastion
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

## Updating Source Installs

```bash
cd ~/composebastion
git pull --ff-only
docker compose up -d --build app worker
```

Before updating a production deployment, export a config backup from
Admin -> Settings and confirm recent recovery points are usable.

## Release Verification

Before tagging or upgrading a production deployment, run:

```bash
RELEASE_APP_SECRET="$(openssl rand -hex 32)"
RELEASE_AGENT_TOKEN="$(openssl rand -hex 32)"
RELEASE_POSTGRES_PASSWORD="$(openssl rand -hex 32)"
npm run typecheck
npm run lint:migrations
npm run openapi:check --workspace @composebastion/api
npm test
npm run smoke:web
npm audit --audit-level=high
POSTGRES_PASSWORD="${RELEASE_POSTGRES_PASSWORD}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  docker compose config
POSTGRES_PASSWORD="${RELEASE_POSTGRES_PASSWORD}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  docker compose -f docker-compose.image.yml config
POSTGRES_PASSWORD="${RELEASE_POSTGRES_PASSWORD}" \
  APP_SECRET="${RELEASE_APP_SECRET}" \
  docker compose -f docker-compose.yml -f docker-compose.prod.example.yml config
AGENT_TOKEN="${RELEASE_AGENT_TOKEN}" \
  COMPOSEBASTION_AGENT_BIND_ADDRESS=127.0.0.1 \
  docker compose -f agent-compose.image.example.yml config
```

These validation credentials exist only in the current shell. Generate a new
set for every run, and never print, persist, or commit them.
