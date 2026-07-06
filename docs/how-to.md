# ComposeBastion How-To Guide

Version covered: `v1.0.6`.

This guide covers the day-to-day workflows that are easiest to forget when you
only use them occasionally. For installation-first docs, start with
[installation.md](installation.md).

## Use The Demo Workspace

During first owner setup, enable `Include demo workspace` to seed a complete
synthetic environment for evaluation, screenshots, or team training. The demo
includes production, edge-agent, and recovery-target hosts; Compose stacks;
standalone containers; GitHub source links; image update and scan data; alert
events and silences; backup targets; recovery points; restore drills; migration
runs; and custom catalog templates.

Demo hosts are tagged `demo`, and Docker actions on them are simulated. That
means you can start, stop, deploy, inspect logs, test backups, and walk through
recovery flows without connecting real infrastructure.

### Demo Workspace Screenshots

![ComposeBastion demo fleet dashboard](assets/screenshots/dashboard-overview.png)

The seeded dashboard opens with three online hosts, fleet KPIs, services needing
attention, and non-running containers.

![Demo services inventory](assets/screenshots/services-inventory.png)

Services groups Compose projects and standalone containers with source tracking,
image update state, recovery readiness, ports, and direct lifecycle actions.

![Demo Recovery Center](assets/screenshots/recovery-center.png)

Recovery Center includes completed, partial, and failed recovery points, target
sync state, drill history, and clone/restore actions for realistic practice.

![Demo GitHub deploy tracking](assets/screenshots/github-deploy.png)

The Deploy area includes tracked GitHub repositories, branch selectors, default
hosts, Compose paths, last deploy state, and private-token guidance.

![Demo catalog templates](assets/screenshots/catalog-templates.png)

Catalog includes built-in templates plus custom demo templates for production
web apps, observability, and worker automation stacks.

### Full Product Gallery

| Fleet and hosts | Service operations |
|-----------------|--------------------|
| ![Demo host inventory](assets/screenshots/hosts-inventory.png) | ![Services inventory](assets/screenshots/services-inventory.png) |
| ![SSH connection management](assets/screenshots/ssh-connections.png) | ![Container inventory and console actions](assets/screenshots/containers-console.png) |

| Docker resources | Image intelligence |
|------------------|--------------------|
| ![Network inventory](assets/screenshots/networks-inventory.png) | ![Image inventory](assets/screenshots/images-inventory.png) |
| ![Volume inventory](assets/screenshots/volumes-inventory.png) | ![Image cleanup preview](assets/screenshots/images-cleanup.png) |
| ![Host metrics](assets/screenshots/host-metrics.png) | ![Image update intelligence](assets/screenshots/image-updates.png) |

| Deploy workflows | Recovery workflows |
|------------------|--------------------|
| ![Compose stack management](assets/screenshots/compose-stacks.png) | ![Recovery points](assets/screenshots/recovery-center.png) |
| ![GitHub deploy tracking](assets/screenshots/github-deploy.png) | ![App migration](assets/screenshots/recovery-move.png) |
| ![Catalog templates](assets/screenshots/catalog-templates.png) | ![Recovery schedules](assets/screenshots/recovery-schedules.png) |
| ![Host file browser](assets/screenshots/host-files.png) | ![Backup storage targets](assets/screenshots/backup-storage.png) |
| ![Backup workflows](assets/screenshots/backups-workflows.png) | ![Restore and migration runs](assets/screenshots/restore-runs.png) |

| Admin, security, and guidance | Supporting operations |
|-------------------------------|-----------------------|
| ![Alerts, silences, and notification history](assets/screenshots/alerts-rules-history.png) | ![Admin operations dashboard](assets/screenshots/admin-operations.png) |
| ![Users, sessions, and host settings](assets/screenshots/users-and-sessions.png) | ![Registry credentials](assets/screenshots/registries.png) |
| ![Audit log](assets/screenshots/audit-log.png) | ![Guided help](assets/screenshots/guided-help.png) |

## Add An SSH Docker Host

