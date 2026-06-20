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
  RecoveryPointListItem,
  RecoverySchedule,
  ResourceSnapshot
} from "@composebastion/shared";
import { migrationPlanSchema, recoveryAppIdentitySchema } from "@composebastion/shared";
import { mapBackupTargetFields } from "./recoveryBackupTargets.js";

const iso = (value: Date | string | null | undefined) => {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

export function mapHost(row: any): DockerHost {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    port: Number(row.port),
    username: row.username,
    connectionMode: row.connection_mode ?? "ssh",
    sshAuthType: row.ssh_auth_type ?? "key",
    agentUrl: row.agent_url,
    dockerSocketPath: row.docker_socket_path,
    tags: row.tags ?? [],
    lastStatus: row.last_status,
    lastSeenAt: iso(row.last_seen_at),
    lastError: row.last_error,
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
    sourceRepositoryUrl: row.source_repository_url ?? null,
    sourceBranch: row.source_branch ?? null,
    sourceWorkingDir: row.source_working_dir ?? null,
    sourceComposePath: row.source_compose_path ?? null,
    sourceCurrentCommitSha: row.source_current_commit_sha ?? null,
    sourceLatestCommitSha: row.source_latest_commit_sha ?? null,
    sourceCheckedAt: iso(row.source_checked_at),
    sourceCheckError: row.source_check_error ?? null,
    lastDeployError: row.last_deploy_error ?? null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
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
    error: row.error,
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at),
    metadata: row.metadata ?? {}
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
    error: row.error ?? null,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at)!,
    completedAt: iso(row.completed_at)
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
    totalBytes: toNullableNumber(row.total_bytes),
    error: row.error ?? null,
    metadata: row.metadata ?? {},
    lastDrillAt: iso(row.last_drill_at),
    lastDrillStatus: row.last_drill_status ?? null,
    lastDrillError: row.last_drill_error ?? null,
    lastSuccessfulDrillAt: iso(row.last_successful_drill_at),
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at)
  };
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
    lastDrillError: row.last_drill_error ?? null,
    lastSuccessfulDrillAt: iso(row.last_successful_drill_at),
    nextRunAt: iso(row.next_run_at)!,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!
  };
}

export function mapMigrationRun(row: any): MigrationRun {
  return {
    id: row.id,
    sourceHostId: row.source_host_id,
    targetHostId: row.target_host_id,
    sourceAppIdentity: parseAppIdentity(row.source_app_identity),
    mode: row.mode,
    status: row.status,
    recoveryPointId: row.recovery_point_id ?? null,
    plan: parseMigrationPlan(row.plan),
    error: row.error ?? null,
    createdAt: iso(row.created_at)!,
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at)
  };
}
