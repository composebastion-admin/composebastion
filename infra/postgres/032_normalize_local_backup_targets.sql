-- Local recovery targets are named aliases for the manager recovery-points
-- directory. Older releases persisted unsupported custom paths/cache policies.
UPDATE backup_targets
SET config = '{}'::jsonb,
    local_cache_policy = 'keep',
    updated_at = now()
WHERE kind = 'local'
  AND (
    config IS DISTINCT FROM '{}'::jsonb
    OR local_cache_policy IS DISTINCT FROM 'keep'
  );

-- Health recorded by older releases did not prove write/read/delete access.
-- Force every target through the stronger qualification probe before it can
-- contribute a healthy readiness signal.
UPDATE backup_targets
SET health_status = 'unknown',
    health_checked_at = NULL,
    health_error = NULL,
    updated_at = now()
WHERE health_status IS DISTINCT FROM 'unknown'
   OR health_checked_at IS NOT NULL
   OR health_error IS NOT NULL;