Before adding a host in ComposeBastion, test the same SSH user and Docker socket that the app will use.

The host must meet these requirements:

- The host is reachable over SSH from the ComposeBastion API/worker container.
- Docker Engine is installed.
- Docker Compose v2 works as `docker compose`.
- The SSH user can run `docker` without `sudo`.
- The SSH user has permission to the configured Docker socket, usually `/var/run/docker.sock`.
- The Docker socket path in the host form matches the real socket path on the host.

Run this from a machine with the same network reachability as ComposeBastion:

```bash
ssh <ssh-user>@<host> 'docker version --format "{{.Server.Version}}" && docker compose version --short && docker ps'
```

If Docker is installed but the command fails with a socket permission error, add the SSH user to the host's Docker group:

```bash
sudo usermod -aG docker <ssh-user>
```

Then fully log out of SSH and back in, or reboot the host, before testing again. ComposeBastion does not run Docker commands through interactive `sudo`; the SSH user must already have Docker access.

## Use A Private GitHub Repository

1. In GitHub, create a fine-grained personal access token for the repository.
2. Give the token read-only `Contents` permission.
3. In ComposeBastion, open `Deploy` -> `Tracked GitHub repositories`.
4. Enter the repository URL, branch, Compose path, project name, default host, and optional `.env` content.
5. Paste the token into `Fine-grained GitHub token for private repos, Contents: Read-only`.
6. Click `Branches` to confirm ComposeBastion can read the private repo.
7. Save the repo, then use preview/customize deploy for image-only Compose
   files.
8. For Compose files with `build:` or repo-local Dockerfiles, add a read-only
   deploy key on the Docker host, save the host SSH clone URL/alias and clone
   directory on the tracked repo, then use `Clone/Build Deploy`.

ComposeBastion encrypts the token with `APP_SECRET` before storing it. When editing a tracked repo, leave the token field blank to keep the saved token.

## Clean Up Images

The Images page hides dangling or untagged `<none>` image layers by default. These are usually old build layers or orphaned image remnants, and they are not useful for normal pull/run/update workflows.

Use `Show dangling` when you need to inspect them. Use `Prune` to remove unused image layers from the selected host.

Image actions:

- `Pull image` downloads an image tag to the selected host.
- `Run image` creates a container from a selected image.
- `Scan image` runs vulnerability scanning when the scanner provider is available.
- `Remove image` deletes that image from the host.
- `Saved images` stores shortcuts for images you use often.

## Add A Custom Catalog Template

Open `Catalog` -> `Add template`, or use `Discover top apps` to load popular entries from Awesome-Selfhosted and import one as a draft.

Required fields:

- `Template ID`: lowercase key such as `home-assistant`.
- `Display name`: readable app name.
- `Category`: where the template belongs in the catalog.
- `Short description`: one sentence about what the app does.
- `Compose YAML`: a working Compose file.

Optional fields:

- `Default env`: one `KEY=value` per line.
- `Suggested ports`: one mapping per line, such as `8123:8123`.
- `Suggested volumes`: one mount per line, such as `./config:/config`.
- `Docs URL`: official project or image documentation.

For third-party apps, start from the official Compose example in the project docs. Review image tags, secrets, bind mounts, named volumes, and public ports before saving or deploying.

External discovery:

