-- Private GitHub repository credential status metadata.

ALTER TABLE github_repositories
  ADD COLUMN IF NOT EXISTS github_token_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS github_token_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS github_token_check_error text;
