CREATE TABLE IF NOT EXISTS github_clone_deployment_jobs (
  operation_job_id uuid PRIMARY KEY REFERENCES operation_jobs(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES github_repositories(id) ON DELETE RESTRICT,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE RESTRICT,
  stack_id uuid REFERENCES compose_stacks(id) ON DELETE RESTRICT,
  source_repository_url text NOT NULL,
  clone_repository_url text NOT NULL,
  source_branch text NOT NULL,
  source_commit_sha text NOT NULL,
  source_compose_path text NOT NULL,
  compose_yaml text NOT NULL,
  compose_sha256 text NOT NULL,
  project_name text NOT NULL,
  working_dir text NOT NULL,
  environment_encrypted text NOT NULL,
  environment_binding text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_clone_deployment_jobs_source_identity_nonempty
    CHECK (
      btrim(source_repository_url) <> ''
      AND btrim(clone_repository_url) <> ''
      AND btrim(source_branch) <> ''
      AND btrim(source_compose_path) <> ''
      AND btrim(project_name) <> ''
      AND btrim(working_dir) <> ''
      AND btrim(environment_encrypted) <> ''
    ),
  CONSTRAINT github_clone_deployment_jobs_source_commit_sha_format
    CHECK (source_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT github_clone_deployment_jobs_compose_sha256_format
    CHECK (compose_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT github_clone_deployment_jobs_environment_binding_format
    CHECK (environment_binding ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS github_clone_deployment_jobs_repository_idx
  ON github_clone_deployment_jobs (repository_id);

CREATE INDEX IF NOT EXISTS github_clone_deployment_jobs_stack_idx
  ON github_clone_deployment_jobs (stack_id)
  WHERE stack_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS github_clone_deployment_jobs_target_idx
  ON github_clone_deployment_jobs (host_id, project_name);

CREATE UNIQUE INDEX IF NOT EXISTS github_clone_deployment_jobs_directory_idx
  ON github_clone_deployment_jobs (host_id, working_dir);
