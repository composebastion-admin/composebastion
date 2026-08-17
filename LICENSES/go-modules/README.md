# Go Module Attribution Bundle

This directory contains the exact module/version union linked into the Trivy,
rclone, Docker CLI, and Docker Compose binaries shipped by ComposeBastion. The
manifest maps every entry to its consuming binary, upstream source record, SPDX
classification candidate, required license/notice texts, and SHA-256 checksums.

The checked-in manifest, required upstream texts, SPDX classification candidates,
and checksums are the release attribution evidence. Image builds verify that the
linked module inventories match this bundle before publication.