- `Discover top apps` pulls from [Awesome-Selfhosted data](https://github.com/awesome-selfhosted/awesome-selfhosted-data), sorts by stars, and shows Top 50, Top 100, or Top 200.
- `Import draft` fills the custom template form with name, description, docs URL, category, placeholder Compose YAML, suggested port, and suggested volume.
- Replace `replace-with-official-image:latest` with the official image or Compose example before saving.

ComposeBastion imports third-party catalog data into a review screen instead of deploying it directly. External Compose files can include privileged containers, host mounts, default passwords, or ports that conflict with existing apps.

## Use SSH

Open `SSH`, choose a host, and open the terminal. SSH terminal access is owner/admin only and is intended for direct host repair work.

The terminal opens as a near full-screen audited shell. Commands are attributed to the signed-in user.

## Use Recovery

Recovery is for app-level restore and move workflows:

- `Recovery Points`: capture app recovery points.
- `Move App`: plan and execute host-to-host app movement.
- `Schedules`: automate recovery point captures.
- `Storage Targets`: configure local or remote recovery storage.
- `Restore / Migration Runs`: inspect restore and migration history.
- `Backups`: manage volume and host-path backup jobs.

Use the dedicated `SSH` page for host shell sessions instead of recovery troubleshooting.

### Read Recovery Readiness

Services and Recovery Center show a readiness pill for each app:

- `Ready`: persistent data was detected, the latest point is completed and
  verified, target health is acceptable, and a restore drill has passed.
- `Needs profile`: ComposeBastion can capture the app, but recommends a saved
  recovery profile for manual paths, restore mappings, hooks, or stop-first
  capture.
- `Risky`: recovery is possible, but there are warnings such as missing drills,
  failed target health, tmpfs/writable-layer data, an unverified point, or a
  failed latest backup.
- `Blocked`: the app has no containers, stateful data is not mounted, required
  host paths are outside allowed roots, or the latest point has no usable local
  or remote artifact.

Open `Recovery Points`, choose an app, and use `Refresh readiness` for a
single-app recalculation. The detail panel lists detected volumes, bind mounts,
compose folders, profile state, latest recovery point, latest drill, target
health, and next actions.

### Configure SMB Or Rclone Storage

Open `Recovery Center` -> `Backup Storage` and create a target:

- Use `Local` for manager-local recovery artifacts.
- Use `S3` for S3-compatible object storage.
- Use `SMB` for Windows shares, Samba shares, and NAS shares. ComposeBastion uses
  rclone's SMB backend from inside the app/worker image; it does not require a
  privileged CIFS mount in the container.
- Use `rclone experimental` for imported rclone configs such as Google Drive,
  OneDrive, WebDAV, SFTP, or a custom rclone backend.

For SMB, enter server, share, optional subpath, domain/workgroup, username,
password, and port. Run the target test before using it for recovery points.

For experimental rclone targets, create and test the rclone remote outside
ComposeBastion, then paste the rclone config into the target form. Guided OAuth
flows are not part of the guided V1 release path; bring a working rclone config
and test it before using the target for important recovery points.

### Use `remote_only`

Remote-only targets still stage artifacts locally during capture. After upload
and verification succeed, ComposeBastion removes the local artifact cache for that
recovery point. Readiness treats a remote-only point as usable when the remote
artifact is present and the backup target still exists and is enabled.

Use `remote_only` only after the target test passes and you have run at least
one verify and restore drill against that target.

### Save Recovery Profiles

Recovery profiles are app-specific instructions saved with the app identity.
Use them when readiness says `Needs profile`, or when you know an app has data
outside normal Docker mounts.

Profile fields:

- Manual include paths: extra host paths to capture, one per line.
- Exclude patterns: tar exclude patterns for large caches or disposable files.
- Restore path mappings: `/source => /target` entries for restoring host paths
  somewhere else on the target host.
- Capture mode: `hot` or `stop-first`.
- Pre/post capture hooks: optional operator-only commands. Hooks are audited and
  should be used sparingly for consistency steps that cannot be represented as
  mounts.

Custom bind/manual paths are constrained by `BACKUP_HOST_PATH_ALLOWED_ROOTS`.
Set it to comma-separated roots such as `/srv,/home/docker` in production so
operators cannot accidentally capture or restore arbitrary system paths.

### Clone Restore And Network Reuse

Clone restore is the default. It creates suffixed clone resources where
needed so the original app remains untouched. Custom Docker networks are cloned
by default, and static IPs/aliases are preserved on cloned networks when safe.

Network reuse is an advanced restore choice. Reusing existing custom networks
can preserve integrations, but static IP conflicts must be resolved first.
ComposeBastion surfaces conflicts in restore/migration plans instead of silently
overwriting live network state.
