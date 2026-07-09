# Opt-in Container Hardening

ComposeBastion `1.1` includes optional Compose overlays that make the manager
and agent containers more restrictive. They are not enabled by default in this
release so existing NAS, bind-mount, and Docker-socket installations keep their
current behavior.

## Manager app and worker

The manager overlay runs the app and worker with a configurable numeric
UID/GID, a read-only root filesystem, all Linux capabilities dropped,
`no-new-privileges`, and an init process. `/tmp`, backup storage, and a dedicated
Trivy cache volume remain writable.

The default UID/GID is `1000:1000`. Before enabling it for an image install,
make the backup directory writable by the selected identity:

```bash
export COMPOSEBASTION_UID=1000
export COMPOSEBASTION_GID=1000
sudo install -d -m 0750 \
  -o "${COMPOSEBASTION_UID}" -g "${COMPOSEBASTION_GID}" \
  /srv/composebastion/backups
```

Then validate and start the image installation with the overlay last:

```bash
docker compose \
  -f docker-compose.image.yml \
  -f docker-compose.hardened.yml \
  config
docker compose \
  -f docker-compose.image.yml \
  -f docker-compose.hardened.yml \
  up -d
```

For source builds, apply it after both source Compose files:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.example.yml \
  -f docker-compose.hardened.yml \
  up -d --build
```

Empty named volumes inherit the image's default `1000:1000` ownership. If you
change `COMPOSEBASTION_UID` or `COMPOSEBASTION_GID`, prepare the project Trivy
cache volume once before startup:

```bash
docker volume create composebastion_trivy-cache
docker run --rm --user root \
  -v composebastion_trivy-cache:/cache \
  alpine:3.20.8@sha256:765942a4039992336de8dd5db680586e1a206607dd06170ff0a37267a9e01958 \
  chown -R "${COMPOSEBASTION_UID}:${COMPOSEBASTION_GID}" /cache
```

Adjust the volume name when the Compose project name is not `composebastion`.
Do not enable the overlay until both backup and cache paths are writable by the
configured identity.

## Host agent

Apply the agent overlay after either agent Compose file:

```bash
docker compose \
  -f agent-compose.image.example.yml \
  -f agent-compose.hardened.yml \
  up -d
```

The overlay adds a read-only root filesystem, drops all capabilities, enables
`no-new-privileges` and init, and persists agent-managed files in a dedicated
volume mounted at `/tmp/composebastion`. It also sets `HOME` to that directory
and `DOCKER_CONFIG` to `/tmp/composebastion/.docker`, so Docker registry logins
survive an agent container recreation. Protect that volume as credential-bearing
runtime state and remove it when decommissioning the agent.

The agent deliberately remains root. Mounting `/var/run/docker.sock` gives a
container host-root-equivalent control through the Docker API regardless of its
Linux UID or capability set. Restrict port `8090`, use a long unique agent
token, protect the manager-to-agent network, and treat anyone able to replace
the agent image or call its authenticated API as a host administrator.

## Verification

After startup, confirm the manager can write backup and scanner-cache data and
the agent can run Docker commands. Install the local Chromium test browser once
with `npx playwright install chromium`. The local acceptance harness performs
these checks, verifies that root filesystems reject writes, performs a real
registry login, and recreates the agent to prove both files and Docker credentials
under `/tmp/composebastion` persist:

```bash
npm run acceptance:local
```
