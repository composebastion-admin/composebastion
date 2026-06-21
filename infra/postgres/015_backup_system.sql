-- First-class backup artifacts and host-path schedules.

ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS source_path text,
  ADD COLUMN IF NOT EXISTS checksum text,
  ADD COLUMN IF NOT EXISTS backup_target_id uuid REFERENCES backup_targets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS remote_object_key text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

UPDATE backups
SET kind = 'volume'
WHERE kind IS NULL;

ALTER TABLE backups
  ALTER COLUMN kind SET DEFAULT 'volume',
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN volume_name DROP NOT NULL;

ALTER TABLE backups
  DROP CONSTRAINT IF EXISTS backups_kind_check,
  ADD CONSTRAINT backups_kind_check
    CHECK (kind IN ('volume', 'host_path'));

ALTER TABLE backups
  DROP CONSTRAINT IF EXISTS backups_source_check,
  ADD CONSTRAINT backups_source_check
    CHECK (
      (kind = 'volume' AND volume_name IS NOT NULL AND source_path IS NULL)
      OR
      (kind = 'host_path' AND source_path IS NOT NULL)
    );

CREATE INDEX IF NOT EXISTS backups_kind_created_idx
  ON backups (kind, created_at DESC);

CREATE INDEX IF NOT EXISTS backups_backup_target_idx
  ON backups (backup_target_id)
  WHERE backup_target_id IS NOT NULL;

ALTER TABLE backup_schedules
  ADD COLUMN IF NOT EXISTS kind text,
  ADD COLUMN IF NOT EXISTS source_path text,
  ADD COLUMN IF NOT EXISTS backup_target_id uuid REFERENCES backup_targets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retention_count integer CHECK (retention_count IS NULL OR retention_count >= 1),
  ADD COLUMN IF NOT EXISTS last_status text,
  ADD COLUMN IF NOT EXISTS last_error text;

UPDATE backup_schedules
SET kind = 'volume'
WHERE kind IS NULL;

ALTER TABLE backup_schedules
  ALTER COLUMN kind SET DEFAULT 'volume',
  ALTER COLUMN kind SET NOT NULL,
  ALTER COLUMN volume_name DROP NOT NULL;

ALTER TABLE backup_schedules
  DROP CONSTRAINT IF EXISTS backup_schedules_host_id_volume_name_key;

ALTER TABLE backup_schedules
  DROP CONSTRAINT IF EXISTS backup_schedules_kind_check,
  ADD CONSTRAINT backup_schedules_kind_check
    CHECK (kind IN ('volume', 'host_path'));

ALTER TABLE backup_schedules
  DROP CONSTRAINT IF EXISTS backup_schedules_source_check,
  ADD CONSTRAINT backup_schedules_source_check
    CHECK (
      (kind = 'volume' AND volume_name IS NOT NULL AND source_path IS NULL)
      OR
      (kind = 'host_path' AND source_path IS NOT NULL)
    );

CREATE UNIQUE INDEX IF NOT EXISTS backup_schedules_volume_unique_idx
  ON backup_schedules (host_id, volume_name)
  WHERE kind = 'volume';

CREATE UNIQUE INDEX IF NOT EXISTS backup_schedules_host_path_unique_idx
  ON backup_schedules (host_id, source_path)
  WHERE kind = 'host_path';
