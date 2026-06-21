ALTER TABLE recovery_points
  ADD COLUMN IF NOT EXISTS last_drill_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_drill_status text,
  ADD COLUMN IF NOT EXISTS last_drill_error text,
  ADD COLUMN IF NOT EXISTS last_successful_drill_at timestamptz;

ALTER TABLE recovery_schedules
  ADD COLUMN IF NOT EXISTS last_drill_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_drill_status text,
  ADD COLUMN IF NOT EXISTS last_drill_error text,
  ADD COLUMN IF NOT EXISTS last_successful_drill_at timestamptz;
