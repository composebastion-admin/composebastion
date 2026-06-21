CREATE TABLE IF NOT EXISTS favorite_images (
  id uuid PRIMARY KEY,
  image text NOT NULL UNIQUE,
  name text,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_repositories (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  repository_url text NOT NULL,
  owner text NOT NULL,
  repo text NOT NULL,
  branch text NOT NULL DEFAULT 'main',
  compose_path text NOT NULL DEFAULT 'docker-compose.yml',
  project_name text NOT NULL,
  env text NOT NULL DEFAULT '',
  default_host_id uuid REFERENCES docker_hosts(id) ON DELETE SET NULL,
  github_token_encrypted text,
  last_deployed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, repo, branch, compose_path)
);
