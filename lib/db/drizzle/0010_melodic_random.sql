CREATE TABLE "api_usage" (
	"source" text NOT NULL,
	"date" date NOT NULL,
	"calls_made" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_usage_source_date_pk" PRIMARY KEY("source","date")
);
--> statement-breakpoint
ALTER TABLE "finnhub_fundamentals" ADD COLUMN "finnhub_dividend_yield" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_total_score" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_quality_score" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_growth_score" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_safety_score" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_rank" integer;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "fund_score_computed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticker_registry" ADD COLUMN "fetch_fundamentals" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_trailing_pe" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_dividend_yield" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_annual_revenue_yoy_prior" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_eps_growth" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_shares_outstanding_prior" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_effective_tax_rate" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_interest_expense" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_quarterly_ocf" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_roic" numeric;--> statement-breakpoint
ALTER TABLE "yahoo_fundamentals" ADD COLUMN "yahoo_wacc" numeric;--> statement-breakpoint
CREATE INDEX "idx_comments_post_id" ON "comments" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_likes_post_id" ON "likes" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_likes_user_id" ON "likes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_positions_user_id" ON "positions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ticker_fundamentals_last_fetched" ON "ticker_fundamentals" USING btree ("fundamentals_last_fetched");--> statement-breakpoint
CREATE INDEX "idx_ticker_registry_sector" ON "ticker_registry" USING btree ("sector");--> statement-breakpoint
CREATE INDEX "idx_ticker_registry_industry" ON "ticker_registry" USING btree ("industry_group");--> statement-breakpoint
CREATE INDEX "idx_trade_posts_user_id" ON "trade_posts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_trade_posts_ticker" ON "trade_posts" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "idx_watchlist_user_id" ON "watchlist" USING btree ("user_id");