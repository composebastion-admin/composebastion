ALTER TABLE alert_rules
  ADD COLUMN IF NOT EXISTS params jsonb,
  ADD COLUMN IF NOT EXISTS breaching_since timestamptz;
