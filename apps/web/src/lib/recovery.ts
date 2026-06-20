import type { DockerApp, RecoveryAppIdentity, RecoveryPointListItem, RecoveryReadiness } from "@composebastion/shared";

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
  if (point.status === "completed") return "complete";
  if (point.status === "partial") return "partial";
  if (point.status === "failed") return "failed";
  if (point.status === "running") return "running";
  return "queued";
}

export function recoveryRemoteState(point: RecoveryPointListItem) {
  if (!point.backupTargetId) return "none";
  if (point.status === "partial") return "partial";
  if (point.status === "failed") return "failed";
  if (point.status === "completed") return "synced";
  if (point.status === "running") return "uploading";
  return "pending";
}
