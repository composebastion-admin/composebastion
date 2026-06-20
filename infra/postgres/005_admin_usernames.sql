ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS username text;

CREATE UNIQUE INDEX IF NOT EXISTS admin_users_username_lower_unique
  ON admin_users ((lower(username)))
  WHERE username IS NOT NULL;
