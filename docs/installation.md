# Installation Guide

This guide gets Dockermender running locally first, then hardens it for a
server deployment.

## Requirements

- Linux host or VM for the Dockermender manager.
- Docker Engine and Docker Compose v2.
- Git.
- OpenSSL for generating secrets.
- Network access from the manager to each Docker host you plan to manage.

## Quick Local Install

Clone the repository:

```bash
git clone https://github.com/Admin-DockerMender/dockermender.git
cd dockermender
cp .env.example .env
```

Generate secrets:

```bash
openssl rand -base64 48
openssl rand -base64 32
```

Edit `.env`:

```bash
APP_SECRET=<first generated value>
POSTGRES_PASSWORD=<second generated value>
```

Start the stack:

```bash
docker compose up -d --build
```

Open `http://localhost:8080`, create the first owner account, then add a Docker
host.

Useful commands:

```bash
docker compose ps
docker compose logs -f app worker
docker compose down
```

## Production Install

Create a persistent backup directory on the manager host:

```bash
sudo mkdir -p /srv/dockermender/backups
sudo chown -R root:root /srv/dockermender
sudo chmod 750 /srv/dockermender /srv/dockermender/backups
```

Set production environment values in `.env`:

```bash
APP_SECRET=<unique random value>
POSTGRES_PASSWORD=<unique database password>
DOCKERMENDER_BACKUP_DIR=/srv/dockermender/backups
SECURE_COOKIES=true
CORS_ORIGINS=https://dockermender.example.com
BACKUP_HOST_PATH_ALLOWED_ROOTS=/srv,/home/docker
```

Validate the production Compose configuration:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml config
```

Start production mode:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml up -d --build
```

Watch startup:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml logs -f app worker
```

## Reverse Proxy Notes

Dockermender listens on `8080` in the base Compose file. In production, the
override removes the public port binding so your reverse proxy can be the only
public entry point.

Your proxy should:

- Terminate HTTPS.
- Forward HTTP traffic to the `app` service on port `8080`.
- Preserve websocket upgrades for the host terminal route.
- Preserve standard forwarding headers.

Set `SECURE_COOKIES=true` only when the browser reaches Dockermender through
HTTPS.

## First Live Test

1. Add one disposable Docker host.
2. Create a small test container with a named volume.
3. Create a recovery point.
4. Run a restore drill.
5. Restore the point as a clone.
6. Add an SMB/rclone or S3 backup target.
7. Repeat the verify and clone restore flow using that target.

## Updating

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.example.yml logs -f app worker
```

Before updating a production deployment, export a config backup from
Admin -> Settings and confirm recent recovery points are usable.
