import type {
  Backup,
  BackupTarget,
  ComposeStack,
  DockerHost,
  MigrationPlan,
  MigrationRun,
  OperationJob,
  RecoveryAppIdentity,
  RecoveryArtifact,
  RecoveryPointDetail,
  RecoveryPointListItem,
  RecoverySchedule,
  ResourceSnapshot
} from "@composebastion/shared";
import {
  migrationPlanSchema,
  recoveryAppIdentitySchema,
  sanitizeGitRepositoryUrl,
  sanitizeGitRepositoryUrlFields,
  sanitizeUrlDiagnosticText
} from "@composebastion/shared";
import { mapBackupTargetFields } from "./recoveryBackupTargets.js";

const iso = (value: Date | string | null | undefined) => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

function publicAgentUrl(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function mapHost(row: any): DockerHost {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    port: Number(row.port),
    username: row.username,
    connectionMode: row.connection_mode ?? "ssh",
    sshAuthType: row.ssh_auth_type ?? "key",
    // Legacy/imported rows may predate URL validation. Never reflect embedded
    // URL credentials or token-like query/fragment data to any role.
    agentUrl: publicAgentUrl(row.agent_url),
    dockerSocketPath: row.docker_socket_path,
    tags: row.tags ?? [],
    lastStatus: row.last_status,
    lastSeenAt: iso(row.last_seen_at),
    lastError: sanitizeUrlDiagnosticText(row.last_error ?? null) as string | null,
    dockerVersion: row.docker_version,
    composeVersion: row.compose_version,
    agentVersion: row.agent_version ?? null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export function mapResource(row: any): ResourceSnapshot {
  return {
    id: row.id,
    hostId: row.host_id,
    kind: row.kind,
    externalId: row.external_id,
    name: row.name,
    data: row.data ?? {},
    updatedAt: iso(row.updated_at)!
  };
}

export function mapStack(row: any): ComposeStack {
  return {
    id: row.id,
    hostId: row.host_id,
    name: row.name,
    projectName: row.project_name,
    composeYaml: row.compose_yaml,
    env: row.env ?? "",
    status: row.status,
    currentVersionId: row.current_version_id ?? null,
    currentVersionNumber: row.current_version_number === null || row.current_version_number === undefined
      ? null
      : Number(row.current_version_number),
    domains: row.domains ?? [],
    exposedService: row.exposed_service ?? null,
    exposedPort: row.exposed_port === null || row.exposed_port === undefined ? null : Number(row.exposed_port),
    tlsDesired: row.tls_desired ?? false,
    updatePolicyEnabled: row.update_policy_enabled ?? false,
    updatePolicyChannel: row.update_policy_channel ?? null,
    sourceType: row.source_type ?? "ui",
    sourceRepositoryUrl: sanitizeGitRepositoryUrl(row.source_repository_url),
    sourceBranch: row.source_branch ?? null,
    sourceWorkingDir: row.source_working_dir ?? null,
    sourceComposePath: row.source_compose_path ?? null,
    sourceCurrentCommitSha: row.source_current_commit_sha ?? null,
    sourceLatestCommitSha: row.source_latest_commit_sha ?? null,
    deploymentSourceId: row.deployment_source_id ?? null,
    sourceCheckedAt: iso(row.source_checked_at),
    sourceCheckError: sanitizeUrlDiagnosticText(row.source_check_error ?? null) as string | null,
    lastDeployError: sanitizeUrlDiagnosticText(row.last_deploy_error ?? null) as string | null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export function redactStackSensitiveFields(stack: ComposeStack): ComposeStack {
  return {
    ...stack,
    composeYaml: "",
    env: "",
    sourceRepositoryUrl: null,
    sourceWorkingDir: null,
    sourceComposePath: null,
    sourceCheckError: stack.sourceCheckError ? "Source check failed; details require operator access." : null,
    lastDeployError: stack.lastDeployError ? "Deployment failed; details require operator access." : null,
    sensitiveFieldsRedacted: true
  };
}

export function mapBackup(row: any): Backup {
  return {
    id: row.id,
    hostId: row.host_id,
    kind: row.kind ?? "volume",
    volumeName: row.volume_name ?? null,
    sourcePath: row.source_path ?? null,
    targetVolumeName: row.target_volume_name,
    fileName: row.file_name,
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    checksum: row.checksum ?? null,
    backupTargetId: row.backup_target_id ?? null,
    remoteObjectKey: row.remote_object_key ?? null,
    encryption: row.encryption ?? "none",
    encryptionKeyId: row.encryption_key_id ?? null,
    encryptionKeyFingerprint: row.encryption_key_fingerprint ?? null,
    verifiedAt: iso(row.verified_at),
    lastDrillAt: iso(row.last_drill_at),
    lastDrillStatus: row.last_drill_status ?? null,
    status: row.status,
    error: sanitizeUrlDiagnosticText(row.error ?? null) as string | null,
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at),
    // This mapper is also used by restore, verify, retention, and deletion.
    // Keep authoritative object locators byte-for-byte intact internally.
    metadata: row.metadata ?? {}
  };
}

export function sanitizeBackupForRead(backup: Backup): Backup {
  return {
    ...backup,
    remoteObjectKey: sanitizeUrlDiagnosticText(backup.remoteObjectKey) as string | null,
    metadata: sanitizeGitRepositoryUrlFields(backup.metadata)
  };
}

export function mapJob(row: any): OperationJob {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    hostId: row.host_id,
    payload: row.payload ?? {},
    result: row.result,
    progress: row.progress ?? [],
    correlationId: row.id,
    error: row.error,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at)
  };
}

export function sanitizeOperationJobForRead(job: OperationJob): OperationJob {
  return {
    ...job,
    payload: sanitizeGitRepositoryUrlFields(job.payload),
    result: job.result === null ? null : sanitizeGitRepositoryUrlFields(job.result),
    progress: sanitizeGitRepositoryUrlFields(job.progress),
    error: sanitizeUrlDiagnosticText(job.error) as string | null
  };
}

export function redactJobSensitiveFields(job: OperationJob): OperationJob {
  return {
    ...job,
    payload: {},
    result: null,
    progress: job.progress.map(({ id, label, status }) => ({ id, label, status })),
    error: job.error ? "Operation failed; details require operator access." : null,
    sensitiveFieldsRedacted: true
  };
}

export function mapAdmin(row: any) {
  return {
    id: row.id,
    name: row.name ?? null,
    username: row.username ?? null,
    email: row.email,
    role: row.role ?? "owner",
    isActive: row.is_active ?? true,
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at)!
  };
}

