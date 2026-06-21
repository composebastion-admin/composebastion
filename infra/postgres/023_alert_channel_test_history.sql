CREATE TABLE IF NOT EXISTS alert_channel_test_events (
  id uuid PRIMARY KEY,
  channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  status text NOT NULL,
  error text,
  tested_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  tested_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alert_channel_test_events_channel_tested_idx
  ON alert_channel_test_events (channel_id, tested_at DESC);

ALTER TABLE docker_hosts
  ADD COLUMN IF NOT EXISTS agent_version text;
