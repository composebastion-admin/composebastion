-- Recovery Center: app-level recovery points, backup targets, and migration tracking.

CREATE TABLE IF NOT EXISTS backup_targets (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('local', 's3')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  access_key_id text,
  secret_access_key_encrypted text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS backup_targets_kind_enabled_idx
  ON backup_targets (kind, enabled);

CREATE TABLE IF NOT EXISTS recovery_points (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  name text,
  app_identity jsonb NOT NULL,
  trigger_kind text NOT NULL DEFAULT 'manual'
    CHECK (trigger_kind IN ('manual', 'scheduled', 'pre_migration', 'policy')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  backup_target_id uuid REFERENCES backup_targets(id) ON DELETE SET NULL,
  legacy_volume_backup_id uuid REFERENCES backups(id) ON DELETE SET NULL,
  artifact_count integer NOT NULL DEFAULT 0,
  completed_artifact_count integer NOT NULL DEFAULT 0,
  total_bytes bigint,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS recovery_points_host_created_idx
  ON recovery_points (host_id, created_at DESC);

CREATE INDEX IF NOT EXISTS recovery_points_status_created_idx
  ON recovery_points (status, created_at DESC);

CREATE TABLE IF NOT EXISTS recovery_artifacts (
  id uuid PRIMARY KEY,
  recovery_point_id uuid NOT NULL REFERENCES recovery_points(id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN ('volume', 'compose_yaml', 'env_file', 'image_manifest', 'host_folder', 'metadata', 'config_export')),
  backup_target_id uuid REFERENCES backup_targets(id) ON DELETE SET NULL,
  storage_key text NOT NULL,
  size_bytes bigint,
  checksum text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  error text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS recovery_artifacts_point_idx
  ON recovery_artifacts (recovery_point_id, created_at ASC);

CREATE TABLE IF NOT EXISTS recovery_schedules (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  name text NOT NULL,
  app_identity jsonb NOT NULL,
  backup_target_id uuid REFERENCES backup_targets(id) ON DELETE SET NULL,
  interval_ms integer NOT NULL CHECK (interval_ms >= 300_000),
  retention_count integer CHECK (retention_count IS NULL OR retention_count >= 1),
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recovery_schedules_next_run_idx
  ON recovery_schedules (next_run_at)
  WHERE enabled = true;

CREATE TABLE IF NOT EXISTS migration_runs (
  id uuid PRIMARY KEY,
  source_host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  target_host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  source_app_identity jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('plan', 'execute')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  recovery_point_id uuid REFERENCES recovery_points(id) ON DELETE SET NULL,
  plan jsonb,
  error text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS migration_runs_source_created_idx
  ON migration_runs (source_host_id, created_at DESC);

CREATE INDEX IF NOT EXISTS migration_runs_target_created_idx
  ON migration_runs (target_host_id, created_at DESC);
