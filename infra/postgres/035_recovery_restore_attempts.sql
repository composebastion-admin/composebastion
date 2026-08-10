CREATE TABLE IF NOT EXISTS recovery_restore_attempts (
  id uuid PRIMARY KEY,
  recovery_point_id uuid REFERENCES recovery_points(id) ON DELETE RESTRICT,
  backup_id uuid REFERENCES backups(id) ON DELETE RESTRICT,
  target_host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE RESTRICT,
  operation_job_id uuid REFERENCES operation_jobs(id) ON DELETE SET NULL,
  migration_run_id uuid REFERENCES migration_runs(id) ON DELETE SET NULL,
  restore_scope text NOT NULL,
  allowed_path_roots jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(allowed_path_roots) = 'array'),
  retain_on_success boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN (
      'active',
      'awaiting_disposition',
      'cleanup_pending',
      'reconciling',
      'retained',
      'cleaned'
    )),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  cleanup_not_before timestamptz,
  reconciliation_token uuid,
  reconciliation_started_at timestamptz,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recovery_restore_attempts_exactly_one_owner
    CHECK (num_nonnulls(recovery_point_id, backup_id) = 1)
);

CREATE TABLE IF NOT EXISTS recovery_restore_resources (
  attempt_id uuid NOT NULL REFERENCES recovery_restore_attempts(id) ON DELETE CASCADE,
  kind text NOT NULL
    CHECK (kind IN (
      'volume',
      'network',
      'container',
      'directory',
      'compose_project',
      'database'
    )),
  resource_name text NOT NULL,
  status text NOT NULL DEFAULT 'intended'
    CHECK (status IN ('intended', 'observed', 'cleaned', 'preserved_unrelated')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, kind, resource_name)
);

CREATE INDEX IF NOT EXISTS recovery_restore_attempts_cleanup_idx
  ON recovery_restore_attempts (status, cleanup_not_before, heartbeat_at);

CREATE INDEX IF NOT EXISTS recovery_restore_attempts_target_idx
  ON recovery_restore_attempts (target_host_id, status);

CREATE INDEX IF NOT EXISTS recovery_restore_attempts_point_idx
  ON recovery_restore_attempts (recovery_point_id, status)
  WHERE recovery_point_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS recovery_restore_attempts_backup_idx
  ON recovery_restore_attempts (backup_id, status)
  WHERE backup_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS recovery_restore_attempts_job_idx
  ON recovery_restore_attempts (operation_job_id)
  WHERE operation_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS recovery_restore_attempts_migration_idx
  ON recovery_restore_attempts (migration_run_id)
  WHERE migration_run_id IS NOT NULL;

-- Target health probes also write exact, uniquely named remote objects.
-- Preserve failed cleanup with the same encrypted-target orphan ledger used
-- by backup and recovery artifacts.
ALTER TABLE remote_artifact_orphans
  DROP CONSTRAINT IF EXISTS remote_artifact_orphans_owner_kind_check;

ALTER TABLE remote_artifact_orphans
  ADD CONSTRAINT remote_artifact_orphans_owner_kind_check
    CHECK (owner_kind IN (
      'backup',
      'recovery_artifact',
      'backup_target_probe'
    ));
