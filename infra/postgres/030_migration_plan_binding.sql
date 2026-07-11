-- Bind each migration execution to one reviewed, single-use plan run.

ALTER TABLE migration_runs
  ADD COLUMN IF NOT EXISTS plan_run_id uuid REFERENCES migration_runs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS migration_runs_plan_run_unique_idx
  ON migration_runs (plan_run_id)
  WHERE plan_run_id IS NOT NULL;

-- A migration can create more than one recovery point (for example, a warm
-- pre-copy followed by a final stop-first capture). Link every child before
-- capture begins so worker-loss cleanup can finalize the complete set.
ALTER TABLE recovery_points
  ADD COLUMN IF NOT EXISTS migration_run_id uuid REFERENCES migration_runs(id) ON DELETE SET NULL;

-- Backfill only artifacts whose internal name is one emitted by the legacy
-- migration worker for this exact run. A supplied/manual recovery point stays
-- reusable even when migration_runs.recovery_point_id references it.
UPDATE recovery_points AS recovery_point
SET migration_run_id = migration_run.id
FROM migration_runs AS migration_run
WHERE recovery_point.migration_run_id IS NULL
  AND migration_run.mode = 'execute'
  AND recovery_point.trigger_kind = 'pre_migration'
  AND recovery_point.host_id = migration_run.source_host_id
  AND recovery_point.app_identity = migration_run.source_app_identity
  AND recovery_point.name IN (
    'Migration ' || migration_run.id::text,
    'Migration pre-copy ' || migration_run.id::text,
    'Migration final ' || migration_run.id::text
  );

CREATE INDEX IF NOT EXISTS recovery_points_migration_run_idx
  ON recovery_points (migration_run_id, created_at ASC)
  WHERE migration_run_id IS NOT NULL;
