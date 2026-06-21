# Recovery, Backups, And Restore Drills

ComposeBastion recovery is app-focused. It captures the data an app needs, tracks
where artifacts live, and helps you prove a restore before you need it.

## Recovery Terms

- Recovery point: a captured snapshot of app data and metadata.
- Artifact: a volume archive, host-folder archive, Compose file, or manifest
  stored for a recovery point.
- Storage target: local manager storage, S3, SMB through rclone, or an imported
  rclone remote.
- Readiness: a score that explains whether an app has usable recovery coverage.
- Drill: a clone-only restore test that records whether the point can be used.

## First Recovery Point

1. Open Recovery Center.
2. Choose an app.
3. Review readiness.
4. Create a recovery point.
5. Wait for the job to complete.
6. Run Verify.
7. Run a restore drill.

Do this with a disposable app before trusting recovery for production data.

## Storage Targets

Use `Local` for manager-local artifacts. Use `S3` for object storage. Use `SMB`
for NAS shares and Windows/Samba shares. Use imported rclone configs for other
providers only when you are comfortable operating the rclone remote yourself.

| Target | Current support | Required host capability | Notes |
|--------|------------|--------------------------|-------|
| Local filesystem | Supported | Persistent manager storage | Best for first drills and simple homelabs. |
| S3-compatible | Supported | Network access to object storage | Use path-style mode when your provider requires it. |
| SMB / CIFS | Supported | Reachable NAS or Samba/Windows share | Runs through rclone inside the app/worker image; no privileged CIFS mount is required. |
| Drive, OneDrive, iCloud Drive, WebDAV, SFTP, custom rclone | Experimental | Working rclone config created and tested outside ComposeBastion | Guided OAuth/provider setup is not part of the pre-1.0 line. |

Always run the target test before using a target for important recovery points.

For remote-only targets, ComposeBastion stages artifacts locally during capture,
uploads and verifies them, then removes the local cache for that recovery point.
Only use remote-only after at least one verify and restore drill has passed.

## Recovery Profiles

Create a recovery profile when readiness recommends one or when you know an app
has data outside normal Docker mounts.

Profiles can define:

- Manual include paths.
- Exclude patterns.
- Restore path mappings.
- Hot or stop-first capture mode.
- Audited pre/post capture hooks.

In production, set `BACKUP_HOST_PATH_ALLOWED_ROOTS` so manual paths are limited
to approved directories.

## Clone Restore

Clone restore keeps the original app untouched. ComposeBastion creates suffixed
clone resources where needed and starts the restored app as a separate project.

Use clone restore for:

- Restore drills.
- Testing a backup before replacing production.
- Moving apps between hosts.
- Recovering a subset of data for inspection.

## Recommended Recovery Routine

Daily:

- Check Admin -> Operations for backup health and failed jobs.
- Review readiness warnings for critical apps.

Weekly:

- Run at least one restore drill for an important app.
- Confirm remote backup targets still test successfully.
- Review failed recovery jobs before deleting artifacts.

Before major updates:

- Create a fresh recovery point.
- Verify it.
- Run a clone restore drill when risk is high.
