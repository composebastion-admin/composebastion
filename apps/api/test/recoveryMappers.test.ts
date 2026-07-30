import { describe, expect, it } from "vitest";
import {
  mapBackup,
  mapBackupTarget,
  mapMigrationRun,
  mapRecoveryArtifact,
  mapRecoveryPoint,
  mapRecoverySchedule,
  redactMigrationRunForViewer,
  recoveryArtifactEvidenceCounts,
  sanitizeBackupForRead,
  sanitizeMigrationRunForRead,
  sanitizeRecoveryArtifactForRead,
  sanitizeRecoveryPointForRead
} from "../src/services/mappers.js";

describe("recovery center mappers", () => {
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("maps backup targets without exposing encrypted secrets", () => {
    const mapped = mapBackupTarget({
      id: "00000000-0000-4000-8000-000000000001",
      name: "Offsite",
      kind: "s3",
      enabled: true,
      config: { endpoint: "https://s3.example.com", bucket: "recovery" },
      access_key_id: "key-id",
      secret_access_key_encrypted: "cipher",
      created_at: now,
      updated_at: now
    });
    expect(mapped.hasCredentials).toBe(true);
    expect(mapped.accessKeyId).toBe("key-id");
    expect(mapped.hasSecretAccessKey).toBe(true);
    expect(mapped.type).toBe("s3");
    expect(mapped.endpoint).toBe("https://s3.example.com");
    expect(mapped.bucket).toBe("recovery");
    expect(mapped).not.toHaveProperty("secretAccessKey");
    expect(mapped).not.toHaveProperty("secret_access_key_encrypted");
  });

  it("maps recovery points, artifacts, schedules, and migration runs", () => {
    const diagnosticSecret = "recovery-mapper-secret";
    const unsafeDiagnostic = `failed https://worker:${diagnosticSecret}@worker.example.test/hook`;
    const point = mapRecoveryPoint({
      id: "00000000-0000-4000-8000-000000000002",
      host_id: "00000000-0000-4000-8000-000000000003",
      name: "Snapshot",
      app_identity: { kind: "compose", projectName: "openwebui" },
      trigger_kind: "manual",
      status: "completed",
      backup_target_id: null,
      legacy_volume_backup_id: null,
      artifact_count: 2,
      completed_artifact_count: 2,
      remote_artifact_count: "1",
      remote_upload_failure_count: "1",
      local_retained_artifact_count: "1",
      local_removed_artifact_count: "1",
      total_bytes: "4096",
      error: unsafeDiagnostic,
      metadata: { note: unsafeDiagnostic },
      last_drill_error: unsafeDiagnostic,
      created_at: now,
      started_at: now,
      completed_at: now
    });
    expect(point.appIdentity.kind).toBe("compose");
    expect(point.totalBytes).toBe(4096);
    expect(point).toMatchObject({
      remoteArtifactCount: 1,
      remoteUploadFailureCount: 1,
      localRetainedArtifactCount: 1,
      localRemovedArtifactCount: 1
    });
    expect(JSON.stringify(point.metadata)).toContain(diagnosticSecret);
    expect(JSON.stringify(sanitizeRecoveryPointForRead(point))).not.toContain(diagnosticSecret);

    const artifact = mapRecoveryArtifact({
      id: "00000000-0000-4000-8000-000000000004",
      recovery_point_id: point.id,
      kind: "volume",
      backup_target_id: null,
      storage_key: "points/point/data.tar.gz",
      size_bytes: 2048,
      checksum: "sha256:abc",
      status: "completed",
      error: unsafeDiagnostic,
      metadata: { hookOutput: unsafeDiagnostic },
      created_at: now,
      completed_at: now
    });
    expect(artifact.storageKey).toBe("points/point/data.tar.gz");
    expect(JSON.stringify(artifact.metadata)).toContain(diagnosticSecret);
    expect(JSON.stringify(sanitizeRecoveryArtifactForRead(artifact))).not.toContain(diagnosticSecret);

    expect(recoveryArtifactEvidenceCounts([
      {
        ...artifact,
        metadata: {
          remoteObjectKey: "points/point/data.tar.gz",
          remoteVerified: true,
          localCachePolicy: "remote_only",
          localCacheRemoved: true
        }
      },
      {
        ...artifact,
        id: "00000000-0000-4000-8000-000000000009",
        metadata: {
          remoteVerificationError: "checksum mismatch",
          remoteVerified: false,
          localCachePolicy: "keep",
          localCacheRemoved: false
        }
      }
    ])).toEqual({
      remoteArtifactCount: 1,
      remoteUploadFailureCount: 1,
      localRetainedArtifactCount: 1,
      localRemovedArtifactCount: 1
    });

    const schedule = mapRecoverySchedule({
      id: "00000000-0000-4000-8000-000000000005",
      host_id: point.hostId,
      name: "Nightly",
      app_identity: { kind: "stack", stackId: "00000000-0000-4000-8000-000000000006" },
      backup_target_id: null,
      interval_ms: 3_600_000,
      retention_count: 7,
      enabled: true,
      last_run_at: null,
      last_drill_error: unsafeDiagnostic,
      next_run_at: now,
      created_at: now,
      updated_at: now
    });
    expect(schedule.intervalMs).toBe(3_600_000);
    expect(JSON.stringify(schedule)).not.toContain(diagnosticSecret);

    const migration = mapMigrationRun({
      id: "00000000-0000-4000-8000-000000000007",
      source_host_id: point.hostId,
      target_host_id: "00000000-0000-4000-8000-000000000008",
      source_app_identity: { kind: "stack", stackId: "00000000-0000-4000-8000-000000000006" },
      mode: "plan",
      status: "completed",
      recovery_point_id: point.id,
      plan: {
        sourceHostId: point.hostId,
        targetHostId: "00000000-0000-4000-8000-000000000008",
        sourceAppIdentity: { kind: "stack", stackId: "00000000-0000-4000-8000-000000000006" },
        steps: [],
        warnings: [],
        estimatedArtifacts: 0,
        checks: {
          sourceHostAvailable: true,
          targetHostAvailable: true,
          sourceDockerAvailable: true,
          targetDockerAvailable: true,
          sourceComposeAvailable: true,
          targetComposeAvailable: true
        },
        portConflicts: [],
        volumeCollisions: [],
        nameCollisions: [],
        missingNetworks: [],
        estimatedDataBytes: null,
        blockingIssues: []
      },
      error: unsafeDiagnostic,
      created_at: now,
      started_at: now,
      completed_at: now
    });
    expect(migration.plan?.estimatedArtifacts).toBe(0);
    expect(JSON.stringify(migration)).not.toContain(diagnosticSecret);
  });

  it("preserves URL-shaped storage locators internally and sanitizes only outward copies", () => {
    const secret = "locator-secret";
    const locator = `https:/user:${secret}@archive.example.test/root/object.tar.gz`;
    const credentialStorageKey =
      `https://storage-user:${secret}@archive.example.test/root/object.tar.gz?token=${secret}`;
    const artifact = mapRecoveryArtifact({
      id: "00000000-0000-4000-8000-000000000011",
      recovery_point_id: "00000000-0000-4000-8000-000000000012",
      kind: "volume",
      backup_target_id: "00000000-0000-4000-8000-000000000013",
      storage_key: credentialStorageKey,
      size_bytes: 1,
      checksum: "sha256:abc",
      status: "completed",
      error: null,
      metadata: { remoteObjectKey: locator, orphanRemoteObjectKey: locator },
      created_at: now,
      completed_at: now
    });
    const backup = mapBackup({
      id: "00000000-0000-4000-8000-000000000014",
      host_id: "00000000-0000-4000-8000-000000000015",
      kind: "volume",
      volume_name: "data",
      file_name: "backup.tar.gz",
      backup_target_id: "00000000-0000-4000-8000-000000000013",
      remote_object_key: locator,
      status: "completed",
      metadata: { orphanRemoteObjectKey: locator },
      created_at: now
    });

    expect(artifact.metadata.remoteObjectKey).toBe(locator);
    expect(artifact.storageKey).toBe(credentialStorageKey);
    expect(backup.remoteObjectKey).toBe(locator);
    expect(backup.metadata.orphanRemoteObjectKey).toBe(locator);
    const outwardArtifact = sanitizeRecoveryArtifactForRead(artifact);
    expect(JSON.stringify(outwardArtifact)).not.toContain(secret);
    expect(outwardArtifact.storageKey).toContain("archive.example.test/root/object.tar.gz");
    expect(outwardArtifact.storageKey).not.toContain("storage-user");
    expect(outwardArtifact.storageKey).not.toContain("token=");
    expect(JSON.stringify(sanitizeBackupForRead(backup))).not.toContain(secret);
    expect(artifact.metadata.remoteObjectKey).toBe(locator);
    expect(artifact.storageKey).toBe(credentialStorageKey);
    expect(backup.remoteObjectKey).toBe(locator);
  });

  it("fails closed on viewer migration diagnostics while retaining safe run status and counts", () => {
    const rawCanary = "migration-arbitrary-diagnostic-canary";
    const urlSecret = "migration-url-secret";
    const privatePath = "/srv/private/customer-a/compose";
    const unsafeUrl =
      `https://migration-user:${urlSecret}@worker.example.test/run?token=${urlSecret}`;
    const run = mapMigrationRun({
      id: "00000000-0000-4000-8000-000000000020",
      plan_run_id: "00000000-0000-4000-8000-000000000021",
      source_host_id: "00000000-0000-4000-8000-000000000022",
      target_host_id: "00000000-0000-4000-8000-000000000023",
      source_app_identity: {
        kind: "stack",
        stackId: "00000000-0000-4000-8000-000000000024",
        projectName: "authorized-app",
        label: rawCanary
      },
      mode: "execute",
      status: "failed",
      recovery_point_id: "00000000-0000-4000-8000-000000000025",
      plan: {
        sourceHostId: "00000000-0000-4000-8000-000000000022",
        targetHostId: "00000000-0000-4000-8000-000000000023",
        sourceAppIdentity: {
          kind: "stack",
          stackId: "00000000-0000-4000-8000-000000000024",
          label: `stale ${rawCanary}`
        },
        intent: {
          strategy: "safe_move",
          options: {
            stopSource: true,
            projectNameOverride: rawCanary,
            remapPorts: false,
            networkMode: "reuse"
          }
        },
        sourceFingerprint: "a".repeat(64),
        targetFingerprint: "b".repeat(64),
        steps: [{
          id: rawCanary,
          title: rawCanary,
          description: unsafeUrl,
          kind: "deploy",
          required: true
        }],
        warnings: [`${rawCanary} at ${privatePath}`, unsafeUrl],
        estimatedArtifacts: 5,
        estimatedVolumes: 2,
        estimatedHostFolders: 1,
        checks: {
          sourceHostAvailable: true,
          targetHostAvailable: true,
          sourceDockerAvailable: true,
          targetDockerAvailable: true,
          sourceComposeAvailable: true,
          targetComposeAvailable: false
        },
        portConflicts: [{
          hostPort: "8443",
          protocol: "tcp",
          sourceContainer: rawCanary,
          reason: `${rawCanary} at ${privatePath}`
        }],
        volumeCollisions: [`volume-${rawCanary}`],
        nameCollisions: [`container-${rawCanary}`],
        missingNetworks: [`network-${rawCanary}`],
        networkConflicts: [`${rawCanary} at ${privatePath}`],
        estimatedDataBytes: 4096,
        blockingIssues: [`${rawCanary} at ${privatePath}`]
      },
      error: `${rawCanary}: ${unsafeUrl}; ${privatePath}`,
      created_at: now,
      started_at: now,
      completed_at: now
    });

    const operator = sanitizeMigrationRunForRead(run);
    expect(JSON.stringify(operator)).toContain(rawCanary);
    expect(JSON.stringify(operator)).toContain(privatePath);
    expect(JSON.stringify(operator)).not.toContain(urlSecret);

    const viewer = redactMigrationRunForViewer(run);
    const serializedViewer = JSON.stringify(viewer);
    expect(serializedViewer).not.toContain(rawCanary);
    expect(serializedViewer).not.toContain(privatePath);
    expect(serializedViewer).not.toContain(urlSecret);
    expect(viewer).toMatchObject({
      mode: "execute",
      status: "failed",
      createdAt: now.toISOString(),
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
      error: expect.stringMatching(/operators and administrators/),
      plan: {
        intent: {
          strategy: "safe_move",
          options: {
            stopSource: true,
            remapPorts: false,
            networkMode: "reuse"
          }
        },
        sourceFingerprint: null,
        targetFingerprint: null,
        estimatedArtifacts: 5,
        estimatedVolumes: 2,
        estimatedHostFolders: 1,
        estimatedDataBytes: 4096
      }
    });
    expect(viewer.plan?.warnings).toHaveLength(2);
    expect(viewer.plan?.portConflicts).toHaveLength(1);
    expect(viewer.plan?.volumeCollisions).toHaveLength(1);
    expect(viewer.plan?.nameCollisions).toHaveLength(1);
    expect(viewer.plan?.missingNetworks).toHaveLength(1);
    expect(viewer.plan?.networkConflicts).toHaveLength(1);
    expect(viewer.plan?.blockingIssues).toHaveLength(1);
    expect(viewer.sourceAppIdentity).toEqual({
      kind: "stack",
      stackId: "00000000-0000-4000-8000-000000000024"
    });
    expect(viewer.plan?.sourceAppIdentity).toEqual(viewer.sourceAppIdentity);
    expect(run.plan?.warnings[0]).toContain(rawCanary);
  });
});
