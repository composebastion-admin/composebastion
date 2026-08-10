import type {
  DockerApp,
  MigrationExecutionOptions,
  MigrationRun,
  MigrationStrategy,
  RecoveryAppIdentity,
  RecoveryPointListItem,
  RecoveryReadiness
} from "@composebastion/shared";

export function dockerAppToRecoveryIdentity(app: DockerApp): RecoveryAppIdentity {
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
  throw new Error(`App ${app.name} cannot be captured for recovery`);
}

export function recoveryAppLabel(point: RecoveryPointListItem) {
  const identity = point.appIdentity;
  if ("label" in identity && identity.label) return identity.label;
  if (identity.kind === "compose") return identity.projectName;
  if (identity.kind === "stack") return identity.projectName ?? identity.stackId;
  if (identity.kind === "git") return identity.projectName ?? identity.repositoryId;
  if (identity.kind === "standalone") return identity.containerIds[0] ?? "Standalone app";
  return point.name ?? point.id;
}

export function recoveryIdentityKey(identity: RecoveryAppIdentity) {
  if (identity.kind === "compose") return `compose:${identity.projectName}`;
  if (identity.kind === "stack") return `stack:${identity.stackId}`;
  if (identity.kind === "git") return `git:${identity.repositoryId}`;
  return `standalone:${[...identity.containerIds].sort().join(",")}`;
}

export function dockerAppRecoveryKey(app: DockerApp) {
  return recoveryIdentityKey(dockerAppToRecoveryIdentity(app));
}

export function migrationPlanMatchesSelection(run: MigrationRun | null, selection: {
  sourceHostId: string;
  targetHostId: string;
  sourceAppIdentity: RecoveryAppIdentity;
  strategy: MigrationStrategy;
  options: MigrationExecutionOptions;
}) {
  const plan = run?.plan;
  if (!run || run.mode !== "plan" || run.status !== "completed" || !plan?.intent) return false;
  return plan.sourceHostId === selection.sourceHostId
    && plan.targetHostId === selection.targetHostId
    && recoveryIdentityKey(plan.sourceAppIdentity) === recoveryIdentityKey(selection.sourceAppIdentity)
    && plan.intent.strategy === selection.strategy
    && plan.intent.options.stopSource === selection.options.stopSource
    && plan.intent.options.projectNameOverride === selection.options.projectNameOverride
    && plan.intent.options.remapPorts === selection.options.remapPorts
    && plan.intent.options.networkMode === selection.options.networkMode;
}

export function recoveryReadinessLabel(status: RecoveryReadiness["status"]) {
  if (status === "ready") return "Ready";
  if (status === "needs_profile") return "Needs profile";
  if (status === "risky") return "Risky";
  return "Blocked";
}

export function recoveryReadinessClass(status: RecoveryReadiness["status"]) {
  if (status === "ready") return "ready";
  if (status === "needs_profile") return "needsProfile";
  return status;
}

export function recoveryLocalState(point: RecoveryPointListItem) {
  if (point.status === "running") return "running";
  if (point.status === "queued") return "queued";
  const retained = point.localRetainedArtifactCount ?? 0;
  const removed = point.localRemovedArtifactCount ?? 0;
  if (point.artifactCount > 0 && retained >= point.artifactCount) return "complete";
  if (point.artifactCount > 0 && removed >= point.artifactCount) return "removed";
  if (retained > 0 || removed > 0) return "partial";
  if (point.status === "failed") return "failed";
  return "unknown";
}

export function recoveryRemoteState(point: RecoveryPointListItem) {
  if (!point.backupTargetId) return "none";
  if (point.metadata.remoteUploadNotApplicable === true) return "none";
  const failureCount = point.remoteUploadFailureCount
    ?? (typeof point.metadata.remoteUploadFailureCount === "number" ? point.metadata.remoteUploadFailureCount : 0);
  const remoteArtifactCount = point.remoteArtifactCount ?? 0;
  if (failureCount > 0) return "partial";
  if (point.status === "failed") return "failed";
  const objectKeys = Array.isArray(point.metadata.remoteObjectKeys)
    ? point.metadata.remoteObjectKeys.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const expectedCount = typeof point.metadata.remoteUploadArtifactCount === "number"
    ? point.metadata.remoteUploadArtifactCount
    : 0;
  const verifiedCount = typeof point.metadata.remoteVerifiedArtifactCount === "number"
    ? point.metadata.remoteVerifiedArtifactCount
    : 0;
  const hasAggregateEvidence = point.artifactCount > 0 && remoteArtifactCount === point.artifactCount;
  const hasMetadataEvidence = point.metadata.remoteUploadComplete === true
    && expectedCount > 0
    && verifiedCount === expectedCount
    && objectKeys.length === expectedCount;
  const hasCompleteUploadEvidence = hasAggregateEvidence || hasMetadataEvidence;
  if (point.status === "completed" || point.status === "partial") {
    return hasCompleteUploadEvidence ? "synced" : "pending";
  }
  if (point.status === "running") return "uploading";
  return "pending";
}
