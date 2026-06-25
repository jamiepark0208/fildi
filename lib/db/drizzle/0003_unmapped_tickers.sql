CREATE TABLE "unmapped_tickers" (
	"ticker" text PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
