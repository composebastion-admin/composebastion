# Upgrade Guide

Upgrade carefully, keep rollback paths simple, and export a config backup before
every production update.

## Version Policy

- `/api/v1` is the public compatibility boundary for V1.
- Use additive API changes whenever possible.
- Keep app and agent images on the same release when possible. The latest
  published release is `v1.2.0`. Pre-1.2 image installs must first use the
  immutable 1.1.6 compatibility bridge described below.
- New database migrations must use the next clean `NNN_snake_case.sql` filename.
  The existing duplicate `018_` migration prefix is a published legacy exception;
  do not create new duplicates.

## Standard Upgrade

1. Read `CHANGELOG.md`.
2. Export config from Admin -> Settings and back up the existing `.env` file.
3. Preserve `POSTGRES_PASSWORD` and any real non-empty `DATABASE_URL`; never
   regenerate either value during a routine update. The exact fixed placeholder
   shipped by the v1.1.0 template is detected and repaired automatically.
4. Confirm recent backups and at least one recent successful drill for critical data.
5. For production image installs, resolve one reviewed release revision, obtain
   the target release's Compose files and `scripts/upgrade-image.sh`, and pin
   both app and agent images to its immutable `sha-<40-character-sha>` tags.
6. For source installs, pull the source update and use the source-upgrade
   wrapper below.
7. Validate the Compose configuration when updating manually.
8. Start the stack and confirm the pinned app and worker services restart.
9. Watch `app` and `worker` logs until migrations and worker startup complete.
10. Open Admin -> Operations and confirm readiness checks are healthy.

Admin -> Operations -> ComposeBastion self-update is available for disposable
evaluation and homelab image installs managed over SSH. It currently accepts
`latest` or a SemVer tag and does not consume a durable signed app/agent
release-pair manifest, so it is not the production-qualified update path.
The release-qualified in-app route is `1.0.6/1.1.2/1.1.3/1.1.4/1.1.5 -> 1.1.6 -> 1.2`.
First update explicitly to `1.1.6`; do not target 1.2 directly from an older
release. The compatibility-only bridge keeps the existing pre-1.2 Compose file,
then uses the pulled 1.2 image to prepare storage and the exact managed legacy
credential before app and worker start. It records job-specific protected
rollback state and recreates the immutable 1.1.6 app/worker images with
`--no-deps` if startup or verification fails. Pin the first hop explicitly to
1.1.6; `latest` now tracks the current stable release and does not replace the
required bridge hop.
Production, source-checkout, and agent-host updates use the manual pinned
commands below.

Manual image upgrade:

```bash
cd ~/composebastion
export REVIEWED_REVISION="REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT"
# Save the reviewed target release files under distinct names. Do not replace
# the active Compose file before verification.
chmod 755 upgrade-image.target.sh
./upgrade-image.target.sh \
  --version "sha-${REVIEWED_REVISION}" \
  --env-file .env \
  --compose docker-compose.image.yml docker-compose.image.target.yml
```

Repeat `--compose CURRENT_FILE TARGET_FILE` for every hardening or site overlay.
The wrapper backs up `.env` and all current definitions, pins the pulled
candidate image IDs, runs `storage-init` and `database-init`, verifies labels,
health, readiness, worker connectivity, and version, and only then promotes the
target files. A failure restores the recorded credential before `.env` and the
Compose files, then recreates the prior immutable app/worker images with
`--no-deps`. Its sanitized outcome is
`.composebastion-image-upgrade-JOB_ID.outcome`; protected recovery state is
retained if rollback cannot finish. It never removes named volumes.

Raw `docker compose pull` followed by `docker compose up -d` is supported for a
fresh install, or an upgrade that has been positively verified not to cross a
legacy credential/storage transition. It is not the supported pre-1.2 manual
upgrade path.

Pin every separately deployed ComposeBastion agent to the same reviewed
revision before calling the production update complete.

For source installs:

```bash
cd ~/composebastion
git pull --ff-only
npm ci
npm run upgrade:source
```

