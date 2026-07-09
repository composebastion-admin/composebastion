# Local Release Acceptance

The local acceptance harness exercises an unpushed candidate against pinned
Postgres, Redis, Mailpit, MinIO, Samba, and SSH Docker-host fixtures. It creates
runtime-only credentials, builds the candidate from the current checkout, and
writes redacted JSON and Markdown results under the ignored
`test-results/acceptance/` directory.

Run the complete suite with:

```bash
npm run acceptance:local
```

Use `--keep` to retain failed containers for inspection, `--skip-build` to reuse
the local candidate image, or `--skip-upgrade` when the public `1.0.6` image is
not reachable. Validate only the fixture definition with
`npm run acceptance:config`.

The suite covers first-run setup, sessions, readiness and version metadata,
SMTP test and worker-alert delivery, a disposable Compose workload, S3 and SMB
target checks, remote-only capture and verification, clone restore and cleanup,
public-image upgrade state preservation, and a fresh production source build.
It does not contact a real NAS or cloud account; those remain manual
production-readiness gates.

Fixture secrets are never written to tracked files or reports. The generated
SSH key is removed during cleanup. Do not commit anything from
`test-results/acceptance/` even though that directory is ignored.