function parseAppIdentity(value: unknown): RecoveryAppIdentity {
  return recoveryAppIdentitySchema.parse(value);
}

function parseMigrationPlan(value: unknown): MigrationPlan | null {
  if (!value) return null;
  return migrationPlanSchema.parse(value);
}

function toCount(value: unknown) {
  return value === null || value === undefined ? 0 : Number(value);
}

function toNullableNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

export function mapBackupTarget(row: any): BackupTarget {
  return mapBackupTargetFields(row);
}

export function mapRecoveryArtifact(row: any): RecoveryArtifact {
  return {
    id: row.id,
    recoveryPointId: row.recovery_point_id,
    kind: row.kind,
    backupTargetId: row.backup_target_id ?? null,
    storageKey: row.storage_key,
    sizeBytes: toNullableNumber(row.size_bytes),
    checksum: row.checksum ?? null,
    status: row.status,
    error: sanitizeUrlDiagnosticText(row.error ?? null) as string | null,
    // Restore, verify, and deletion consume this metadata. Redaction belongs
    // at the API boundary so valid URL-shaped storage keys are never mutated.
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at)
  };
}

export function sanitizeRecoveryArtifactForRead(artifact: RecoveryArtifact): RecoveryArtifact {
  return {
    ...artifact,
    storageKey: sanitizeUrlDiagnosticText(artifact.storageKey) as string,
    metadata: sanitizeGitRepositoryUrlFields(artifact.metadata)
  };
}

