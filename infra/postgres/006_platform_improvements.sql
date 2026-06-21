ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

ALTER TABLE docker_hosts
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text;

ALTER TABLE operation_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS operation_jobs_idempotency_key_idx
  ON operation_jobs (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  success boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS login_attempts_identifier_idx
  ON login_attempts (lower(identifier), attempted_at DESC);
