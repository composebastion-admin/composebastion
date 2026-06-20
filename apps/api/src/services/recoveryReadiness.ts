import type {
  BackupTarget,
  DockerApp,
  RecoveryAnalysis,
  RecoveryAppIdentity,
  RecoveryPointDetail,
  RecoveryReadiness,
  RecoveryReadinessReason
} from "@composebastion/shared";
import { recoveryReadinessSchema } from "@composebastion/shared";
import { listApps } from "./apps.js";
import { assertHostBackupPathAllowed } from "./backupHostPaths.js";
import { analyzeRecovery } from "./recoveryAnalysis.js";
import { getBackupTarget, getRecoveryPoint, listRecoveryPoints } from "./recoveryCenter.js";
import { isAllowedBindMountPath } from "./recoveryManifest.js";

type ReadinessInput = {
  hostId: string;
  appIdentity: RecoveryAppIdentity;
  label?: string;
};

type PointUsability = {
  localUsable: boolean;
  remoteUsable: boolean;
};

const DATABASE_WARNING_HINTS = [
  "database container",
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "valkey",
  "influx",
  "clickhouse",
  "elasticsearch",
  "opensearch",
  "mssql"
];

function scoreFor(status: RecoveryReadiness["status"], reasons: RecoveryReadinessReason[]) {
  const deductions = reasons.reduce((total, reason) => {
    if (reason.severity === "critical") return total + 35;
    if (reason.severity === "warning") return total + 15;
    return total + 5;
  }, 0);
  const rawScore = Math.max(0, Math.min(100, 100 - deductions));
  if (status === "ready") return Math.max(90, rawScore);
  if (status === "needs_profile") return Math.max(65, Math.min(84, rawScore));
  if (status === "risky") return Math.max(30, Math.min(64, rawScore));
  return Math.max(0, Math.min(29, rawScore));
}

