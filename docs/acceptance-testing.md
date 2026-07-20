# Local Release Acceptance

The local acceptance harness layers pinned Postgres, Redis, Mailpit, MinIO,
Samba, registry, agent, and SSH Docker-host fixtures over the shipped
`docker-compose.image.yml`, so the fresh-image and public-upgrade scenarios use
the real production image Compose wiring. It creates runtime-only credentials,
builds the candidate from the current checkout, and
writes redacted JSON and Markdown results under the ignored
`test-results/acceptance/` directory. Every report records the full HEAD SHA,
tree SHA, commit timestamp, branch, initial/final dirty state, and a context
identity; a HEAD or worktree change during the run is also nonqualifying.

Run the complete suite with:

```bash
npx playwright install chromium
npm run acceptance:local
```

Run the release-qualification pass from a clean committed tree. Candidate app
and agent builds receive that commit's full SHA and timestamp, and the harness
requires both images to carry identical version, revision, and created labels.
A machine-readable required-scenario manifest makes the report non-qualifying
when any expected evidence field is absent. A dirty run may still be useful
diagnostically, but is reported as
`passed_nonqualifying`, exits nonzero, and cannot serve as release evidence.
The developer-only `--allow-nonqualifying` option permits a successful
diagnostic `passed_nonqualifying` run to exit zero, but the option itself marks
the report nonqualifying. Required CI never uses that option and separately
runs `npm run acceptance:assert-report` to require `status=passed`, a complete
manifest, and `automatedAcceptanceQualifying=true`.

Use `--keep` to retain failed containers and their runtime-only SSH/registry
credentials for inspection. `--skip-build` reuses local images only after their
OCI title/version/revision/created labels are verified, but marks the report
`passed_nonqualifying`; a reused build is never accepted as automated release
evidence. `--skip-upgrade` is available when the public `1.0.6` image is
unreachable and has the same non-qualifying result. Validate both fixture
definitions and their immutable third-party image pins with
`npm run acceptance:config`.

`npm run check:postgres-upgrade` separately recreates a PostgreSQL container
with a changed initialization password over an existing data volume. It proves
that all production Compose variants preserve an explicit legacy
`DATABASE_URL` for both app and worker connections.

The runner disables Compose's implicit `.env` loading and passes an explicit
safe value for every Compose interpolation control. Subprocesses inherit only
the host path/temp/locale, Docker connection, certificate, SSH-agent, and proxy
settings needed for local Docker access; inherited proxy or Docker endpoint
values that may contain credentials are registered for output redaction.

`ACCEPTANCE_PORT_BASE` defaults to `18000` and must be between `1024` and
`64535`, keeping the highest reserved port within the TCP/UDP range. The harness reserves offsets `+25`
(Mailpit), `+50` (registry), `+80` (fresh manager), `+90` (agent), `+180`
(source-production manager), `+380` (upgrade manager), `+550` (hardened
registry), `+580` (hardened manager), `+590` (hardened agent), and `+1000`
(MinIO).
Compose project names, the bind fixture, and runtime secrets also include this
base, so retained runs can coexist when they use different bases. Override
`ACCEPTANCE_WORKLOAD_SUBNET` with an unused RFC1918 `/24` if the deterministic
default conflicts with a local Docker network.

The suite covers first-run setup, sessions, a real Chromium login and
Operations/About check against the live API, PostgreSQL, Redis, and worker,
readiness, runtime/About/legal artifacts, SMTP test and worker-alert delivery,
authenticated agent health and
a sustained usage stream, a reachable private-registry boundary, Redis-free
durable enqueue while readiness remains healthy, Redis diagnostics and worker
subscription recovery, safe-job lease recovery after a killed worker, a disposable
Compose workload, S3 and SMB target checks, remote-only capture metadata and
local-cache eviction, clone restore with volume/bind/database/network behavior
verification and cleanup, public-image upgrade state preservation (including a
queued API job, encrypted registry credentials, and the resolved public image
digest), and a fresh production source build with login, configuration-write,
and shared backup-write checks using pinned fixtures. A separate hardening
scenario layers the shipped image Compose file with the opt-in manager and agent
overlays, verifies UID/GID, read-only roots, dropped capabilities,
`no-new-privileges`, init, writable tmpfs/backup/Trivy-cache paths, and proves
backup/cache persistence. It also runs Docker through the root agent, performs a
real authenticated registry login, force-recreates the agent, and verifies both
agent files and Docker credentials survived in its persistent data volume.
Both candidate-image builds and the source-production build use a temporary
context materialized from the exact recorded Git commit, rather than the live
checkout. The report records the commit/tree and context digest and rejects the
run if that context changes before acceptance completes; ignored local files
therefore cannot enter a qualifying image.
The disposable workload starts with an empty named volume; only after deploy
does the runner write a unique marker, and the clone must return that exact
marker. This prevents container startup from manufacturing false restore
evidence.
Because the SSH Docker-host fixture controls a sibling daemon through its
socket, the runner explicitly bridges restored bind data from the fixture
container filesystem into the daemon-host bind path before runtime validation;
real SSH hosts naturally share those filesystems.
It does not contact a real NAS or cloud account; those remain separately
recorded production-approval evidence and do not block homelab publication.
The report also records the pending linked-Go-module attribution review and
release governance as deferred. Qualified legal inventory approval and remote
repository-control verification are approval-bound work and are not implied by
a passing automated acceptance result.

Fixture secrets are never written to tracked files or reports. Without
`--keep`, generated keys, registry credentials, and bind data are removed.
With `--keep`, the report records the base-specific project names and prints the
retained runtime directory; remove those Compose projects with `docker compose
down --volumes` after inspection. Do not commit anything from
`test-results/acceptance/` even though that directory is ignored. A stale
`failure.log` is removed at the beginning of every run.
