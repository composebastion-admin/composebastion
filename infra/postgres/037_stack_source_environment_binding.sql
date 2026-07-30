ALTER TABLE compose_stacks
  ADD COLUMN IF NOT EXISTS source_environment_encrypted text,
  ADD COLUMN IF NOT EXISTS source_environment_binding text;

ALTER TABLE compose_stacks
  DROP CONSTRAINT IF EXISTS compose_stacks_source_environment_binding_format;

ALTER TABLE compose_stacks
  ADD CONSTRAINT compose_stacks_source_environment_binding_format
    CHECK (
      source_environment_binding IS NULL
      OR source_environment_binding ~ '^[0-9a-f]{64}$'
    );

COMMENT ON COLUMN compose_stacks.source_environment_encrypted IS
  'Encrypted immutable runtime environment captured by the last qualified source deployment.';

COMMENT ON COLUMN compose_stacks.source_environment_binding IS
  'Server-keyed HMAC binding for the decrypted source environment. A NULL binding requires a fresh qualified source deployment.';
