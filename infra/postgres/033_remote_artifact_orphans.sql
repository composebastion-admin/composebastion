-- Remote PUT/copy operations can commit even when the worker observes a
-- timeout. If exact-object compensation then also fails, retain the target and
-- key independently of the backup/recovery row so successor attempts and row
-- deletion cannot erase the cleanup obligation.
CREATE TABLE IF NOT EXISTS remote_artifact_orphans (
  id uuid PRIMARY KEY,
  owner_kind text NOT NULL,
  owner_id uuid NOT NULL,
  backup_target_id uuid NOT NULL REFERENCES backup_targets(id) ON DELETE RESTRICT,
  object_key text NOT NULL,
  backend text NOT NULL,
  attempt_token text NOT NULL,
  target_binding_fingerprint text NOT NULL,
  target_snapshot_encrypted text NOT NULL,
  cleanup_error text NOT NULL,
  cleanup_claim_token uuid,
  cleanup_claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT remote_artifact_orphans_owner_kind_check
    CHECK (owner_kind IN ('backup', 'recovery_artifact')),
  CONSTRAINT remote_artifact_orphans_backend_check
    CHECK (backend IN ('s3', 'rclone')),
  CONSTRAINT remote_artifact_orphans_target_binding_fingerprint_check
    CHECK (target_binding_fingerprint ~ '^hmac-sha256:[0-9a-f]{64}$'),
  UNIQUE (backup_target_id, object_key)
);

CREATE INDEX IF NOT EXISTS remote_artifact_orphans_cleanup_idx
  ON remote_artifact_orphans (cleanup_claimed_at, created_at);
