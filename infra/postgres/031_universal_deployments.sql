-- Universal deployment workflow: reusable sources, durable analyses, and stack linkage.

CREATE TABLE IF NOT EXISTS deployment_sources (
  id uuid PRIMARY KEY,
  source_type text NOT NULL CHECK (source_type IN ('git', 'compose_url', 'compose_upload', 'image')),
  name text NOT NULL,
  source_locator text NOT NULL,
  branch text,
  compose_path text,
  working_dir text,
  project_name text NOT NULL,
  compose_yaml text,
  env_encrypted text,
  credential_username text,
  credential_secret_encrypted text,
  default_host_id uuid REFERENCES docker_hosts(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  last_deployed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS deployment_sources_identity_idx
  ON deployment_sources (
    source_type,
    source_locator,
    COALESCE(branch, ''),
    COALESCE(compose_path, '')
  );

CREATE TABLE IF NOT EXISTS deployment_analyses (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  source_id uuid REFERENCES deployment_sources(id) ON DELETE SET NULL,
  source_type text NOT NULL CHECK (source_type IN ('git', 'compose_url', 'compose_upload', 'image')),
  source_input text NOT NULL,
  source_locator text,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'analyzing', 'ready', 'deploying', 'deployed', 'failed', 'expired')),
  display_name text,
  project_name text,
  branch text,
  compose_path text,
  working_dir text,
  compose_yaml text,
  env_encrypted text,
  credential_username text,
  credential_secret_encrypted text,
  staging_directory text,
  summary jsonb NOT NULL DEFAULT '{}',
  variables jsonb NOT NULL DEFAULT '[]',
  warnings jsonb NOT NULL DEFAULT '[]',
  blockers jsonb NOT NULL DEFAULT '[]',
  registry_issues jsonb NOT NULL DEFAULT '[]',
  error text,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 hours',
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deployed_at timestamptz
);

CREATE INDEX IF NOT EXISTS deployment_analyses_expiry_idx
  ON deployment_analyses (expires_at)
  WHERE status NOT IN ('deployed', 'expired');

ALTER TABLE compose_stacks
  ADD COLUMN IF NOT EXISTS deployment_source_id uuid REFERENCES deployment_sources(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS compose_stacks_deployment_source_idx
  ON compose_stacks (deployment_source_id);

-- Preserve existing tracked GitHub repositories as reusable Git sources.
INSERT INTO deployment_sources (
  id,
  source_type,
  name,
  source_locator,
  branch,
  compose_path,
  working_dir,
  project_name,
  env_encrypted,
  credential_username,
  credential_secret_encrypted,
  default_host_id,
  metadata,
  last_deployed_at,
  created_at,
  updated_at
)
SELECT
  repositories.id,
  'git',
  repositories.name,
  COALESCE(NULLIF(repositories.host_clone_url, ''), repositories.repository_url),
  repositories.branch,
  repositories.compose_path,
  repositories.host_clone_directory,
  repositories.project_name,
  null,
  CASE WHEN repositories.github_token_encrypted IS NULL THEN null ELSE 'x-access-token' END,
  repositories.github_token_encrypted,
  repositories.default_host_id,
  jsonb_build_object(
    'legacyGithubRepositoryId', repositories.id,
    'repositoryUrl', repositories.repository_url,
    'hostCloneDirectory', repositories.host_clone_directory
  ),
  repositories.last_deployed_at,
  repositories.created_at,
  repositories.updated_at
FROM github_repositories AS repositories
ON CONFLICT DO NOTHING;

-- Backfill host-cloned Git stacks that were deployed through the former
-- one-off form but were never saved as tracked GitHub repositories.
INSERT INTO deployment_sources (
  id,
  source_type,
  name,
  source_locator,
  branch,
  compose_path,
  working_dir,
  project_name,
  default_host_id,
  compose_yaml,
  metadata,
  last_deployed_at,
  created_at,
  updated_at
)
SELECT DISTINCT ON (
  stacks.source_repository_url,
  COALESCE(stacks.source_branch, ''),
  COALESCE(stacks.source_compose_path, '')
)
  gen_random_uuid(),
  'git',
  stacks.name,
  stacks.source_repository_url,
  stacks.source_branch,
  stacks.source_compose_path,
  stacks.source_working_dir,
  stacks.project_name,
  stacks.host_id,
  stacks.compose_yaml,
  jsonb_build_object('backfilledFromStack', stacks.id),
  CASE WHEN stacks.status = 'deployed' THEN stacks.updated_at ELSE null END,
  stacks.created_at,
  stacks.updated_at
FROM compose_stacks AS stacks
WHERE stacks.source_type = 'git'
  AND stacks.source_repository_url IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM deployment_sources AS sources
    WHERE sources.source_type = 'git'
      AND sources.source_locator = stacks.source_repository_url
      AND COALESCE(sources.branch, '') = COALESCE(stacks.source_branch, '')
      AND COALESCE(sources.compose_path, '') = COALESCE(stacks.source_compose_path, '')
  )
ORDER BY
  stacks.source_repository_url,
  COALESCE(stacks.source_branch, ''),
  COALESCE(stacks.source_compose_path, ''),
  stacks.updated_at DESC;

-- Host-file stacks become reusable Compose sources without duplicating their
-- running service inventory.
INSERT INTO deployment_sources (
  id,
  source_type,
  name,
  source_locator,
  compose_path,
  working_dir,
  project_name,
  default_host_id,
  compose_yaml,
  metadata,
  last_deployed_at,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid(),
  'compose_upload',
  stacks.name,
  'host://' || stacks.host_id::text || COALESCE(stacks.source_working_dir, '') || '#' || COALESCE(stacks.source_compose_path, 'compose.yaml'),
  stacks.source_compose_path,
  stacks.source_working_dir,
  stacks.project_name,
  stacks.host_id,
  stacks.compose_yaml,
  jsonb_build_object('backfilledFromStack', stacks.id, 'originalSourceType', stacks.source_type),
  CASE WHEN stacks.status = 'deployed' THEN stacks.updated_at ELSE null END,
  stacks.created_at,
  stacks.updated_at
FROM compose_stacks AS stacks
WHERE stacks.source_type = 'host_files'
  AND NOT EXISTS (
    SELECT 1
    FROM deployment_sources AS sources
    WHERE sources.source_type = 'compose_upload'
      AND sources.source_locator = 'host://' || stacks.host_id::text || COALESCE(stacks.source_working_dir, '') || '#' || COALESCE(stacks.source_compose_path, 'compose.yaml')
  );

UPDATE compose_stacks AS stacks
SET deployment_source_id = sources.id
FROM deployment_sources AS sources
WHERE stacks.deployment_source_id IS NULL
  AND stacks.source_repository_url IS NOT NULL
  AND sources.source_type = 'git'
  AND sources.source_locator = stacks.source_repository_url
  AND COALESCE(sources.branch, '') = COALESCE(stacks.source_branch, '')
  AND COALESCE(sources.compose_path, '') = COALESCE(stacks.source_compose_path, '');

UPDATE compose_stacks AS stacks
SET deployment_source_id = sources.id
FROM deployment_sources AS sources
WHERE stacks.deployment_source_id IS NULL
  AND stacks.source_type = 'host_files'
  AND sources.source_type = 'compose_upload'
  AND sources.source_locator = 'host://' || stacks.host_id::text || COALESCE(stacks.source_working_dir, '') || '#' || COALESCE(stacks.source_compose_path, 'compose.yaml');
