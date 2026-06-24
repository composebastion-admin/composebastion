# Operations Runbook

This runbook is the minimum production checklist for a ComposeBastion deployment.

## Daily Checks

- Open Admin -> Operations and confirm database, Redis, backup storage, and worker
  status are healthy.
- Review failed jobs and audit records after any deploy, restore, migration, or
  bulk container action.
- Retry failed or canceled jobs from Admin -> Jobs only after confirming the
  original failure is safe to repeat. Queued jobs can be canceled before a worker
  starts them; running Docker operations are intentionally not force-canceled.
- Check host metrics for degraded hosts; degraded means Docker specs may still be
  available while live `/proc` stats are unavailable.
- Confirm alert channels are enabled and recent threshold alerts are expected.
- Check active alert silences before maintenance, and remove stale silences after
  work is complete so future notifications are not suppressed unexpectedly.
- If this deployment uses image-based self-update, check Admin -> Operations for
  the configured manager host, latest release check, and last self-update job.

## Weekly Checks

- Run a backup verification or clone-only restore drill for at least one
  critical app, and confirm Recovery Center records a recent successful drill.
- Review active sessions and revoke unfamiliar devices.
- Review admin/operator users and remove inactive accounts.
- Check image update intelligence, vulnerability scan setup, and preview guidance
  before updating containers or redeploying stacks.
- Review the ComposeBastion self-update configuration before planned upgrades:
  the manager host should be an SSH-mode host, the Compose directory should
  match the deployed stack, and the Compose file should be the image install
  file used by production.

## Recovery Acceptance Drill

Run this before trusting a new production backup target or making recovery
claims for a release.

1. Create a disposable app on a real Docker host with:
   - one named Docker volume,
   - one allowed bind mount under `BACKUP_HOST_PATH_ALLOWED_ROOTS`,
   - one database-like container such as Postgres or MariaDB,
   - one custom Docker network with a static container IP.
2. Add an SMB backup target in Recovery Center -> Backup Storage using the rclone
   SMB backend. Set local cache policy to `remote_only`.
3. Test the target connection and confirm target health becomes healthy.
4. Open Recovery Points, select the app, and refresh readiness.
5. Save a recovery profile if readiness recommends stop-first capture, manual
   include paths, excludes, restore path mappings, or hooks.
6. Create a recovery point to the SMB `remote_only` target.
7. Run Verify on the recovery point and confirm the remote artifact is usable
   after the local cache has been removed.
8. Run a clone restore drill and confirm the drill records success.
9. Restore the recovery point as a clone on the same or another host.
10. Confirm the cloned app starts, mounts restored data, keeps expected custom
    network aliases/static IP behavior, and does not depend on local artifacts
    from the original manager cache.
11. Record the target name, app name, recovery point ID, drill result, restore
    job ID, and any warnings in the release notes or acceptance log.

## Before Upgrading

1. Export a config backup from Admin -> Settings.
2. Confirm backup storage is readable and writable.
3. Confirm migrations are clean with `npm run lint:migrations` in the source tree.
4. Read the changelog for new migrations, role changes, and agent compatibility notes.
5. Upgrade a non-critical deployment first when possible.
6. For in-app self-updates, keep a shell open to the manager host and tail
   `.composebastion-self-update.log` from the Compose directory until app and
   worker restart successfully.

## Incident Notes

- If the worker is not processing jobs, inspect `/api/health/ready`,
  `/api/jobs/status`, API logs, and worker logs.
- When reporting API failures, include the `requestId` from the error response
  so it can be matched to Fastify logs and audit records.
- For job failures, copy the job correlation ID from Admin -> Jobs or Admin ->
  Operations. Match it to worker log `jobId`, API log `jobId`, the job row ID,
  and related audit `targetId` entries.
- API logs use the route as `action` and include `hostId`/`jobId` when those
  route params are available. Worker logs use the Docker action type as `action`.
- If a host is offline, run a host check from the UI, then verify SSH or agent
  connectivity from the manager network.
- If restore or a restore drill fails, keep the failed recovery point and job
  record until the audit trail, artifacts, and clone project name are understood.

## Tracing UI Failures

1. Copy the `requestId` from the API error response or browser network panel.
2. Find the API log entry with that `requestId`; note `action`, `hostId`,
   `jobId`, `status`, `durationMs`, and `errorCode`.
3. If a job was created, open Admin -> Jobs and copy the job correlation ID.
4. Match that correlation ID to worker logs (`jobId`), the `operation_jobs.id`
   row, and related audit records where `targetId` or details reference the job
   or Docker resource.
5. Use the failed-job recovery hint in Admin -> Jobs / Operations to decide
   whether to retry, fix credentials/connectivity, or preserve artifacts for
   investigation.

## Agent Compatibility

- Agent-mode hosts report `agentVersion` through `/api/health` during host
  checks. Unknown or outdated agents still keep compatible Docker-only commands,
  but live logs and host `/proc` stats require the newer agent endpoints.
- V1 expects app and agent images from the same release for live logs, queued
  Docker work, and host `/proc` stats.
- For the latest verified release, use app and agent image tags `1.0.1` or
  `v1.0.1`.
