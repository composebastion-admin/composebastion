ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner',
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

ALTER TABLE docker_hosts
  ADD COLUMN IF NOT EXISTS connection_mode text NOT NULL DEFAULT 'ssh',
  ADD COLUMN IF NOT EXISTS agent_url text,
  ADD COLUMN IF NOT EXISTS agent_token_encrypted text;

ALTER TABLE docker_hosts ALTER COLUMN ssh_key_encrypted DROP NOT NULL;

CREATE TABLE IF NOT EXISTS notification_channels (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  email_to text,
  webhook_url text,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  condition text NOT NULL,
  host_id uuid NOT NULL REFERENCES docker_hosts(id) ON DELETE CASCADE,
  container_id text,
  channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  last_state text,
  last_checked_at timestamptz,
  last_notified_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS registries (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL,
  username text,
  password_encrypted text,
  insecure boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
