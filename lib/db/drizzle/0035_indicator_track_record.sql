-- tv-indicators spec phase 2 B: indicator track record (events, grades, scorecard).
CREATE TABLE IF NOT EXISTS "indicator_events" (
  "id" serial PRIMARY KEY,
  "indicator_id" text NOT NULL,
  "version" integer NOT NULL,
  "ticker" text NOT NULL,
  "tf" text NOT NULL,
  "time" timestamp with time zone NOT NULL,
  "side" text NOT NULL,
  "kind" text NOT NULL,
  "price" numeric NOT NULL,
  "atr" numeric,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "indicator_events_uniq" UNIQUE ("indicator_id", "version", "ticker", "tf", "time", "kind", "side")
);
CREATE INDEX IF NOT EXISTS "indicator_events_lookup_idx" ON "indicator_events" ("indicator_id", "version", "tf");
CREATE TABLE IF NOT EXISTS "indicator_grades" (
  "event_id" integer PRIMARY KEY REFERENCES "indicator_events"("id") ON DELETE CASCADE,
  "fwd_30m_pct" numeric,
  "fwd_60m_pct" numeric,
  "fwd_close_pct" numeric,
  "mfe_atr" numeric,
  "mae_atr" numeric,
  "hit" boolean,
  "placebo_hit" boolean,
  "graded_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS "indicator_scorecard" (
  "indicator_id" text NOT NULL,
  "version" integer NOT NULL,
  "kind" text NOT NULL,
  "tf" text NOT NULL,
  "n" integer NOT NULL,
  "hit_pct" numeric,
  "placebo_hit_pct" numeric,
  "lift_pts" numeric,
  "t_stat" numeric,
  "sign_both_halves" boolean,
  "mde_pts" numeric,
  "verdict" text NOT NULL,
  "need_more" integer,
  "days" integer,
  "graded_through" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("indicator_id", "version", "kind", "tf")
);
