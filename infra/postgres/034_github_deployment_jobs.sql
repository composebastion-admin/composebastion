CREATE TABLE IF NOT EXISTS github_deployment_jobs (
  operation_job_id uuid PRIMARY KEY REFERENCES operation_jobs(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES github_repositories(id) ON DELETE RESTRICT,
  stack_id uuid NOT NULL REFERENCES compose_stacks(id) ON DELETE RESTRICT,
  source_repository_url text NOT NULL,
  source_branch text NOT NULL,
  source_compose_path text NOT NULL,
  source_commit_sha text NOT NULL,
  compose_sha256 text NOT NULL,
  custom_compose boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_deployment_jobs_source_identity_nonempty
    CHECK (
      btrim(source_repository_url) <> ''
      AND btrim(source_branch) <> ''
      AND btrim(source_compose_path) <> ''
    ),
  CONSTRAINT github_deployment_jobs_source_commit_sha_format
    CHECK (source_commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT github_deployment_jobs_compose_sha256_format
    CHECK (compose_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS github_deployment_jobs_repository_idx
  ON github_deployment_jobs (repository_id);

CREATE INDEX IF NOT EXISTS github_deployment_jobs_stack_idx
  ON github_deployment_jobs (stack_id);
