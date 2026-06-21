-- Track the non-secret encryption key identity used for backup artifacts.

ALTER TABLE backups
  ADD COLUMN IF NOT EXISTS encryption_key_id text;

UPDATE backups
SET encryption_key_id = 'app_secret'
WHERE encryption = 'app_secret'
  AND encryption_key_id IS NULL;

