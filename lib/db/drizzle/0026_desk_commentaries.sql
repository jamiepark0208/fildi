-- Desk commentaries ingested from FactSet StreetAccount (and later SA / other) emails.
-- Source-of-truth files live in Google Drive; this table is the app-facing index + text.
CREATE TABLE IF NOT EXISTS "desk_commentaries" (
  "id" serial PRIMARY KEY,
  "source" text NOT NULL DEFAULT 'factset_streetaccount',
  "kind" text NOT NULL,
  "gmail_message_id" text,
  "subject" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "ingested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "tickers_mentioned" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "synopsis" text,
  "body_plain" text,
  "drive_file_name" text,
  "meta" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS "desk_commentaries_gmail_id_uidx"
  ON "desk_commentaries" ("gmail_message_id") WHERE "gmail_message_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "desk_commentaries_received_idx"
  ON "desk_commentaries" ("received_at" DESC);
CREATE INDEX IF NOT EXISTS "desk_commentaries_kind_day_idx"
  ON "desk_commentaries" ("kind", "received_at" DESC);
