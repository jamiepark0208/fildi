-- A329 Stock DB value audit findings (L0/L1/L2); UI chip phase 2.
CREATE TABLE IF NOT EXISTS "audit_findings" (
  "id" serial PRIMARY KEY,
  "run_id" text NOT NULL,
  "ticker" text NOT NULL,
  "field" text NOT NULL,
  "layer" text NOT NULL,
  "status" text NOT NULL,
  "gold" numeric,
  "truth" numeric,
  "truth_source" text,
  "class" text,
  "root_cause" text,
  "evidence" text,
  "fix" text,
  "finding_status" text NOT NULL DEFAULT 'open',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "audit_findings_run_ticker_field_layer"
  ON "audit_findings" ("run_id", "ticker", "field", "layer");
CREATE INDEX IF NOT EXISTS "audit_findings_run_class_idx"
  ON "audit_findings" ("run_id", "class");
