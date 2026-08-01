# Upgrade Guide

Upgrade carefully, keep rollback paths simple, and export a config backup before
every production update.

## Version Policy

- `/api/v1` is the public compatibility boundary for V1.
- Use additive API changes whenever possible.
- Keep app and agent images on the same release when possible. The most recent
  published release is `v1.1.2`.
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
5. For production image installs, resolve one reviewed release revision and
   manually pin both app and agent images to its immutable
   `sha-<40-character-sha>` tags. Do not use in-app self-update for the
   production handoff yet.
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
The updater can cross from a pre-1.2 Compose file without replacing that file:
the candidate image prepares storage and the exact managed legacy credential
before app and worker start. It records protected rollback state and recreates
the immutable prior app/worker images with `--no-deps` if startup or
verification fails.
Production, source-checkout, and agent-host updates use the manual pinned
commands below.

Manual image install:

```bash
cd ~/composebastion
cp -p docker-compose.image.yml docker-compose.image.yml.pre-upgrade
# Download docker-compose.image.yml from the same release channel/tag first.
export REVIEWED_REVISION="REPLACE_WITH_REVIEWED_40_CHARACTER_COMMIT"
export COMPOSEBASTION_VERSION="sha-${REVIEWED_REVISION}"
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

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
manual database-role rotation is required for that specific upgrade case.

## Backup Storage Ownership Compatibility

Version 1.2 runs the app and worker as UID/GID `1000:1000`. The shipped Compose
files include a root `storage-init` one-shot that prepares only
`/data/backups`, then exits before the long-running services start. It repairs
root-owned files created by older releases while preserving the contents and
all database, Redis, and backup volumes. The pass recursively checks the whole
same-filesystem tree and skips every symlink, including legacy marker names.
Manual image updates must refresh the Compose file from the target release;
the in-app updater performs the same preparation from the candidate image even
when the operator's Compose file predates the initializer services. Never use
`docker compose down -v` as an ownership repair.

For an existing installation, keep `.env` unchanged during the upgrade. To
move from a legacy `DATABASE_URL` to the canonical `POSTGRES_PASSWORD`, first
stop the database clients, rotate the actual role password through PostgreSQL's
local socket, then clear the override. The password must be URL-safe, as
generated by `openssl rand -hex 32`:

```bash
docker compose stop app worker
DB_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env)"
test -n "$DB_PASSWORD"
docker compose exec -T -u postgres postgres \
  psql -U composebastion -d postgres \
  -c "ALTER ROLE composebastion PASSWORD '$DB_PASSWORD'"
unset DB_PASSWORD
# Set DATABASE_URL= (or remove the assignment) only after ALTER ROLE succeeds.
docker compose up -d app worker
docker compose ps
```

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

Historical app images do not contain the 1.2 initializer scripts. Every manual
rollback or recovery start must therefore bypass candidate dependencies:

```bash
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
