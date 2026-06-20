import { describe, expect, it } from "vitest";
import {
  backupTargetCreateSchema,
  backupTargetSchema,
  migrationExecuteRequestSchema,
  migrationPlanRequestSchema,
  migrationRunSchema,
  recoveryAppIdentitySchema,
  recoveryPointCreateSchema,
  recoveryPointDetailSchema,
  recoveryReadinessSchema,
  recoveryRestoreRequestSchema
} from "./recoveryCenter.js";

const hostId = "00000000-0000-4000-8000-000000000001";
const stackId = "00000000-0000-4000-8000-000000000002";
const repoId = "00000000-0000-4000-8000-000000000003";
const pointId = "00000000-0000-4000-8000-000000000004";
const targetId = "00000000-0000-4000-8000-000000000005";

describe("recovery center schemas", () => {
  it("validates backup target create payloads", () => {
    const local = backupTargetCreateSchema.parse({
      name: "Local vault",
      kind: "local"
    });
    expect(local.kind).toBe("local");
    expect(local.enabled).toBe(true);

    const s3 = backupTargetCreateSchema.parse({
      name: "Offsite",
      kind: "s3",
      config: {
        endpoint: "https://s3.example.com",
        bucket: "recovery",
        prefix: "composebastion/"
      },
      accessKeyId: "key",
      secretAccessKey: "secret"
    });
    expect(s3.config.bucket).toBe("recovery");
    expect(() => backupTargetCreateSchema.parse({
      name: "Bad",
      kind: "s3",
      config: { endpoint: "not-a-url", bucket: "recovery" }
    })).toThrow();
  });

  it("validates app identity variants", () => {
    expect(recoveryAppIdentitySchema.parse({
      kind: "stack",
      stackId
    }).kind).toBe("stack");
    expect(recoveryAppIdentitySchema.parse({
      kind: "compose",
      projectName: "openwebui"
    }).projectName).toBe("openwebui");
    expect(recoveryAppIdentitySchema.parse({
      kind: "git",
      repositoryId: repoId
    }).repositoryId).toBe(repoId);
    expect(recoveryAppIdentitySchema.parse({
      kind: "standalone",
      containerIds: ["web-1"]
    }).containerIds).toEqual(["web-1"]);
  });

  it("validates recovery point create and restore requests", () => {
    const created = recoveryPointCreateSchema.parse({
      hostId,
      name: "Pre-upgrade",
      appIdentity: { kind: "compose", projectName: "openwebui" },
      backupTargetId: targetId
    });
    expect(created.triggerKind).toBe("manual");

    const restore = recoveryRestoreRequestSchema.parse({
      recoveryPointId: pointId,
      targetHostId: hostId
    });
    expect(restore.options.stopExisting).toBe(false);
    expect(restore.options.mode).toBe("clone");
  });

  it("validates migration plan and execute requests", () => {
    const plan = migrationPlanRequestSchema.parse({
      sourceHostId: hostId,
      targetHostId: "00000000-0000-4000-8000-000000000010",
      sourceAppIdentity: { kind: "stack", stackId }
    });
    expect(plan.createRecoveryPoint).toBe(true);

    const execute = migrationExecuteRequestSchema.parse({
      sourceHostId: hostId,
      targetHostId: "00000000-0000-4000-8000-000000000010",
      sourceAppIdentity: { kind: "stack", stackId },
      recoveryPointId: pointId
    });
    expect(execute.options.stopSource).toBe(false);
    expect(execute.strategy).toBe("clone");
  });

  it("accepts mapped API shapes for backup targets and recovery point detail", () => {
    const target = backupTargetSchema.parse({
      id: targetId,
      name: "Local vault",
      type: "local",
      kind: "local",
      enabled: true,
      config: {},
      endpoint: null,
      region: null,
      bucket: null,
      prefix: null,
      forcePathStyle: false,
      basePath: null,
      provider: null,
      rcloneProvider: null,
      remotePath: null,
      remoteName: null,
      localCachePolicy: "keep",
      healthStatus: "unknown",
      healthCheckedAt: null,
      healthError: null,
      hasCredentials: false,
      hasSecretAccessKey: false,
      hasGenericConfig: false,
      hasGenericCredentials: false,
      accessKeyId: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    });
    expect(target.kind).toBe("local");

    const detail = recoveryPointDetailSchema.parse({
      id: pointId,
      hostId,
      name: "Snapshot",
      appIdentity: { kind: "compose", projectName: "openwebui" },
      triggerKind: "manual",
      status: "completed",
      backupTargetId: targetId,
      legacyVolumeBackupId: null,
      artifactCount: 1,
      completedArtifactCount: 1,
      totalBytes: 1024,
      error: null,
      metadata: {},
      createdAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString(),
      lastDrillAt: null,
      lastDrillStatus: null,
      lastDrillError: null,
      lastSuccessfulDrillAt: null,
      artifacts: [{
        id: "00000000-0000-4000-8000-000000000006",
        recoveryPointId: pointId,
        kind: "compose_yaml",
        backupTargetId: targetId,
        storageKey: "points/point/compose.yaml",
        sizeBytes: 1024,
        checksum: "sha256:abc",
        status: "completed",
        error: null,
        metadata: {},
        createdAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString()
      }]
    });
    expect(detail.artifacts).toHaveLength(1);

    const run = migrationRunSchema.parse({
      id: "00000000-0000-4000-8000-000000000007",
      sourceHostId: hostId,
      targetHostId: "00000000-0000-4000-8000-000000000010",
      sourceAppIdentity: { kind: "stack", stackId },
      mode: "plan",
      status: "completed",
      recoveryPointId: null,
      plan: {
        sourceHostId: hostId,
        targetHostId: "00000000-0000-4000-8000-000000000010",
        sourceAppIdentity: { kind: "stack", stackId },
        steps: [{
          id: "backup",
          title: "Capture recovery point",
          description: "Back up compose and volumes",
          kind: "backup"
        }],
        warnings: [],
        estimatedArtifacts: 2,
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
      createdAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString()
    });
    expect(run.plan?.steps).toHaveLength(1);
  });

  it("validates recovery readiness payloads", () => {
    const readiness = recoveryReadinessSchema.parse({
      hostId,
      appIdentity: { kind: "compose", projectName: "openwebui" },
      label: "Open WebUI",
      status: "needs_profile",
      score: 76,
      reasons: [{
        code: "profile_stop_first_missing",
        severity: "warning",
        message: "A stop-first capture profile is recommended.",
        action: "Save a recovery profile."
      }],
      recommendedCaptureMode: "stop_first",
      lastRecoveryPoint: {
        id: pointId,
        status: "completed",
        createdAt: new Date(0).toISOString(),
        completedAt: new Date(0).toISOString(),
        verified: true,
        artifactCount: 2,
        completedArtifactCount: 2,
        backupTargetId: targetId,
        localUsable: false,
        remoteUsable: true,
        error: null
      },
      lastDrill: {
        lastDrillAt: new Date(0).toISOString(),
        lastDrillStatus: "completed",
        lastDrillError: null,
        lastSuccessfulDrillAt: new Date(0).toISOString(),
        passed: true
      },
      profile: null,
      targetHealth: {
        targetId,
        targetName: "SMB vault",
        status: "healthy",
        checkedAt: new Date(0).toISOString(),
        error: null
      },
      dataMounts: [{
        type: "volume",
        containerName: "db",
        source: "/var/lib/docker/volumes/openwebui/_data",
        name: "openwebui",
        destination: "/var/lib/postgresql/data",
        readOnly: false,
        included: true,
        warning: null
      }]
    });

    expect(readiness.status).toBe("needs_profile");
    expect(readiness.lastRecoveryPoint?.remoteUsable).toBe(true);
  });
});
