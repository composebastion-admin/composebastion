-- V1 recovery storage expansion: rclone targets, health checks, cache policy,
-- and app-level recovery profiles.

ALTER TABLE backup_targets
  DROP CONSTRAINT IF EXISTS backup_targets_kind_check,
  ADD CONSTRAINT backup_targets_kind_check
    CHECK (kind IN ('local', 's3', 'rclone'));

ALTER TABLE backup_targets
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS remote_path text,
  ADD COLUMN IF NOT EXISTS local_cache_policy text NOT NULL DEFAULT 'keep',
  ADD COLUMN IF NOT EXISTS generic_config_encrypted text,
  ADD COLUMN IF NOT EXISTS generic_credentials_encrypted text,
  ADD COLUMN IF NOT EXISTS health_status text,
  ADD COLUMN IF NOT EXISTS health_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS health_error text;

ALTER TABLE backup_targets
  DROP CONSTRAINT IF EXISTS backup_targets_local_cache_policy_check,
  ADD CONSTRAINT backup_targets_local_cache_policy_check
    CHECK (local_cache_policy IN ('keep', 'remote_only'));

ALTER TABLE backup_targets
  DROP CONSTRAINT IF EXISTS backup_targets_provider_check,
  ADD CONSTRAINT backup_targets_provider_check
    CHECK (
      provider IS NULL
      OR provider IN ('smb', 'drive', 'onedrive', 'iclouddrive', 'webdav', 'sftp', 'custom')
    );

ALTER TABLE backup_targets
  DROP CONSTRAINT IF EXISTS backup_targets_health_status_check,
  ADD CONSTRAINT backup_targets_health_status_check
    CHECK (
      health_status IS NULL
      OR health_status IN ('unknown', 'healthy', 'failed')
    );

CREATE INDEX IF NOT EXISTS backup_targets_provider_enabled_idx
  ON backup_targets (provider, enabled)
  WHERE kind = 'rclone';

CREATE TABLE IF NOT EXISTS recovery_profiles (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  app_identity jsonb NOT NULL,
  name text NOT NULL,
  include_paths jsonb NOT NULL DEFAULT '[]',
  exclude_patterns jsonb NOT NULL DEFAULT '[]',
  restore_paths jsonb NOT NULL DEFAULT '{}',
  pre_capture_command text,
  post_capture_command text,
  capture_mode text NOT NULL DEFAULT 'hot'
    CHECK (capture_mode IN ('hot', 'stop_first')),
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recovery_profiles_host_identity_idx
  ON recovery_profiles (host_id, md5(app_identity::text));

ALTER TABLE recovery_points
  ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES recovery_profiles(id) ON DELETE SET NULL;

ALTER TABLE recovery_schedules
  ADD COLUMN IF NOT EXISTS profile_id uuid REFERENCES recovery_profiles(id) ON DELETE SET NULL;
