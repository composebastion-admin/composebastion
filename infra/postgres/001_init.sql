CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS docker_hosts (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  hostname text NOT NULL,
  port integer NOT NULL DEFAULT 22,
  username text NOT NULL,
  ssh_key_encrypted text NOT NULL,
  ssh_key_passphrase_encrypted text,
  ssh_key_public_label text,
  docker_socket_path text NOT NULL DEFAULT '/var/run/docker.sock',
  tags text[] NOT NULL DEFAULT '{}',
  last_status text NOT NULL DEFAULT 'unknown',
  last_seen_at timestamptz,
  last_error text,
  docker_version text,
  compose_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resource_snapshots (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  external_id text NOT NULL,
  name text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_id, kind, external_id)
);

CREATE TABLE IF NOT EXISTS compose_stacks (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  name text NOT NULL,
  project_name text NOT NULL,
  compose_yaml text NOT NULL,
  env text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'created',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_id, project_name)
);

CREATE TABLE IF NOT EXISTS backups (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  volume_name text NOT NULL,
  target_volume_name text,
  file_name text NOT NULL,
  size_bytes bigint,
  status text NOT NULL DEFAULT 'queued',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS operation_jobs (
  id uuid PRIMARY KEY,
  type text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  host_id uuid REFERENCES docker_hosts(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  error text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS operation_jobs_status_created_idx
  ON operation_jobs (status, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  host_id uuid REFERENCES docker_hosts(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_kind text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
