-- app_config: key-value store for global settings (scoring_weights JSON)
CREATE TABLE IF NOT EXISTS app_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