The wrapper records the running app/worker image IDs, builds and prepares the
candidate, verifies image identity and readiness, and automatically returns to
the prior images if the candidate fails. It does not change the Git checkout.
After a successful container rollback it prints the exact `git switch
--detach <prior-revision>` command for restoring matching source code.

## PostgreSQL Password Compatibility

PostgreSQL applies `POSTGRES_PASSWORD` only when it initializes a new data
volume. Changing the value later does not rotate the existing
`composebastion` role password. From v1.1.1, a non-empty `DATABASE_URL` is
preserved exactly for existing installations and external databases; when it
is empty or unset, Compose derives it from `POSTGRES_PASSWORD`.

The sole exception is the exact
`postgres://composebastion:composebastion@postgres:5432/composebastion`
placeholder that the v1.1.0 template wrote even though its Compose runtime did
not always use it. Version 1.2 recognizes that repository-owned value. Its
`database-init` preflight first tries the preserved `POSTGRES_PASSWORD`; when a
long-hop source install still uses the legacy role credential, it rotates that
managed role and verifies the new connection before startup. No `.env` edit or
manual database-role rotation is required for that specific upgrade case. Its
non-secret receipt remains in the `upgrade-state` volume so a later manual
rollback can prove whether this exact transition changed the credential.

## Backup Storage Ownership Compatibility

Version 1.2 runs the app and worker as UID/GID `1000:1000`. The shipped Compose
files include a root `storage-init` one-shot that prepares only
`/data/backups`, then exits before the long-running services start. It repairs
root-owned files created by older releases while preserving the contents and
all database, Redis, and backup volumes. A repository-owned native helper walks
the same-filesystem tree through held directory descriptors, skips every
symlink, and rejects nested filesystems and special files. The initializer runs
with only `CHOWN` and `DAC_READ_SEARCH` capabilities.
Manual image updates must refresh the Compose file from the target release;
the in-app updater performs the same preparation from the candidate image even
when the operator's Compose file predates the initializer services. Never use
`docker compose down -v` as an ownership repair.

For an existing installation, let `upgrade-image.sh` manage `.env`. The
target-release `database-init` service performs and verifies the sole supported
managed rotation and records its non-secret result in the `upgrade-state`
volume. The wrapper atomically appends the canonical managed selection only
when the helper requests it. Never clear the legacy override before that
service has succeeded. `POSTGRES_PASSWORD` must remain URL-safe, as generated
by `openssl rand -hex 32`.

The Compose-managed database has a `composebastion` administrative role; it
does not create a separate `postgres` role. Never run `docker compose down -v`
to repair credentials because `-v` removes the persistent database volume.

## Agent Configuration Changes

