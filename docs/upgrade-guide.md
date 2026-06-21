# Upgrade Guide

ComposeBastion is still pre-1.0. Upgrade carefully, keep rollback paths simple,
and export a config backup before every production update.

## Version Policy

- `/api/v1` is the pre-1.0 public compatibility boundary.
- Use additive API changes whenever possible.
- Keep app and agent images on the same release when possible. The latest
  verified release is `v0.9.7`, with app and agent image tags `0.9.7`,
  `v0.9.7`, and `0.9`.
- New database migrations must use the next clean `NNN_snake_case.sql` filename.
  The existing duplicate `018_` migration prefix is a published legacy exception;
  do not create new duplicates.

## Standard Upgrade

1. Read `CHANGELOG.md`.
2. Export config from Admin -> Settings.
3. Confirm recent backups and at least one recent successful drill for critical data.
4. Pull the new image or source.
5. Validate the Compose configuration.
6. Start the stack.
7. Watch `app` and `worker` logs until migrations and worker startup complete.
8. Open Admin -> Operations and confirm readiness checks are healthy.

For image installs:

```bash
cd ~/composebastion
export COMPOSEBASTION_VERSION=0.9.7
docker compose -f docker-compose.image.yml pull
docker compose -f docker-compose.image.yml up -d
```

For source installs:

```bash
cd ~/composebastion && git pull --rebase origin main && docker compose -f docker-compose.yml -f docker-compose.prod.example.yml up -d --build
```

## Rollback

- Roll back the container image/source first.
- Keep database backups before upgrades that include migrations.
- Do not manually delete rows from `schema_migrations`; fix forward unless a full
  database restore is part of the rollback.
