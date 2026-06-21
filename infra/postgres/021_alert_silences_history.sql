CREATE TABLE IF NOT EXISTS alert_silences (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  host_id uuid REFERENCES docker_hosts(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES alert_rules(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  reason text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_silences_active_idx
  ON alert_silences (starts_at, ends_at);

CREATE INDEX IF NOT EXISTS alert_silences_rule_idx
  ON alert_silences (rule_id);

CREATE INDEX IF NOT EXISTS alert_silences_host_idx
  ON alert_silences (host_id);

CREATE TABLE IF NOT EXISTS alert_events (
  id uuid PRIMARY KEY,
  rule_id uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
  host_id uuid REFERENCES docker_hosts(id) ON DELETE SET NULL,
  channel_id uuid REFERENCES notification_channels(id) ON DELETE SET NULL,
  state text NOT NULL,
  message text NOT NULL,
  notified boolean NOT NULL DEFAULT false,
  silenced boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_events_created_idx
  ON alert_events (created_at DESC);

CREATE INDEX IF NOT EXISTS alert_events_rule_created_idx
  ON alert_events (rule_id, created_at DESC);
