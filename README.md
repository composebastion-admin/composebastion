# Dockermender

Dockermender is a self-hosted console for managing multiple Docker hosts from
one place. It connects to Linux Docker servers over SSH or an optional host
agent, tracks containers/images/networks/volumes, runs typed Docker operations
through background jobs, and stores recovery artifacts in managed storage.

Current release: `v0.9`.

Canonical repository: [Admin-DockerMender/dockermender](https://github.com/Admin-DockerMender/dockermender)

## First Run

1. Copy `.env.example` to `.env` and set a unique random `APP_SECRET` with at
   least 32 characters.
2. Start the stack:

   ```bash
   docker compose up --build
   ```

3. Open `http://localhost:8080`.
4. Create the first admin user. Demo data is optional during setup.
5. Add Docker hosts using SSH credentials or the Dockermender host agent.

## SSH Host Requirements

Before adding an SSH-backed Docker host, verify the SSH user can run Docker
from a non-interactive SSH session. SSH access alone is not enough.

Required for SSH hosts:

- Docker Engine is installed on the remote host.
- Docker Compose v2 is available as `docker compose`.
- The configured SSH user can run `docker` and `docker compose` without `sudo`.
- The configured SSH user can access the configured Docker socket, usually
  `/var/run/docker.sock`.
- The Docker socket path entered in Dockermender matches the host's real socket
  path.

Common socket-permission fix:

```bash
sudo usermod -aG docker <ssh-user>
```

After changing groups, fully log out and back in, or reboot the host. Confirm
the requirement before adding the host:

```bash
ssh <ssh-user>@<host> 'docker version --format "{{.Server.Version}}" && docker compose version --short && docker ps'
```

If this command fails, fix Docker access before adding the host. If you do not
want to grant SSH users Docker socket access, use the Dockermender host agent
instead.

## Production Deployment

Use the base compose file plus `docker-compose.prod.example.yml` as a starting
point for server deployments. The production override keeps Dockermender behind
your reverse proxy, enables secure cookies, and bind-mounts recovery artifacts
to a clear host directory.

1. Create persistent backup storage:

   ```bash
   sudo mkdir -p /srv/dockermender/backups
   sudo chown -R root:root /srv/dockermender
   sudo chmod 750 /srv/dockermender /srv/dockermender/backups
   ```

2. Generate secrets:

   ```bash
   openssl rand -base64 48
   ```

3. Set production environment values:

   ```bash
   APP_SECRET=<unique value from openssl>
   POSTGRES_PASSWORD=<unique database password>
   DOCKERMENDER_BACKUP_DIR=/srv/dockermender/backups
   BACKUP_ENCRYPTION_ACTIVE_KEY_ID=app_secret
   BACKUP_ENCRYPTION_KEYS=
   BACKUP_HOST_PATH_ALLOWED_ROOTS=
   SECURE_COOKIES=true
   CORS_ORIGINS=https://dockermender.example.com
   ```

4. Validate and start:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.example.yml config
   docker compose -f docker-compose.yml -f docker-compose.prod.example.yml up -d --build
   ```

5. Watch first-start logs and confirm database migrations complete:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.example.yml logs -f app worker
   ```

Recommended first live test order:

1. Add one disposable Docker host.
2. Create a tiny test container with a named volume.
3. Create a recovery point.
4. Restore it as a clone on the same host.
5. Add and test an SMB/rclone or S3 backup target.
6. Test `remote_only` only after target verification succeeds.
7. Test host-to-host clone migration.
8. Test `safe_move` or `warm_move` only after clone restore works.

## Included In v0.9

- Multi-host Docker inventory for containers, images, networks, volumes, and
  Compose stacks.
- SSH and optional host-agent connection modes.
- Typed background jobs for Docker actions, Compose deploys, image pulls,
  registry login, backups, restores, and app migration workflows.
- Services, Containers, Images, Networks, Volumes, Jobs, Audit, Recovery,
  Hosts, Users, Settings, and Operations views.
- Recovery points, recovery profiles, restore drills, migration runs, local
  and remote storage targets, and readiness scoring for app restore confidence.
- Private GitHub repository tracking with encrypted fine-grained read-only token
  storage.
- Custom catalog templates and external self-hosted app discovery.
- Host metrics, host metric alerts, email/webhook notification channels,
  active session management, RBAC, rate limits, origin checks, request IDs, and
  generated OpenAPI artifacts.
- CI coverage for typechecking, migrations, OpenAPI drift, unit/integration
  tests, browser smoke tests, production compose validation, and Docker image
  builds.

## Repository Rules

- The canonical repository is `https://github.com/Admin-DockerMender/dockermender`.
- Pushes, tags, releases, and version updates must use the `admin-dockermender`
  GitHub account.
- `v0.9` is the first public version for this repository.
- Do not reintroduce old personal owner, repository, image, or user fixtures.

## SSH Integration Test

CI starts a disposable SSH Docker host fixture and runs the SSH integration test
automatically. The fixture uses `infra/dev/sshhost.Dockerfile`, injects a
short-lived public key at container startup, and mounts the runner Docker socket
so the test exercises the same SSH + Docker CLI path as a real host.

To run the same test against a real SSH Docker host, set these variables:

```bash
DOCKERMENDER_SSH_TEST_HOST=192.0.2.10
DOCKERMENDER_SSH_TEST_USER=dockeradmin
DOCKERMENDER_SSH_TEST_KEY="$(cat ~/.ssh/id_ed25519)"
DOCKERMENDER_SSH_TEST_PORT=22
```

Then run `npm test`. The test verifies SSH connectivity plus Docker Engine and
Compose availability.

For GitHub Actions real-host coverage, set repository variable
`DOCKERMENDER_RUN_EXTERNAL_SSH_TESTS=true` and add these repository secrets:

- `DOCKERMENDER_SSH_TEST_HOST`
- `DOCKERMENDER_SSH_TEST_USER`
- `DOCKERMENDER_SSH_TEST_KEY`
- `DOCKERMENDER_SSH_TEST_PORT` (optional, defaults to `22`)
- `DOCKERMENDER_SSH_TEST_KEY_PASSPHRASE` (optional)

## Host Agent

For hosts where you prefer an agent over SSH, deploy the agent with
`agent-compose.example.yml`, set a long `AGENT_TOKEN`, expose port `8090` only
to the manager network, and add the host in Dockermender using connection mode
`Host agent`.

## Safety Notes

- SSH private keys, registry passwords, GitHub tokens, and backup target secrets
  are encrypted with `APP_SECRET` before storage.
- Production startup refuses the documented default `APP_SECRET`.
- API responses include security headers, auth endpoints are rate-limited,
  credentialed CORS is limited to same-origin plus configured `CORS_ORIGINS`,
  and unsafe browser mutations are origin-checked.
- The app creates typed Docker commands instead of accepting arbitrary host
  shell commands.
- The host agent accepts bearer-authenticated Dockermender Docker commands only;
  expose it only to the manager network.
- The host agent's metrics endpoint reads a fixed `/proc` allowlist and mount
  stats directly; it does not expose shell execution or arbitrary file reads.
- Container inspect masks environment values for viewers because env entries
  often contain secrets. Operators, admins, and owners can still see full
  inspect env.
- Active sessions never expose token hashes; revocation is scoped to the
  signed-in user and session activity writes are throttled.
- Backups are written under `BACKUP_DIR` and path-checked before use.
- Put the app behind HTTPS when exposing it outside a private network.
