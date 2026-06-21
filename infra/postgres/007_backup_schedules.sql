CREATE TABLE IF NOT EXISTS backup_schedules (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  volume_name text NOT NULL,
  interval_ms integer NOT NULL CHECK (interval_ms >= 300_000),
  enabled boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  next_run_at timestamptz NOT NULL,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_id, volume_name)
);

CREATE INDEX IF NOT EXISTS backup_schedules_next_run_idx
  ON backup_schedules (next_run_at)
  WHERE enabled = true;