function uniqueReasons(reasons: RecoveryReadinessReason[]) {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = `${reason.code}:${reason.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statusFor(reasons: RecoveryReadinessReason[]) {
  if (reasons.some((reason) => reason.severity === "critical")) return "blocked" as const;
  if (reasons.some((reason) => reason.severity === "warning" && !reason.code.startsWith("profile_"))) return "risky" as const;
  if (reasons.some((reason) => reason.code.startsWith("profile_"))) return "needs_profile" as const;
  if (reasons.some((reason) => reason.severity === "warning")) return "risky" as const;
  return "ready" as const;
}

export function recoveryIdentityKey(identity: RecoveryAppIdentity) {
  if (identity.kind === "stack") return `stack:${identity.stackId}`;
  if (identity.kind === "git") return `git:${identity.repositoryId}`;
  if (identity.kind === "compose") return `compose:${identity.projectName}`;
  return `standalone:${[...identity.containerIds].sort().join(",")}`;
}

function dockerAppToRecoveryIdentity(app: DockerApp): RecoveryAppIdentity {
  if (app.stackId) {
    return {
      kind: "stack",
      stackId: app.stackId,
      projectName: app.projectName ?? undefined,
      label: app.name
    };
  }
  if (app.source === "git" && app.repositoryId) {
    return {
      kind: "git",
      repositoryId: app.repositoryId,
      projectName: app.projectName ?? undefined,
      label: app.name
    };
  }
  if (app.projectName) {
    return {
      kind: "compose",
      projectName: app.projectName,
      stackId: app.stackId ?? undefined,
      label: app.name
    };
  }
  if (app.containerIds.length) {
    return {
      kind: "standalone",
      containerIds: app.containerIds,
      label: app.name
    };
  }
  return {
    kind: "standalone",
    containerIds: [app.primaryContainerId ?? app.id],
    label: app.name
  };
}

function identityLabel(identity: RecoveryAppIdentity) {
  if ("label" in identity && identity.label) return identity.label;
  if (identity.kind === "stack") return identity.projectName ?? identity.stackId;
  if (identity.kind === "git") return identity.projectName ?? identity.repositoryId;
  if (identity.kind === "compose") return identity.projectName;
  return identity.containerIds[0] ?? "Standalone app";
}

function hasDatabaseWarning(analysis: RecoveryAnalysis) {
  const haystack = analysis.warnings.join(" ").toLowerCase();
  return DATABASE_WARNING_HINTS.some((hint) => haystack.includes(hint));
}

function hasWritableLayerWarning(analysis: RecoveryAnalysis) {
  return analysis.warnings.some((warning) => warning.toLowerCase().includes("writable layer"));
}

function hasTmpfsWarning(analysis: RecoveryAnalysis) {
  return analysis.warnings.some((warning) => warning.toLowerCase().includes("tmpfs"));
}

function hasRemoteObject(detail: RecoveryPointDetail) {
  return detail.artifacts
    .filter((artifact) => artifact.status === "completed")
    .some((artifact) => typeof artifact.metadata.remoteObjectKey === "string" && artifact.metadata.remoteObjectKey);
}

function pointUsability(detail: RecoveryPointDetail, target: BackupTarget | null): PointUsability {
  const hasCompletedArtifacts = detail.completedArtifactCount > 0 &&
    detail.artifacts.some((artifact) => artifact.status === "completed");
  if (!hasCompletedArtifacts) return { localUsable: false, remoteUsable: false };

  const remoteUsable = Boolean(target && target.enabled && hasRemoteObject(detail));
  const remoteOnly = target?.localCachePolicy === "remote_only" || detail.artifacts.some((artifact) => artifact.metadata.localCachePolicy === "remote_only");
  const localUsable = !remoteOnly;
  return { localUsable, remoteUsable };
}

async function latestMatchingRecoveryPoint(hostId: string, appIdentity: RecoveryAppIdentity) {
  const targetKey = recoveryIdentityKey(appIdentity);
  const points = await listRecoveryPoints({ hostId });
  const match = points.find((point) => recoveryIdentityKey(point.appIdentity) === targetKey);
  return match ? getRecoveryPoint(match.id) : null;
}

async function findMatchingApp(hostId: string, appIdentity: RecoveryAppIdentity) {
  const targetKey = recoveryIdentityKey(appIdentity);
  const apps = await listApps(hostId);
  return apps.find((app) => recoveryIdentityKey(dockerAppToRecoveryIdentity(app)) === targetKey) ?? null;
}

function latestPointSummary(detail: RecoveryPointDetail, usability: PointUsability) {
  return {
    id: detail.id,
    status: detail.status,
    createdAt: detail.createdAt,
    completedAt: detail.completedAt,
    verified: detail.metadata.verifyStatus === "completed",
    artifactCount: detail.artifactCount,
    completedArtifactCount: detail.completedArtifactCount,
    backupTargetId: detail.backupTargetId,
    localUsable: usability.localUsable,
    remoteUsable: usability.remoteUsable,
    error: detail.error
  };
}

function drillSummary(detail: RecoveryPointDetail | null) {
  if (!detail) return null;
  return {
    lastDrillAt: detail.lastDrillAt,
    lastDrillStatus: detail.lastDrillStatus,
    lastDrillError: detail.lastDrillError,
    lastSuccessfulDrillAt: detail.lastSuccessfulDrillAt,
    passed: Boolean(detail.lastSuccessfulDrillAt)
  };
}

function targetHealthSummary(target: BackupTarget | null) {
  if (!target) return null;
  return {
    targetId: target.id,
    targetName: target.name,
    status: target.healthStatus,
    checkedAt: target.healthCheckedAt,
    error: target.healthError
  };
}

function analysisReasons(analysis: RecoveryAnalysis, matchingApp: DockerApp | null): RecoveryReadinessReason[] {
  const reasons: RecoveryReadinessReason[] = [];
  if (matchingApp && matchingApp.containerIds.length === 0) {
    reasons.push({
      code: "no_containers",
      severity: "critical",
      message: "No running or stopped containers are currently associated with this app.",
      action: "Deploy or relink the app before relying on recovery captures."
    });
  }
  for (const issue of analysis.blockingIssues) {
    reasons.push({
      code: "analysis_blocked",
      severity: "critical",
      message: issue,
      action: "Fix the inventory issue, then refresh readiness."
    });
  }
  if (!analysis.dataMounts.some((mount) => mount.included) && hasDatabaseWarning(analysis)) {
    reasons.push({
      code: "stateful_without_persistent_data",
      severity: "critical",
      message: "This looks stateful, but no persistent data location was detected.",
      action: "Add a named volume, allowed bind mount, or manual include path profile before backup."
    });
  }
  for (const mount of analysis.dataMounts) {
    if (!mount.included || !mount.source || !["bind", "manual", "compose_working_dir"].includes(mount.type)) continue;
    try {
      assertHostBackupPathAllowed(mount.source, "Recovery source path");
      if (!isAllowedBindMountPath(mount.source)) throw new Error(`Recovery source path ${mount.source} is blocked by recovery path safety rules`);
    } catch (error) {
      reasons.push({
        code: "host_path_blocked",
        severity: "critical",
        message: error instanceof Error ? error.message : String(error),
        action: "Move the data under BACKUP_HOST_PATH_ALLOWED_ROOTS or update the app profile to include an allowed path."
      });
    }
  }
  if (analysis.recommendedCaptureMode === "stop_first" && !analysis.profile) {
    reasons.push({
      code: "profile_stop_first_missing",
      severity: "warning",
      message: "A stop-first capture profile is recommended, but no recovery profile is saved.",
      action: "Save a recovery profile with stop-first capture guidance for this app."
    });
  }
  if (hasDatabaseWarning(analysis) && !analysis.profile) {
    reasons.push({
      code: "profile_database_missing",
      severity: "warning",
      message: "Database-like containers should have an explicit recovery profile.",
      action: "Add manual include paths, excludes, and restore preferences for the database app."
    });
  }
  if (hasTmpfsWarning(analysis)) {
    reasons.push({
      code: "tmpfs_storage",
      severity: "warning",
      message: "tmpfs data is memory-backed and cannot be captured.",
      action: "Move important tmpfs data to a named volume or bind mount."
    });
  }
  if (hasWritableLayerWarning(analysis)) {
    reasons.push({
      code: "writable_layer_storage",
      severity: "warning",
      message: "Mutable data may be inside the container writable layer.",
      action: "Mount important data paths or add manual include paths in a profile."
    });
  }
  return reasons;
}

function pointReasons(detail: RecoveryPointDetail | null, target: BackupTarget | null, usability: PointUsability | null): RecoveryReadinessReason[] {
  if (!detail) {
    return [{
      code: "no_recovery_point",
      severity: "warning",
      message: "No recovery point has completed for this app yet.",
      action: "Create and verify a recovery point."
    }];
  }

  const reasons: RecoveryReadinessReason[] = [];
  if (detail.status === "failed") {
    reasons.push({
      code: "latest_point_failed",
      severity: "warning",
      message: detail.error ? `Latest recovery point failed: ${detail.error}` : "Latest recovery point failed.",
      action: "Open the failed point, fix the capture issue, and run a new backup."
    });
  } else if (detail.status !== "completed") {
    reasons.push({
      code: "latest_point_incomplete",
      severity: "warning",
      message: `Latest recovery point is ${detail.status}.`,
      action: "Wait for it to complete or create a fresh recovery point."
    });
  }

  if (detail.completedArtifactCount < detail.artifactCount) {
    reasons.push({
      code: "artifact_capture_incomplete",
      severity: detail.completedArtifactCount === 0 ? "critical" : "warning",
      message: "Not all recovery artifacts completed successfully.",
      action: "Verify the recovery point details and rerun capture if needed."
    });
  }

  if (usability && detail.status !== "failed" && !usability.localUsable && !usability.remoteUsable) {
    reasons.push({
      code: "no_usable_artifact",
      severity: "critical",
      message: "The latest recovery point has no usable local or remote artifact.",
      action: "Recreate the recovery point or restore the missing backup target."
    });
  }

  if (detail.status === "completed" && detail.metadata.verifyStatus !== "completed") {
    reasons.push({
      code: "not_verified",
      severity: "warning",
      message: "Latest recovery point has not passed verification.",
      action: "Run Verify on the latest recovery point."
    });
  }

  if (!detail.lastSuccessfulDrillAt) {
    reasons.push({
      code: "no_successful_drill",
      severity: "warning",
      message: "No successful restore drill is recorded for the latest recovery point.",
      action: "Run a clone restore drill and confirm the app starts."
    });
  }

  if (target && target.kind !== "local") {
    if (!target.enabled) {
      reasons.push({
        code: "target_disabled",
        severity: "warning",
        message: "The backup target for the latest point is disabled.",
        action: "Enable the target or capture to a healthy target."
      });
    } else if (target.healthStatus === "failed") {
      reasons.push({
        code: "target_health_failed",
        severity: "warning",
        message: target.healthError ? `Backup target health check failed: ${target.healthError}` : "Backup target health check failed.",
        action: "Test and repair the backup target connection."
      });
    } else if (target.healthStatus !== "healthy") {
      reasons.push({
        code: "target_health_unknown",
        severity: "warning",
        message: "Backup target health has not been confirmed.",
        action: "Run a connection test for this backup target."
      });
    }
  }

  if (detail.backupTargetId && !target) {
    reasons.push({
      code: "target_missing",
      severity: usability?.localUsable ? "warning" : "critical",
      message: "The backup target used by the latest recovery point no longer exists.",
      action: "Recreate the target or capture a new recovery point."
    });
  }

  return reasons;
}

export async function analyzeRecoveryReadiness(input: ReadinessInput): Promise<RecoveryReadiness> {
  const label = input.label ?? identityLabel(input.appIdentity);
  const matchingApp = await findMatchingApp(input.hostId, input.appIdentity);
  let analysis: RecoveryAnalysis;
  try {
    analysis = await analyzeRecovery({ hostId: input.hostId, appIdentity: input.appIdentity });
  } catch (error) {
    const reasons: RecoveryReadinessReason[] = [{
      code: "analysis_failed",
      severity: "critical",
      message: error instanceof Error ? error.message : String(error),
      action: "Refresh host inventory, then retry readiness analysis."
    }];
    return recoveryReadinessSchema.parse({
      hostId: input.hostId,
      appIdentity: input.appIdentity,
      label,
      status: "blocked",
      score: scoreFor("blocked", reasons),
      reasons,
      recommendedCaptureMode: "hot",
      lastRecoveryPoint: null,
      lastDrill: null,
      profile: null,
      targetHealth: null,
      dataMounts: []
    });
  }

  const latestPoint = await latestMatchingRecoveryPoint(input.hostId, input.appIdentity);
  const target = latestPoint?.backupTargetId ? await getBackupTarget(latestPoint.backupTargetId) : null;
  const usability = latestPoint ? pointUsability(latestPoint, target) : null;
  const reasons = uniqueReasons([
    ...analysisReasons(analysis, matchingApp),
    ...pointReasons(latestPoint, target, usability)
  ]);
  const status = statusFor(reasons);

  return recoveryReadinessSchema.parse({
    hostId: input.hostId,
    appIdentity: input.appIdentity,
    label,
    status,
    score: scoreFor(status, reasons),
    reasons,
    recommendedCaptureMode: analysis.recommendedCaptureMode,
    lastRecoveryPoint: latestPoint && usability ? latestPointSummary(latestPoint, usability) : null,
    lastDrill: drillSummary(latestPoint),
    profile: analysis.profile,
    targetHealth: targetHealthSummary(target),
    dataMounts: analysis.dataMounts
  });
}

export async function listRecoveryReadiness(hostId?: string): Promise<RecoveryReadiness[]> {
  const apps = await listApps(hostId);
  const results = await Promise.all(apps.map((app) => analyzeRecoveryReadiness({
    hostId: app.hostId,
    appIdentity: dockerAppToRecoveryIdentity(app),
    label: app.name
  })));
  return results.sort((a, b) => a.label.localeCompare(b.label));
}
