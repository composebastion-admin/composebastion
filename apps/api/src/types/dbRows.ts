export type HostRow = {
  id: string;
  name: string;
  hostname: string;
  port: number | string;
  username: string;
  connection_mode?: string | null;
  ssh_auth_type?: string | null;
  agent_url?: string | null;
  docker_socket_path: string;
  tags?: string[] | null;
  last_status: string;
  last_seen_at?: Date | string | null;
  last_error?: string | null;
  docker_version?: string | null;
  compose_version?: string | null;
  deleted_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type ResourceRow = {
  id: string;
  host_id: string;
  kind: string;
  external_id: string;
  name: string;
  data?: Record<string, unknown> | null;
  updated_at: Date | string;
};

export type JobRow = {
  id: string;
  type: string;
  status: string;
  host_id: string | null;
  payload?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  created_by?: string | null;
  idempotency_key?: string | null;
  lease_owner?: string | null;
  lease_expires_at?: Date | string | null;
  attempt_count?: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
};

export type AuditRow = {
  id: string;
  user_id: string | null;
  host_id: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  details?: Record<string, unknown> | null;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at: Date | string;
};

export type AdminUserRow = {
  id: string;
  name?: string | null;
  username?: string | null;
  email: string;
  role?: string | null;
  is_active?: boolean | null;
  last_login_at?: Date | string | null;
  created_at: Date | string;
};

export type BackupTargetRow = {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  config?: Record<string, unknown> | null;
  access_key_id?: string | null;
  secret_access_key_encrypted?: string | null;
  created_by?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type RecoveryPointRow = {
  id: string;
  host_id: string;
  name?: string | null;
  app_identity: Record<string, unknown>;
  trigger_kind: string;
  status: string;
  backup_target_id?: string | null;
  legacy_volume_backup_id?: string | null;
  artifact_count: number | string;
  completed_artifact_count: number | string;
  total_bytes?: number | string | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  created_by?: string | null;
  created_at: Date | string;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
};

export type RecoveryArtifactRow = {
  id: string;
  recovery_point_id: string;
  kind: string;
  backup_target_id?: string | null;
  storage_key: string;
  size_bytes?: number | string | null;
  checksum?: string | null;
  status: string;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: Date | string;
  completed_at?: Date | string | null;
};

export type RecoveryScheduleRow = {
  id: string;
  host_id: string;
  name: string;
  app_identity: Record<string, unknown>;
  backup_target_id?: string | null;
  interval_ms: number | string;
  retention_count?: number | string | null;
  enabled: boolean;
  last_run_at?: Date | string | null;
  next_run_at: Date | string;
  created_by?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type MigrationRunRow = {
  id: string;
  plan_run_id?: string | null;
  source_host_id: string;
  target_host_id: string;
  source_app_identity: Record<string, unknown>;
  mode: string;
  status: string;
  recovery_point_id?: string | null;
  plan?: Record<string, unknown> | null;
  error?: string | null;
  created_by?: string | null;
  created_at: Date | string;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
};
