-- Recovery schedule capture mode: hot (online) or stop_first.

ALTER TABLE recovery_schedules
  ADD COLUMN IF NOT EXISTS capture_mode text NOT NULL DEFAULT 'hot'
    CHECK (capture_mode IN ('hot', 'stop_first'));
