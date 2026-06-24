# Upgrade Guide

Upgrade carefully, keep rollback paths simple, and export a config backup before
every production update.

## Version Policy

- `/api/v1` is the public compatibility boundary for V1.
- Use additive API changes whenever possible.
- Keep app and agent images on the same release when possible. The latest
  verified release is `v1.0.1`, with app and agent image tags `1.0.1`
  and `v1.0.1`.
- New database migrations must use the next clean `NNN_snake_case.sql` filename.
  The existing duplicate `018_` migration prefix is a published legacy exception;
  do not create new duplicates.

## Standard Upgrade

1. Read `CHANGELOG.md`.
2. Export config from Admin -> Settings.
3. Confirm recent backups and at least one recent successful drill for critical data.
4. For image installs, either start the in-app self-update from Admin ->
   Operations or pull the new image manually.
5. For source installs, pull the source update.
6. Validate the Compose configuration when updating manually.
7. Start the stack or wait for the self-update handoff to restart `app` and
   `worker`.
8. Watch `app` and `worker` logs until migrations and worker startup complete.
9. Open Admin -> Operations and confirm readiness checks are healthy.

For image installs managed over SSH, use Admin -> Operations ->
ComposeBastion self-update. Set the manager host, Compose directory, Compose
file, and release mode, then start the update. V1 self-update supports image
installs only; source checkouts and agent-only manager hosts use the manual
commands below.

Manual image install:

```bash
cd ~/composebastion
export COMPOSEBASTION_VERSION=1.0.1
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

For source installs:

```bash
cd ~/composebastion
git pull --ff-only
docker compose up -d --build app worker
```

## Rollback

- Roll back the container image/source first.
- Keep database backups before upgrades that include migrations.
- Do not manually delete rows from `schema_migrations`; fix forward unless a full
  database restore is part of the rollback.
