-- Desk ingest v2: deterministic normalize columns + news feedback
ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "from_address" text;
ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "from_domain" text;
ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "category" text;
ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "article_published_at" timestamp with time zone;
ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "noise_score" integer;
ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "parser_version" integer;

CREATE INDEX IF NOT EXISTS "desk_commentaries_category_idx"
  ON "desk_commentaries" ("category", "received_at" DESC);
CREATE INDEX IF NOT EXISTS "desk_commentaries_noise_idx"
  ON "desk_commentaries" ("noise_score");

CREATE TABLE IF NOT EXISTS "desk_news_feedback" (
  "id" serial PRIMARY KEY,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "session_date" text NOT NULL,
  "feedback_type" text NOT NULL,
  "bullet_text" text,
  "reason" text,
  "question" text,
  "meta" jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "desk_news_feedback_session_idx"
  ON "desk_news_feedback" ("session_date", "created_at" DESC);
