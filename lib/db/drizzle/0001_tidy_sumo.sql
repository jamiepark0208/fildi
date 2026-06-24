CREATE TABLE "market_regime" (
	"id" serial PRIMARY KEY NOT NULL,
	"regime" text NOT NULL,
	"confidence" integer NOT NULL,
	"signal_scores" jsonb NOT NULL,
	"confirming_signals" text[] NOT NULL,
	"conflicting_signals" text[] NOT NULL,
	"indicator_snapshot" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"computed_by" text DEFAULT 'system' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_posts" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "trade_posts" ADD COLUMN "entry_price" numeric;--> statement-breakpoint
ALTER TABLE "trade_posts" ADD COLUMN "shares" integer;--> statement-breakpoint
ALTER TABLE "trade_posts" ADD COLUMN "stop_loss" numeric;--> statement-breakpoint
ALTER TABLE "trade_posts" ADD COLUMN "target_price" numeric;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_market_regime_computed_at" ON "market_regime" USING btree ("computed_at");