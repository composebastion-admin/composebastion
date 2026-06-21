-- Stack Platform v0.9.0: versions, proxy metadata, image intelligence, scans

ALTER TABLE compose_stacks
  ADD COLUMN IF NOT EXISTS current_version_id uuid,
  ADD COLUMN IF NOT EXISTS domains text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS exposed_service text,
  ADD COLUMN IF NOT EXISTS exposed_port integer,
  ADD COLUMN IF NOT EXISTS tls_desired boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS update_policy_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS update_policy_channel text;

CREATE TABLE IF NOT EXISTS compose_stack_versions (
  id uuid PRIMARY KEY,
  stack_id uuid NOT NULL REFERENCES compose_stacks(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  compose_yaml text NOT NULL,
  env text NOT NULL DEFAULT '',
  source text NOT NULL,
  note text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stack_id, version_number)
);

CREATE INDEX IF NOT EXISTS compose_stack_versions_stack_id_idx ON compose_stack_versions(stack_id, version_number DESC);

ALTER TABLE compose_stacks
  DROP CONSTRAINT IF EXISTS compose_stacks_current_version_id_fkey;

ALTER TABLE compose_stacks
  ADD CONSTRAINT compose_stacks_current_version_id_fkey
  FOREIGN KEY (current_version_id) REFERENCES compose_stack_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS image_update_checks (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  image_reference text NOT NULL,
  current_digest text,
  remote_digest text,
  status text NOT NULL DEFAULT 'unknown',
  risk_note text,
  affected_containers jsonb NOT NULL DEFAULT '[]',
  affected_stacks jsonb NOT NULL DEFAULT '[]',
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_id, image_reference)
);

CREATE INDEX IF NOT EXISTS image_update_checks_host_idx ON image_update_checks(host_id, last_checked_at DESC);

CREATE TABLE IF NOT EXISTS image_scan_results (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  image_reference text NOT NULL,
  image_digest text,
  scanner text NOT NULL,
  severity_counts jsonb NOT NULL DEFAULT '{}',
  raw jsonb NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS image_scan_results_host_image_idx ON image_scan_results(host_id, image_reference, generated_at DESC);
