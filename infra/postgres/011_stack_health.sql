-- Stack health: surface compose deploy failures on the stack itself.

ALTER TABLE compose_stacks
  ADD COLUMN IF NOT EXISTS last_deploy_error text;
