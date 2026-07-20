# Go Module Attribution Bundle

This directory contains the exact module/version union linked into the Trivy,
rclone, Docker CLI, and Docker Compose binaries shipped by ComposeBastion. The
manifest maps every entry to its consuming binary, upstream source record, SPDX
classification candidate, required license/notice texts, and SHA-256 checksums.

The current legal-review status and any qualified approval evidence are recorded
only in `manifest.json`, which is the source of truth. Automated classification
and checksum verification are release evidence, not qualified legal approval.
