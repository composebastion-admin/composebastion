import { describe, expect, it } from "vitest";
import {
  mapBackupTarget,
  mapMigrationRun,
  mapRecoveryArtifact,
  mapRecoveryPoint,
  mapRecoverySchedule
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
      total_bytes: "4096",
      error: null,
      metadata: { note: "test" },
      created_at: now,
      started_at: now,
      completed_at: now
    });
    expect(point.appIdentity.kind).toBe("compose");
    expect(point.totalBytes).toBe(4096);

    const artifact = mapRecoveryArtifact({
      id: "00000000-0000-4000-8000-000000000004",
      recovery_point_id: point.id,
      kind: "volume",
      backup_target_id: null,
      storage_key: "points/point/data.tar.gz",
      size_bytes: 2048,
      checksum: "sha256:abc",
      status: "completed",
      error: null,
      metadata: {},
      created_at: now,
      completed_at: now
    });
    expect(artifact.storageKey).toBe("points/point/data.tar.gz");

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
      next_run_at: now,
      created_at: now,
      updated_at: now
    });
    expect(schedule.intervalMs).toBe(3_600_000);

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
      error: null,
      created_at: now,
      started_at: now,
      completed_at: now
    });
    expect(migration.plan?.estimatedArtifacts).toBe(0);
  });
});
