-- App inventory: Git update state for unified app/source detection.

ALTER TABLE github_repositories
  ADD COLUMN IF NOT EXISTS last_deployed_commit_sha text,
  ADD COLUMN IF NOT EXISTS latest_commit_sha text,
  ADD COLUMN IF NOT EXISTS update_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS update_check_error text;

CREATE INDEX IF NOT EXISTS github_repositories_default_host_project_idx
  ON github_repositories(default_host_id, project_name);

ALTER TABLE compose_stacks
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'ui',
  ADD COLUMN IF NOT EXISTS source_repository_url text,
  ADD COLUMN IF NOT EXISTS source_branch text,
  ADD COLUMN IF NOT EXISTS source_working_dir text,
  ADD COLUMN IF NOT EXISTS source_compose_path text,
  ADD COLUMN IF NOT EXISTS source_current_commit_sha text,
  ADD COLUMN IF NOT EXISTS source_latest_commit_sha text,
  ADD COLUMN IF NOT EXISTS source_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_check_error text;

CREATE INDEX IF NOT EXISTS compose_stacks_source_host_idx
  ON compose_stacks(host_id, source_type, project_name);
