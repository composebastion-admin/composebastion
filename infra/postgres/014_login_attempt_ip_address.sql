ALTER TABLE login_attempts
  ADD COLUMN IF NOT EXISTS ip_address text;

CREATE INDEX IF NOT EXISTS login_attempts_identifier_ip_idx
  ON login_attempts (lower(identifier), ip_address, attempted_at DESC);

CREATE INDEX IF NOT EXISTS login_attempts_identifier_failures_idx
  ON login_attempts (lower(identifier), attempted_at DESC)
  WHERE success = false;

CREATE INDEX IF NOT EXISTS login_attempts_ip_failures_idx
  ON login_attempts (ip_address, attempted_at DESC)
  WHERE success = false;
