CREATE TABLE IF NOT EXISTS custom_catalog_templates (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]*$'),
  name text NOT NULL,
  description text NOT NULL,
  category text NOT NULL CHECK (category IN ('web', 'monitoring', 'database', 'devtools', 'automation', 'utility')),
  compose_yaml text NOT NULL,
  default_env jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(default_env) = 'object'),
  suggested_volumes text[] NOT NULL DEFAULT '{}',
  suggested_ports text[] NOT NULL DEFAULT '{}',
  docs_url text,
  created_by uuid REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custom_catalog_templates_category_idx
  ON custom_catalog_templates (category, name);
