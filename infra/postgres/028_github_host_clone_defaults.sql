-- Host-side clone defaults for tracked GitHub repositories.

ALTER TABLE github_repositories
  ADD COLUMN IF NOT EXISTS host_clone_url text,
  ADD COLUMN IF NOT EXISTS host_clone_directory text;
