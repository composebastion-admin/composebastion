ALTER TABLE operation_jobs
  ADD COLUMN IF NOT EXISTS lease_owner uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

ALTER TABLE operation_jobs
  DROP CONSTRAINT IF EXISTS operation_jobs_attempt_count_nonnegative;

ALTER TABLE operation_jobs
  ADD CONSTRAINT operation_jobs_attempt_count_nonnegative CHECK (attempt_count >= 0);

-- Jobs that were already running when this migration lands have no lease owner.
-- Give the old worker two minutes to finish before a lease-aware worker recovers
-- them.
UPDATE operation_jobs
SET lease_expires_at = now() + interval '2 minutes'
WHERE status = 'running' AND lease_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS operation_jobs_expired_lease_idx
  ON operation_jobs (lease_expires_at, created_at)
  WHERE status = 'running';

-- An old worker can claim a row after this migration's one-time grace update
-- but before that worker is replaced. Keep those NULL-lease rows discoverable
-- by the permanent two-minute legacy recovery path.
CREATE INDEX IF NOT EXISTS operation_jobs_legacy_running_idx
  ON operation_jobs ((COALESCE(started_at, updated_at, created_at)), created_at)
  WHERE status = 'running'
    AND lease_owner IS NULL
    AND lease_expires_at IS NULL;

CREATE TABLE IF NOT EXISTS worker_instances (
  id uuid PRIMARY KEY,
  version text NOT NULL,
  hostname text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  CONSTRAINT worker_instances_status_check CHECK (status IN ('active', 'draining', 'stopped'))
);

CREATE INDEX IF NOT EXISTS worker_instances_heartbeat_idx
  ON worker_instances (last_heartbeat_at DESC);
