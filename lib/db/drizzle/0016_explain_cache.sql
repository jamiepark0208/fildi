CREATE TABLE IF NOT EXISTS "explain_cache" (
  "ticker"       text NOT NULL,
  "score_type"   text NOT NULL,
  "score_hash"   text NOT NULL,
  "explanation"  text NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "explain_cache_pkey" PRIMARY KEY ("ticker", "score_type")
);
