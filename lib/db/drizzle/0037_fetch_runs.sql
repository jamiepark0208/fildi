-- A367: meter for tail/skip/backfill fetch jobs
CREATE TABLE IF NOT EXISTS fetch_runs (
  id               serial PRIMARY KEY,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  source           text NOT NULL,
  job              text NOT NULL,
  mode             text,
  keys_planned     integer,
  keys_skipped     integer,
  keys_fetched     integer,
  vendor_calls     integer,
  rows_inserted    integer,
  rows_changed     integer,
  seconds          double precision,
  meta             jsonb
);

CREATE INDEX IF NOT EXISTS fetch_runs_started_at_idx ON fetch_runs (started_at);
CREATE INDEX IF NOT EXISTS fetch_runs_job_idx ON fetch_runs (job);