export function recoveryArtifactEvidenceCounts(artifacts: RecoveryArtifact[]) {
  let remoteArtifactCount = 0;
  let remoteUploadFailureCount = 0;
  let localRetainedArtifactCount = 0;
  let localRemovedArtifactCount = 0;

  for (const artifact of artifacts) {
    const metadata = artifact.metadata;
    const remoteObjectKey = typeof metadata.remoteObjectKey === "string"
      ? metadata.remoteObjectKey
      : "";
    if (remoteObjectKey) remoteArtifactCount += 1;
    if (
      Object.prototype.hasOwnProperty.call(metadata, "remoteUploadError")
      || Object.prototype.hasOwnProperty.call(metadata, "remoteVerificationError")
    ) {
      remoteUploadFailureCount += 1;
    }
    if (metadata.localCacheRemoved === true) localRemovedArtifactCount += 1;

    if (artifact.status !== "completed" && artifact.status !== "partial") continue;
    const localRetained = (
      metadata.localCacheRemoved === false
      && (
        metadata.localCachePolicy !== "remote_only"
        || metadata.localCacheCleanupAttempted === true
        || !remoteObjectKey
      )
    ) || (
      metadata.localCacheRemoved == null
      && metadata.localCachePolicy !== "remote_only"
    );
    if (localRetained) localRetainedArtifactCount += 1;
  }

  return {
    remoteArtifactCount,
    remoteUploadFailureCount,
    localRetainedArtifactCount,
    localRemovedArtifactCount
  };
}

export function mapRecoveryPoint(row: any): RecoveryPointListItem {
  return {
    id: row.id,
    hostId: row.host_id,
    name: row.name ?? null,
    appIdentity: parseAppIdentity(row.app_identity),
    triggerKind: row.trigger_kind,
    status: row.status,
    backupTargetId: row.backup_target_id ?? null,
    legacyVolumeBackupId: row.legacy_volume_backup_id ?? null,
    profileId: row.profile_id ?? null,
    artifactCount: toCount(row.artifact_count),
    completedArtifactCount: toCount(row.completed_artifact_count),
    remoteArtifactCount: toCount(row.remote_artifact_count),
    remoteUploadFailureCount: toCount(row.remote_upload_failure_count),
    localRetainedArtifactCount: toCount(row.local_retained_artifact_count),
    localRemovedArtifactCount: toCount(row.local_removed_artifact_count),
    totalBytes: toNullableNumber(row.total_bytes),
    error: sanitizeUrlDiagnosticText(row.error ?? null) as string | null,
    metadata: row.metadata ?? {},
    lastDrillAt: iso(row.last_drill_at),
    lastDrillStatus: row.last_drill_status ?? null,
    lastDrillError: sanitizeUrlDiagnosticText(row.last_drill_error ?? null) as string | null,
    lastSuccessfulDrillAt: iso(row.last_successful_drill_at),
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at)
  };
}

export function sanitizeRecoveryPointForRead<
  T extends RecoveryPointListItem | RecoveryPointDetail
>(point: T): T {
  const outward = {
    ...point,
    metadata: sanitizeGitRepositoryUrlFields(point.metadata)
  };
  if (!("artifacts" in point)) return outward as T;
  return {
    ...outward,
    artifacts: point.artifacts.map(sanitizeRecoveryArtifactForRead)
  } as T;
}

