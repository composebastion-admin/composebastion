-- Restore drill results and encrypted-backup key identity.

ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS encryption_key_fingerprint text,
  ADD COLUMN IF NOT EXISTS last_drill_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_drill_status text;

ALTER TABLE backups
  DROP CONSTRAINT IF EXISTS backups_last_drill_status_check,
  ADD CONSTRAINT backups_last_drill_status_check
    CHECK (last_drill_status IS NULL OR last_drill_status IN ('completed', 'failed'));

CREATE INDEX IF NOT EXISTS backups_last_drill_idx
  ON backups (last_drill_at DESC)
  WHERE last_drill_at IS NOT NULL;
