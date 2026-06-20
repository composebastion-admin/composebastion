ALTER TABLE docker_hosts
  ADD COLUMN IF NOT EXISTS ssh_auth_type text NOT NULL DEFAULT 'key',
  ADD COLUMN IF NOT EXISTS ssh_password_encrypted text;
