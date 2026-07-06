-- Unified API call tracking table replacing fmp_api_usage (FMP-only, single-row)
-- and the AV flat-file cursor. Tracks daily call counts per source for
-- monitoring and budget enforcement across all data sources.
CREATE TABLE IF NOT EXISTS api_usage (
  source      text    NOT NULL,
  date        date    NOT NULL,
  calls_made  integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, date)
);
