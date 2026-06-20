import { beforeEach, describe, expect, it, vi } from "vitest";

const listApps = vi.fn();
const analyzeRecovery = vi.fn();
const listRecoveryPoints = vi.fn();
const getRecoveryPoint = vi.fn();
const getBackupTarget = vi.fn();

vi.mock("../src/services/apps.js", () => ({
  listApps: (...args: unknown[]) => listApps(...args)
}));

vi.mock("../src/services/recoveryAnalysis.js", () => ({
  analyzeRecovery: (...args: unknown[]) => analyzeRecovery(...args)
}));

vi.mock("../src/services/recoveryCenter.js", () => ({
  listRecoveryPoints: (...args: unknown[]) => listRecoveryPoints(...args),
  getRecoveryPoint: (...args: unknown[]) => getRecoveryPoint(...args),
  getBackupTarget: (...args: unknown[]) => getBackupTarget(...args)
}));

const hostId = "00000000-0000-4000-8000-000000000001";
const stackId = "00000000-0000-4000-8000-000000000002";
const pointId = "00000000-0000-4000-8000-000000000003";
const targetId = "00000000-0000-4000-8000-000000000004";
const appIdentity = { kind: "stack", stackId, projectName: "openwebui", label: "Open WebUI" } as const;

function app(overrides: Record<string, unknown> = {}) {
  return {
    id: `stack:${stackId}`,
    hostId,
    hostName: "Lab",
    hostHostname: "lab.local",
    name: "Open WebUI",
    source: "compose",
    status: "running",
    imageReferences: ["ghcr.io/open-webui/open-webui:main"],
    ports: "3000:8080",
    containerIds: ["web-1"],
    primaryContainerId: "web-1",
    stackId,
    repositoryId: null,
    repositoryUrl: null,
    branch: null,
    projectName: "openwebui",
    sourceLink: null,
    update: { status: "up_to_date", kind: "none", checkedAt: null },
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    hostId,
    appIdentity,
    profile: {
      id: "00000000-0000-4000-8000-000000000005",
      hostId,
      appIdentity,
      name: "Open WebUI",
      includePaths: [],
      excludePatterns: [],
      restorePaths: {},
      preCaptureCommand: null,
      postCaptureCommand: null,
      captureMode: "hot",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    },
    status: "ready",
    recommendedCaptureMode: "hot",
    dataMounts: [{
      type: "volume",
      containerName: "web",
      source: "/var/lib/docker/volumes/openwebui/_data",
      name: "openwebui",
      destination: "/app/backend/data",
      readOnly: false,
      included: true,
      warning: null
    }],
    volumes: ["openwebui"],
    bindMounts: [],
    warnings: [],
    blockingIssues: [],
    ...overrides
  };
}

function point(overrides: Record<string, unknown> = {}) {
  return {
    id: pointId,
    hostId,
    name: "Open WebUI backup",
    appIdentity,
    triggerKind: "manual",
    status: "completed",
    backupTargetId: null,
    legacyVolumeBackupId: null,
    profileId: null,
    artifactCount: 1,
    completedArtifactCount: 1,
    totalBytes: 1024,
    error: null,
    metadata: { verifyStatus: "completed" },
    lastDrillAt: new Date(0).toISOString(),
    lastDrillStatus: "completed",
    lastDrillError: null,
    lastSuccessfulDrillAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
    artifacts: [{
      id: "00000000-0000-4000-8000-000000000006",
      recoveryPointId: pointId,
      kind: "volume",
      backupTargetId: null,
      storageKey: "volumes/openwebui.tar.gz",
      sizeBytes: 1024,
      checksum: "sha256:abc",
      status: "completed",
      error: null,
      metadata: {},
      createdAt: new Date(0).toISOString(),
      completedAt: new Date(0).toISOString()
    }],
    ...overrides
  };
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: targetId,
    name: "SMB vault",
    type: "rclone",
    kind: "rclone",
    enabled: true,
    config: {},
    endpoint: null,
    region: null,
    bucket: null,
    prefix: null,
    forcePathStyle: false,
    basePath: null,
    provider: "smb",
    rcloneProvider: "smb",
    remotePath: "backups",
    remoteName: "dockermender-smb",
    localCachePolicy: "keep",
    healthStatus: "healthy",
    healthCheckedAt: new Date(0).toISOString(),
    healthError: null,
    hasCredentials: true,
    hasSecretAccessKey: false,
    hasGenericConfig: true,
    hasGenericCredentials: true,
    accessKeyId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides
  };
}

