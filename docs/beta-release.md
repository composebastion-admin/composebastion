# ComposeBastion 1.2 Beta Archive

Historical beta version: `v1.2.0-beta.3`.

This page records the final prerelease candidate that preceded stable `v1.2.0`.
It is retained for historical test and rollback evidence, not as current
installation guidance. The app and agent images were published for
`linux/amd64` and `linux/arm64`:

- `ghcr.io/composebastion-admin/composebastion-app:beta`
- `ghcr.io/composebastion-admin/composebastion-agent:beta`
- `ghcr.io/composebastion-admin/composebastion-app:1.2.0-beta.3`
- `ghcr.io/composebastion-admin/composebastion-agent:1.2.0-beta.3`

The `beta` channel is moving. Each exact prerelease version is immutable and
never moves `latest`, `main`, or stable/minor version tags.

The agent image retains Docker Compose v5.3.1 compatibility while rebuilding
its bundled CLI with gRPC-Go 1.82.1. The manager image also rebuilds its pinned
Trivy 0.72.0 and rclone 1.74.4 binaries from source with gRPC-Go 1.82.1. The
linked-module inventory and third-party notices cover these patched source
builds.

## Historical install or update reference

Use the Compose files from the same beta branch:

```bash
[ ! -f docker-compose.image.yml ] || \
curl -fsSL https://raw.githubusercontent.com/composebastion-admin/composebastion/beta/docker-compose.image.yml \
  -o docker-compose.image.target.yml
curl -fsSL https://raw.githubusercontent.com/composebastion-admin/composebastion/beta/scripts/upgrade-image.sh \
  -o upgrade-image.target.sh
curl -fsSLO https://raw.githubusercontent.com/composebastion-admin/composebastion/beta/.env.example
```

Preserve an existing `.env`. For a new install, copy `.env.example` to `.env`,
generate unique `APP_SECRET` and `POSTGRES_PASSWORD` values, then set:

```dotenv
COMPOSEBASTION_VERSION=1.2.0-beta.3
COMPOSEBASTION_AGENT_VERSION=1.2.0-beta.3
```

For an existing manager, keep the downloaded target definition distinct and
use the beta wrapper:

```bash
chmod 755 upgrade-image.target.sh
./upgrade-image.target.sh --version 1.2.0-beta.3 \
  --compose docker-compose.image.yml docker-compose.image.target.yml
```

The refreshed Compose file runs `storage-init` automatically before the beta
app and worker. It migrates root-owned 1.1 backup/recovery files to the 1.2
non-root runtime identity. Its `database-init` companion tests the preserved
password and, only for the exact repository legacy URL, rotates the managed
role credential when required. Preserve `.env` and all volumes; neither
compatibility repair requires a manual database or backup operation.

For an existing 1.0.6 or 1.1.2 homelab image install, first use Admin ->
Operations to update to the compatibility-only 1.1.6 bridge. From the running
bridge, target this beta. The bridge retains the pre-1.2 Compose file, runs the
repairs from the pulled candidate image, and retains protected
credential/image rollback state until verification succeeds. Direct
pre-1.2-to-beta updates are not qualified. The matching beta Compose file and
wrapper are required for the manual procedure above.

For each image-installed agent, use `agent-compose.image.example.yml`, set
`COMPOSEBASTION_AGENT_VERSION=1.2.0-beta.3`, then pull and recreate that agent.
Because app and agent aliases are stored in separate GHCR repositories, they
have a brief non-atomic update window. For paired testing, resolve the beta
release revision from the recorded publication evidence and use either the
same exact prerelease version or the same immutable `sha-<40-character-sha>`
index instead of independently following the moving `beta` alias.

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
7. Interrupt an analysis or deployment worker, restart it, and confirm the
   source revision and Compose/environment digests remain bound to one durable
   job without duplicate remote deployment.
8. Exercise local, S3-compatible, and SMB recovery targets, including
   remote-only recovery, clone restore, failed cleanup, and preservation of
   volumes, binds, databases, custom networks, and static addresses.
9. Compare owner, operator, and viewer output for credentials and job details;
   revoke an active session and confirm streaming or terminal access is
   reauthorized.
10. Watch host usage while containers start, stop, disappear, and reconnect,
    including desktop and mobile navigation while host identity is loading.

When reporting feedback, include the analysis and job IDs, Jobs progress,
relevant Audit entry, and screenshots of the compact review or Services drawer.
Do not include tokens, secrets, `.env` contents, or registry passwords.

## Known limitations

- Git analysis initially requires an SSH-connected host. Agent hosts support
  Compose and image inputs and return a Git capability blocker.
- Registry trust automation requires an owner/admin, a supported Linux/systemd
  Docker host, and passwordless sudo. Other hosts receive exact manual steps.
- This was the `1.2.0-beta.3` test channel. Stable `v1.2.0` supersedes it.

## Roll back

Export a ComposeBastion configuration backup before testing. To return to the
compatibility bridge, set both manager and agent versions to `1.1.6`, pull,
and recreate the services:

```dotenv
COMPOSEBASTION_VERSION=1.1.6
COMPOSEBASTION_AGENT_VERSION=1.1.6
```

Do not run `docker compose down -v`; keep PostgreSQL, Redis, backups, and other
volumes. The tested rollback leaves migrations `031` through `038` applied:

- `031` adds deployment-source and analysis records plus stack source links.
- `032` normalizes local recovery targets to managed storage, sets their cache
  policy to `keep`, and resets stored target health to `unknown`.
- `033`–`035` add remote-orphan, GitHub deployment-job, restore-attempt, and
  restore-resource ledgers.
- `036`–`038` add analysis revision/digest bindings, encrypted stack
  environment bindings, and clone-deployment job records.

The `1.1.6` app ignores the additive tables and columns while using the same
PostgreSQL, Redis, configuration, backup, and application volumes. Qualification
verifies readiness and preserved state on that rollback, then re-upgrades those
same volumes to the candidate. The `032` data normalization is not reversed.
Keep the pre-upgrade backup for restoring encrypted beta source configuration
if you return to the beta later.

Before recreating `1.1.6`, restore the saved pre-beta Compose file so Docker
does not ask the historical image to run beta initializer scripts:

```bash
cp -p docker-compose.image.yml.pre-beta docker-compose.image.yml
docker compose -f docker-compose.image.yml up -d --no-deps --force-recreate app worker
```

If an in-app update was interrupted, use the job-specific receipt, environment
backup, and immutable rollback overlay as documented in the
[upgrade guide](upgrade-guide.md#interrupted-in-app-update-recovery).
