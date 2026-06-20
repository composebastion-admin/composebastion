-- Opt-in app-secret encryption for regular backup artifacts.

ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS encryption text NOT NULL DEFAULT 'none';

ALTER TABLE backups
  DROP CONSTRAINT IF EXISTS backups_encryption_check,
  ADD CONSTRAINT backups_encryption_check
    CHECK (encryption IN ('none', 'app_secret'));

ALTER TABLE backup_schedules
  ADD COLUMN IF NOT EXISTS encryption text NOT NULL DEFAULT 'none';

ALTER TABLE backup_schedules
  DROP CONSTRAINT IF EXISTS backup_schedules_encryption_check,
  ADD CONSTRAINT backup_schedules_encryption_check
    CHECK (encryption IN ('none', 'app_secret'));
