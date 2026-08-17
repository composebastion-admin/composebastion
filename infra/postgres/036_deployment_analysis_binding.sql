ALTER TABLE deployment_analyses
  ADD COLUMN IF NOT EXISTS source_revision text,
  ADD COLUMN IF NOT EXISTS compose_sha256 text,
  ADD COLUMN IF NOT EXISTS environment_sha256 text;

ALTER TABLE deployment_analyses
  DROP CONSTRAINT IF EXISTS deployment_analyses_source_revision_format;

ALTER TABLE deployment_analyses
  ADD CONSTRAINT deployment_analyses_source_revision_format
    CHECK (
      source_revision IS NULL
      OR source_revision ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
    );

ALTER TABLE deployment_analyses
  DROP CONSTRAINT IF EXISTS deployment_analyses_compose_sha256_format;

ALTER TABLE deployment_analyses
  ADD CONSTRAINT deployment_analyses_compose_sha256_format
    CHECK (
      compose_sha256 IS NULL
      OR compose_sha256 ~ '^[0-9a-f]{64}$'
    );

ALTER TABLE deployment_analyses
  DROP CONSTRAINT IF EXISTS deployment_analyses_environment_sha256_format;

ALTER TABLE deployment_analyses
  ADD CONSTRAINT deployment_analyses_environment_sha256_format
    CHECK (
      environment_sha256 IS NULL
      OR environment_sha256 ~ '^[0-9a-f]{64}$'
    );

CREATE INDEX IF NOT EXISTS deployment_analyses_source_revision_idx
  ON deployment_analyses (source_revision)
  WHERE source_type = 'git' AND source_revision IS NOT NULL;