export function mapRecoverySchedule(row: any): RecoverySchedule {
  return {
    id: row.id,
    hostId: row.host_id,
    name: row.name,
    appIdentity: parseAppIdentity(row.app_identity),
    backupTargetId: row.backup_target_id ?? null,
    profileId: row.profile_id ?? null,
    intervalMs: Number(row.interval_ms),
    retentionCount: row.retention_count === null || row.retention_count === undefined
      ? null
      : Number(row.retention_count),
    captureMode: row.capture_mode === "stop_first" ? "stop_first" : "hot",
    enabled: row.enabled,
    lastRunAt: iso(row.last_run_at),
    lastDrillAt: iso(row.last_drill_at),
    lastDrillStatus: row.last_drill_status ?? null,
    lastDrillError: sanitizeUrlDiagnosticText(row.last_drill_error ?? null) as string | null,
    lastSuccessfulDrillAt: iso(row.last_successful_drill_at),
    nextRunAt: iso(row.next_run_at)!,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export function mapMigrationRun(row: any): MigrationRun {
  return {
    id: row.id,
    planRunId: row.plan_run_id ?? null,
    sourceHostId: row.source_host_id,
    targetHostId: row.target_host_id,
    sourceAppIdentity: parseAppIdentity(row.source_app_identity),
    mode: row.mode,
    status: row.status,
    recoveryPointId: row.recovery_point_id ?? null,
    plan: parseMigrationPlan(row.plan),
    error: sanitizeUrlDiagnosticText(row.error ?? null) as string | null,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at)
  };
}

export function sanitizeMigrationRunForRead(run: MigrationRun): MigrationRun {
  const outward = sanitizeGitRepositoryUrlFields(run);
  return {
    ...outward,
    error: sanitizeUrlDiagnosticText(outward.error) as string | null
  };
}

const VIEWER_MIGRATION_ERROR =
  "Migration operation details are available to operators and administrators.";

function viewerDiagnosticEntries(values: readonly unknown[], label: string) {
  return values.map((_, index) =>
    `${label} ${index + 1}; details require operator access.`
  );
}

function redactMigrationAppIdentityForViewer(
  identity: RecoveryAppIdentity
): RecoveryAppIdentity {
  if (identity.kind === "stack") {
    return { kind: identity.kind, stackId: identity.stackId };
  }
  if (identity.kind === "compose") {
    return {
      kind: identity.kind,
      projectName: "redacted-compose-app",
      ...(identity.stackId ? { stackId: identity.stackId } : {})
    };
  }
  if (identity.kind === "git") {
    return { kind: identity.kind, repositoryId: identity.repositoryId };
  }
  return { kind: identity.kind, containerIds: ["redacted-container"] };
}

/**
 * Migration plans can contain host paths and Docker resource names in
 * diagnostics and collision lists. Preserve the status, strategy, checks, and
 * counts a viewer needs while failing closed on arbitrary persisted strings.
 */
export function redactMigrationRunForViewer(run: MigrationRun): MigrationRun {
  const sanitized = sanitizeMigrationRunForRead(run);
  const plan = sanitized.plan;
  const sourceAppIdentity = redactMigrationAppIdentityForViewer(
    sanitized.sourceAppIdentity
  );
  return {
    id: sanitized.id,
    planRunId: sanitized.planRunId,
    sourceHostId: sanitized.sourceHostId,
    targetHostId: sanitized.targetHostId,
    sourceAppIdentity,
    mode: sanitized.mode,
    status: sanitized.status,
    recoveryPointId: sanitized.recoveryPointId,
    error: sanitized.error ? VIEWER_MIGRATION_ERROR : null,
    plan: plan
      ? {
        // Use the already-authorized run scope rather than reflecting a
        // potentially stale or contaminated identity embedded in plan JSON.
        sourceHostId: sanitized.sourceHostId,
        targetHostId: sanitized.targetHostId,
        sourceAppIdentity,
        intent: plan.intent
          ? {
            strategy: plan.intent.strategy,
            options: {
              stopSource: plan.intent.options.stopSource,
              remapPorts: plan.intent.options.remapPorts,
              networkMode: plan.intent.options.networkMode
            }
          }
          : null,
        sourceFingerprint: null,
        targetFingerprint: null,
        steps: plan.steps.map((step, index) => ({
          id: `step-${index + 1}`,
          title: `Migration step ${index + 1}`,
          description: "Migration step details require operator access.",
          kind: step.kind,
          required: step.required
        })),
        warnings: viewerDiagnosticEntries(plan.warnings, "Migration warning"),
        estimatedArtifacts: plan.estimatedArtifacts,
        estimatedVolumes: plan.estimatedVolumes,
        estimatedHostFolders: plan.estimatedHostFolders,
        checks: {
          sourceHostAvailable: plan.checks.sourceHostAvailable,
          targetHostAvailable: plan.checks.targetHostAvailable,
          sourceDockerAvailable: plan.checks.sourceDockerAvailable,
          targetDockerAvailable: plan.checks.targetDockerAvailable,
          sourceComposeAvailable: plan.checks.sourceComposeAvailable,
          targetComposeAvailable: plan.checks.targetComposeAvailable
        },
        portConflicts: plan.portConflicts.map((_, index) => ({
          hostPort: `redacted-${index + 1}`,
          protocol: "redacted",
          sourceContainer: null,
          reason: `Port conflict ${index + 1}; details require operator access.`
        })),
        volumeCollisions: viewerDiagnosticEntries(plan.volumeCollisions, "Volume collision"),
        nameCollisions: viewerDiagnosticEntries(plan.nameCollisions, "Name collision"),
        missingNetworks: viewerDiagnosticEntries(plan.missingNetworks, "Missing network"),
        networkConflicts: viewerDiagnosticEntries(plan.networkConflicts, "Network conflict"),
        estimatedDataBytes: plan.estimatedDataBytes,
        blockingIssues: viewerDiagnosticEntries(plan.blockingIssues, "Migration blocking issue")
      }
      : null,
    createdAt: sanitized.createdAt,
    startedAt: sanitized.startedAt,
    completedAt: sanitized.completedAt
  };
}
