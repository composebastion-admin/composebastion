CREATE TABLE IF NOT EXISTS app_source_links (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  container_external_id text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('image', 'compose', 'git')),
  name text,
  repository_url text,
  branch text,
  working_dir text,
  compose_path text,
  image_reference text,
  current_commit_sha text,
  latest_commit_sha text,
  checked_at timestamptz,
  check_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (host_id, container_external_id)
);

CREATE INDEX IF NOT EXISTS app_source_links_host_source_idx
  ON app_source_links(host_id, source_type);