Release `v1.1.2` adds four optional agent-only request limits. Existing agents
retain the prior defaults when the variables are absent or blank. If you set
custom values, update the agent `.env` file and recreate or restart the agent;
manager `app` and `worker` services do not receive these settings. See
[Connect Docker Hosts](connect-hosts.md#agent-request-limits) for defaults and
security guidance.

## Rollback

- Roll back the container image/source first. If you replaced
  `docker-compose.image.yml`, restore the saved `.pre-upgrade` copy before
  starting an older image, or use the immutable overlay recovery command below.
- Keep database backups before upgrades that include migrations.
- Preserve `.env` and all named volumes during rollback; never use `down -v`.
- Do not manually delete rows from `schema_migrations`; fix forward unless a full
  database restore is part of the rollback.

For wrapper-driven updates, inspect the job-specific outcome first. A complete
automatic rollback requires no further command. If it reports
`rollback=failed`, retain the named recovery directory and use its candidate,
receipt, environment, Compose backups, and immutable rollback overlay to finish
the same credential-first ordering before restarting historical images.

Historical app images do not contain the 1.2 initializer scripts. For a legacy
raw manual start outside the wrapper, restore a changed credential while the
target-release Compose file and durable receipt volume are still present:

```bash
docker compose -f docker-compose.image.yml stop app worker
docker compose -f docker-compose.image.yml run --rm --no-deps database-init \
  node /app/scripts/prepare-database-upgrade.mjs restore-legacy \
  --state-file /var/lib/composebastion/upgrade-state/database-transition.json
```

Then restore the saved pre-upgrade Compose file. Every historical-image start
must bypass candidate dependencies:

```bash
cp -p docker-compose.image.yml.pre-upgrade docker-compose.image.yml
docker compose \
  -f docker-compose.image.yml \
  -f .composebastion-self-update-JOB_ID.rollback.yml \
  up -d --pull never --no-deps --force-recreate app worker
```

### Interrupted in-app update recovery

The updater normally performs this rollback automatically. If the host process
is killed before it can finish, keep the protected files named for that job.
While `.env` still selects the pulled candidate image, restore a recorded
legacy credential first (this is a verified no-op when the receipt says no
credential changed):

```bash
JOB_ID=REPLACE_WITH_JOB_ID
STATE_DIR="$PWD/.composebastion-self-update-${JOB_ID}.upgrade"
test -f "$STATE_DIR/database-transition.json"
docker compose -f docker-compose.image.yml -f "$STATE_DIR/candidate.yml" \
  run --rm --no-deps --user 0:0 \
  --volume "$STATE_DIR:/run/composebastion-upgrade" \
  app node /app/scripts/prepare-compose-upgrade.mjs restore-legacy \
  --compose-config /run/composebastion-upgrade/compose-config.json \
  --environment-probe /run/composebastion-upgrade/source-env-probe.json \
  --state-file /run/composebastion-upgrade/database-transition.json
```

Then restore the saved environment and immutable prior images:

```bash
cp -p ".composebastion-self-update-${JOB_ID}.env.backup" .env
docker compose \
  -f docker-compose.image.yml \
  -f ".composebastion-self-update-${JOB_ID}.rollback.yml" \
  up -d --pull never --no-deps --force-recreate app worker
docker compose -f docker-compose.image.yml ps
```

Delete the job-specific state only after the prior app and worker are healthy.
If no database transition receipt exists, skip only the credential-restoration
command; do not invent or edit a receipt.

### Post-upgrade symptom recovery

Use this when an older install is already broken after a partial or unsupported
hop into 1.2. Prefer repair over recreating Postgres or Redis volumes.

1. Confirm the running app label version and whether Compose is still the
   pre-1.2 file (no `storage-init` / `database-init` services).
2. Check for a stuck `system.self_update` job with `handoffPending: true` and
   any `.composebastion-self-update-*.outcome`. Host checks, backups, and
   deploys queue forever while that handoff blocks worker claims. Finish or
   reconcile the outcome, or use the interrupted-update recovery above.
3. Verify the backup directory is writable by the runtime UID (1.2 defaults to
   `1000:1000`). Root-owned trees from a raw `compose pull && up` across the
   root→UID1000 boundary cause `EACCES` on backup create/hydrate/cleanup.
   Repair with the candidate prepare helper / `storage-init` path rather than
   `chown` ad hoc unless you know the hardened UID.
4. Verify the database accepts the password implied by the effective
   `DATABASE_URL` / `POSTGRES_PASSWORD`. A retained legacy URL without
   `POSTGRES_PASSWORD` in the app process skips the managed rewrite and fails
   auth after role rotation.
5. Prefer candidate prepare reconcile
   (`prepare-compose-upgrade.mjs`) for credential and storage repair. After a
   successful bridge→1.2 hop, promote to the 1.2 Compose definition (or re-run
   storage/database prepare) before calling the upgrade done; retained pre-1.2
   Compose will not re-run init one-shots on later restarts.

Supported path only: `1.0.6/1.1.2 → 1.1.6 → 1.2` via in-app self-update or the
image-upgrade wrapper. Raw image pin bumps that skip prepare are unsupported
across the 1.2 runtime-user boundary.
