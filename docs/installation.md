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
- Node.js 24 and npm 11.19 or newer within npm 11 when running source or
  release checks outside the provided Docker build.

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

The most recent published stable release is `v1.1.4`.

- App image: `ghcr.io/composebastion-admin/composebastion-app`
- Agent image: `ghcr.io/composebastion-admin/composebastion-agent`
- Exact release tags: `1.1.4` and `v1.1.4`
- Beta test tag: `beta` for both app and agent; see
  [ComposeBastion Beta](beta-release.md).
- Moving `main` alias, stable-only `latest`, and full-commit `sha-*` indexes

Use `main` only when you intentionally test protected-branch candidates.

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
DATABASE_URL=
COMPOSEBASTION_VERSION=latest
COMPOSEBASTION_BACKUP_DIR=/srv/composebastion/backups
# Trusted direct-HTTP evaluation only; keep true when using HTTPS.
SECURE_COOKIES=false
```

The literal placeholder copied from `.env.example` is intentionally rejected
in production; replace it with the generated `APP_SECRET` before starting.
Leave `DATABASE_URL` blank for a new Compose-managed database. A non-empty value
is an advanced/external-database or existing-install compatibility override and
takes precedence for `app` and `worker`.

The app and worker images run as numeric UID/GID `1000:1000`. The one-shot
`storage-init` service runs before both services and safely brings an existing
backup tree to that identity. Pre-creating the bind-mounted directory remains
recommended so its host-side location and mode are explicit:

```bash
sudo install -d -m 0750 -o 1000 -g 1000 /srv/composebastion/backups
```

If the directory or historical recovery files are root-owned, `storage-init`
repairs them automatically without deleting or rewriting backup contents. It
fails closed with an actionable log if the mount cannot be prepared, such as a
root-squashed remote filesystem.

The companion `database-init` one-shot preserves real explicit/external URLs.
For only the exact repository-managed legacy URL, it verifies
`POSTGRES_PASSWORD` and rotates the old managed role credential when required
before the app and worker start.

Start the stack:

```bash
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

Open `http://<manager-ip>:8080`, create the first owner account, then add a
Docker host. The `SECURE_COOKIES=false` setting is only for this trusted
direct-HTTP evaluation path; do not expose it to an untrusted network, and set
it back to `true` when HTTPS is configured. For production change control,
resolve one reviewed release record to its full commit and pin
`COMPOSEBASTION_VERSION` to the corresponding
`sha-<40-character-sha>` index instead of `latest` or a moving version alias.
For a deployment that also runs the agent, pin both images to that same
revision. App and agent moving aliases live in separate GHCR repositories and
cannot change atomically.

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
DATABASE_URL=
```

The literal placeholder copied from `.env.example` is intentionally rejected
in production; replace it with the generated `APP_SECRET` before starting.
Leave `DATABASE_URL` blank for a new Compose-managed database.

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
sudo install -d -m 0750 -o 1000 -g 1000 /srv/composebastion/backups
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

The manager image is non-root by default. To add a read-only root filesystem,
dropped capabilities, and the other optional controls, follow the
[container hardening guide](container-hardening.md). Prepare bind-mount
ownership before changing the overlay's `COMPOSEBASTION_UID` or
`COMPOSEBASTION_GID`.

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

The supported pre-1.2 route is `1.0.6/1.1.2/1.1.3 -> 1.1.4 -> 1.2`. Select the
`1.1.4` bridge first and verify it is healthy; only then target 1.2. The bridge
keeps the existing Compose file, performs compatibility work through the pulled
candidate, and starts app/worker with dependency recreation disabled. Direct
pre-1.2-to-1.2 updates are not release-qualified. Manual updates require the
matching target-release Compose file and `scripts/upgrade-image.sh`.

Following `latest` is a homelab convenience, not the production-qualified
paired update path. Until self-update consumes a durable signed app/agent
release-pair manifest, production updates must resolve one reviewed release
revision and pin every participating image to its `sha-<40-character-sha>`
index before pulling.

Use the manual commands below when the manager host is not managed over SSH,
when running a source checkout, or when you want to inspect each step yourself.

For an existing image install, save the reviewed target files under distinct
names and run the target release's wrapper:

```bash
cd ~/composebastion
chmod 755 upgrade-image.target.sh
./upgrade-image.target.sh --version 1.2.0 \
  --compose docker-compose.image.yml docker-compose.image.target.yml
```

Repeat `--compose CURRENT TARGET` for each overlay. The wrapper promotes the
target definitions only after candidate verification and performs
credential-first immutable rollback on failure. Keep its recovery directory if
the outcome says rollback is incomplete.

For a fresh install, or an update known not to involve a legacy transition, the
ordinary Compose startup remains:

```bash
cd ~/composebastion
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

## Updating Source Installs

```bash
cd ~/composebastion
git pull --ff-only
npm ci
npm run upgrade:source
```

The wrapper preserves the running app/worker image IDs, runs the same 1.2
compatibility preparation as image updates, verifies the built candidate, and
uses an immutable `--no-deps` rollback overlay on failure. It leaves the Git
checkout unchanged and reports the exact source-revision rollback command.

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
