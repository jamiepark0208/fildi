CREATE TABLE IF NOT EXISTS "enrichment_runs" (
  "id"                  serial PRIMARY KEY,
  "started_at"          timestamp with time zone NOT NULL,
  "finished_at"         timestamp with time zone,
  "status"              text NOT NULL,
  "trigger"             text NOT NULL,
  "per_source"          jsonb,
  "coverage_before"     numeric,
  "coverage_after"      numeric,
  "error"               text,
  "flag_audit_orphaned" integer,
  "flag_audit_missing"  integer
);

CREATE INDEX IF NOT EXISTS "enrichment_runs_started_at_idx" ON "enrichment_runs" ("started_at");
