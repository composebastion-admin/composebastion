# Upgrade Guide

Dockermender is still pre-1.0. Upgrade carefully and keep rollback paths simple.

## Version Policy

- Stay below `1.0` until API contracts, browser smoke tests, accessibility
  checks, migration discipline, and production runbooks are fully stable.
- Use additive API changes whenever possible.
- New database migrations must use the next clean `NNN_snake_case.sql` filename.
  The existing duplicate `018_` migration prefix is a published legacy exception;
  do not create new duplicates.

## Standard Upgrade

1. Read `CHANGELOG.md`.
2. Export config from Admin -> Settings.
3. Confirm recent backups and at least one recent successful drill for critical data.
4. Pull the new image/source.
5. Run `docker compose -f docker-compose.yml -f docker-compose.prod.example.yml config`.
6. Start the stack with `docker compose ... up -d --build`.
7. Watch `app` and `worker` logs until migrations and worker startup complete.
8. Open Admin -> Operations and confirm readiness checks are healthy.

## Rollback

- Roll back the container image/source first.
- Keep database backups before upgrades that include migrations.
- Do not manually delete rows from `schema_migrations`; fix forward unless a full
  database restore is part of the rollback.