describe("recovery readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listApps.mockResolvedValue([app()]);
    analyzeRecovery.mockResolvedValue(analysis());
    listRecoveryPoints.mockResolvedValue([{ id: pointId, hostId, appIdentity }]);
    getRecoveryPoint.mockResolvedValue(point());
    getBackupTarget.mockResolvedValue(null);
  });

  it("scores a verified app with a passed drill as ready", async () => {
    const { analyzeRecoveryReadiness } = await import("../src/services/recoveryReadiness.js");
    const readiness = await analyzeRecoveryReadiness({ hostId, appIdentity });

    expect(readiness.status).toBe("ready");
    expect(readiness.score).toBeGreaterThanOrEqual(90);
    expect(readiness.reasons).toEqual([]);
  });

  it("marks a database app without a profile as needing a profile", async () => {
    analyzeRecovery.mockResolvedValue(analysis({
      profile: null,
      recommendedCaptureMode: "stop_first",
      warnings: ["db looks like a database container, but no mounted database data directory was detected."]
    }));

    const { analyzeRecoveryReadiness } = await import("../src/services/recoveryReadiness.js");
    const readiness = await analyzeRecoveryReadiness({ hostId, appIdentity });

    expect(readiness.status).toBe("needs_profile");
    expect(readiness.score).toBeGreaterThanOrEqual(65);
    expect(readiness.reasons.map((reason) => reason.code)).toContain("profile_stop_first_missing");
  });

  it("marks failed remote target health as risky", async () => {
    analyzeRecovery.mockResolvedValue(analysis({ profile: null, recommendedCaptureMode: "stop_first" }));
    getRecoveryPoint.mockResolvedValue(point({ backupTargetId: targetId }));
    getBackupTarget.mockResolvedValue(target({ healthStatus: "failed", healthError: "connection refused" }));

    const { analyzeRecoveryReadiness } = await import("../src/services/recoveryReadiness.js");
    const readiness = await analyzeRecoveryReadiness({ hostId, appIdentity });

    expect(readiness.status).toBe("risky");
    expect(readiness.reasons.map((reason) => reason.code)).toContain("target_health_failed");
  });

  it("blocks apps without containers", async () => {
    listApps.mockResolvedValue([app({ containerIds: [], primaryContainerId: null })]);

    const { analyzeRecoveryReadiness } = await import("../src/services/recoveryReadiness.js");
    const readiness = await analyzeRecoveryReadiness({ hostId, appIdentity });

    expect(readiness.status).toBe("blocked");
    expect(readiness.score).toBeLessThanOrEqual(29);
    expect(readiness.reasons.map((reason) => reason.code)).toContain("no_containers");
  });

  it("blocks included host paths that recovery safety rules reject", async () => {
    analyzeRecovery.mockResolvedValue(analysis({
      dataMounts: [{
        type: "bind",
        containerName: "web",
        source: "/etc/app",
        name: null,
        destination: "/config",
        readOnly: false,
        included: true,
        warning: null
      }],
      bindMounts: ["/etc/app"]
    }));

    const { analyzeRecoveryReadiness } = await import("../src/services/recoveryReadiness.js");
    const readiness = await analyzeRecoveryReadiness({ hostId, appIdentity });

    expect(readiness.status).toBe("blocked");
    expect(readiness.reasons.map((reason) => reason.code)).toContain("host_path_blocked");
  });

  it("blocks a point with no usable artifact", async () => {
    getRecoveryPoint.mockResolvedValue(point({
      artifactCount: 1,
      completedArtifactCount: 0,
      artifacts: []
    }));

    const { analyzeRecoveryReadiness } = await import("../src/services/recoveryReadiness.js");
    const readiness = await analyzeRecoveryReadiness({ hostId, appIdentity });

    expect(readiness.status).toBe("blocked");
    expect(readiness.reasons.map((reason) => reason.code)).toContain("artifact_capture_incomplete");
  });

  it("does not block a remote-only point with a downloadable remote artifact", async () => {
    getRecoveryPoint.mockResolvedValue(point({
      backupTargetId: targetId,
      artifacts: [{
        ...point().artifacts[0],
        backupTargetId: targetId,
        metadata: {
          remoteObjectKey: "points/openwebui/volume.tar.gz",
          localCachePolicy: "remote_only"
        }
      }]
    }));
    getBackupTarget.mockResolvedValue(target({ localCachePolicy: "remote_only" }));

    const { analyzeRecoveryReadiness } = await import("../src/services/recoveryReadiness.js");
    const readiness = await analyzeRecoveryReadiness({ hostId, appIdentity });

    expect(readiness.status).toBe("ready");
    expect(readiness.lastRecoveryPoint?.localUsable).toBe(false);
    expect(readiness.lastRecoveryPoint?.remoteUsable).toBe(true);
  });
});
