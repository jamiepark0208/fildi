CREATE TABLE "app_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"priority" integer NOT NULL,
	"daily_limit" integer NOT NULL,
	"calls_today" integer DEFAULT 0 NOT NULL,
	"last_reset_date" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "data_sources_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "earnings_calendar" (
	"ticker" text NOT NULL,
	"report_date" date NOT NULL,
	"is_confirmed" boolean DEFAULT false NOT NULL,
	"eps_estimate" numeric,
	"eps_actual" numeric,
	"surprise_pct" numeric,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earnings_calendar_ticker_report_date_pk" PRIMARY KEY("ticker","report_date")
);
--> statement-breakpoint
CREATE TABLE "fmp_api_usage" (
	"id" integer PRIMARY KEY NOT NULL,
	"calls_today" integer DEFAULT 0 NOT NULL,
	"reset_date" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indicator_cache" (
	"ticker" text NOT NULL,
	"scored_date" date NOT NULL,
	"rsi" numeric NOT NULL,
	"mfi" numeric NOT NULL,
	"rsi_threshold" numeric NOT NULL,
	"signal" text NOT NULL,
	"atr" numeric,
	"macd_cross" text,
	"stoch" numeric,
	"return_5d" numeric,
	"position_52w" numeric,
	"vs_spy_20d" numeric,
	"earnings_date" date,
	CONSTRAINT "indicator_cache_ticker_scored_date_pk" PRIMARY KEY("ticker","scored_date")
);
--> statement-breakpoint
CREATE TABLE "invite_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"created_by" integer NOT NULL,
	"used_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "likes" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "likes_post_id_user_id_unique" UNIQUE("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "portfolio_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"account" text NOT NULL,
	"symbol" text NOT NULL,
	"option_type" text,
	"strike" numeric,
	"expiration" date,
	"direction" text,
	"qty" numeric,
	"avg_premium" numeric,
	"total_premium" numeric,
	"mark_price" numeric,
	"unrealized_pnl" numeric,
	"pnl_pct" numeric,
	"iv" numeric,
	"delta" numeric,
	"gamma" numeric,
	"theta" numeric,
	"vega" numeric
);
--> statement-breakpoint
CREATE TABLE "portfolio_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"account" text NOT NULL,
	"symbol" text NOT NULL,
	"side" text,
	"order_type" text,
	"state" text,
	"quantity" numeric,
	"avg_fill_price" numeric,
	"created_at" timestamp with time zone,
	"is_option" boolean DEFAULT false NOT NULL,
	"option_strike" numeric,
	"option_expiration" date,
	"option_side" text
);
--> statement-breakpoint
CREATE TABLE "portfolio_positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_id" integer NOT NULL,
	"account" text NOT NULL,
	"account_nickname" text,
	"symbol" text NOT NULL,
	"quantity" numeric,
	"avg_cost" numeric,
	"last_price" numeric,
	"market_value" numeric,
	"cost_basis" numeric,
	"unrealized_pnl" numeric,
	"pnl_pct" numeric,
	"day_change_pct" numeric,
	"bid" numeric,
	"ask" numeric
);
--> statement-breakpoint
CREATE TABLE "portfolio_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"account_ids" text[] DEFAULT '{}' NOT NULL,
	"total_value" numeric,
	"raw_filename" text
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"account_id" text NOT NULL,
	"ticker" text NOT NULL,
	"position_type" text NOT NULL,
	"strike" numeric,
	"expiry" date,
	"qty" integer NOT NULL,
	"avg_price" numeric NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"pnl" numeric,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "prices_historical" (
	"ticker" text NOT NULL,
	"date" date NOT NULL,
	"open" numeric,
	"high" numeric,
	"low" numeric,
	"close" numeric,
	"volume" bigint,
	CONSTRAINT "prices_historical_ticker_date_pk" PRIMARY KEY("ticker","date")
);
--> statement-breakpoint
CREATE TABLE "signal_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rsi_at_fire" numeric,
	"mfi_at_fire" numeric,
	"return_5d" numeric,
	"rm_result" text,
	"catalyst_found" text,
	"strike" numeric,
	"expiry" date,
	"premium" numeric,
	"income_pct" numeric,
	"vix_at_fire" numeric,
	"outcome" text
);
--> statement-breakpoint
CREATE TABLE "stock_buckets" (
	"user_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"bucket" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_buckets_user_id_ticker_pk" PRIMARY KEY("user_id","ticker")
);
--> statement-breakpoint
CREATE TABLE "ticker_config" (
	"ticker" text PRIMARY KEY NOT NULL,
	"tier" integer NOT NULL,
	"rsi_threshold" numeric NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "ticker_fundamentals" (
	"ticker" text PRIMARY KEY NOT NULL,
	"fundamentals_last_fetched" timestamp with time zone,
	"discrepancy_flags" text,
	"fmp_coverage_percent" numeric,
	"pe_ratio" numeric,
	"peg_ratio" numeric,
	"price_to_book" numeric,
	"price_to_sales" numeric,
	"debt_to_equity" numeric,
	"total_revenue" numeric,
	"revenue_growth_yoy" numeric,
	"net_income" numeric,
	"ebitda" numeric,
	"earnings_per_share" numeric,
	"eps_growth" numeric,
	"free_cash_flow" numeric,
	"dividend_yield" numeric,
	"return_on_equity" numeric,
	"return_on_assets" numeric,
	"current_ratio" numeric,
	"gross_margin" numeric,
	"operating_margin" numeric,
	"net_margin" numeric,
	"beta" numeric,
	"analyst_target_price" numeric,
	"wacc" numeric,
	"roic" numeric,
	"interest_expense" numeric,
	"total_debt" numeric,
	"total_stockholders_equity" numeric,
	"ebit" numeric,
	"effective_tax_rate" numeric,
	"cash_and_equivalents" numeric,
	"quarterly_operating_cash_flow" numeric,
	"shares_outstanding" numeric,
	"shares_outstanding_prior" numeric,
	"last_source" text DEFAULT 'fmp',
	"data_quality_score" numeric
);
--> statement-breakpoint
CREATE TABLE "ticker_fundamentals_history" (
	"ticker" text NOT NULL,
	"year" integer NOT NULL,
	"pe_ratio" numeric,
	"price_to_book" numeric,
	"roic" numeric,
	"gross_margin" numeric,
	"operating_margin" numeric,
	"net_margin" numeric,
	"revenue" numeric,
	"ebitda" numeric,
	"eps" numeric,
	"source" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticker_fundamentals_history_ticker_year_pk" PRIMARY KEY("ticker","year")
);
--> statement-breakpoint
CREATE TABLE "ticker_registry" (
	"ticker" text PRIMARY KEY NOT NULL,
	"name" text,
	"sector" text,
	"industry_group" text,
	"peer_tickers" text[],
	"index_memberships" text[],
	"is_active" boolean DEFAULT true NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticker_technicals" (
	"ticker" text PRIMARY KEY NOT NULL,
	"technicals_last_fetched" timestamp with time zone,
	"technicals_coverage" numeric,
	"rsi14" numeric,
	"rsi14_pct" numeric,
	"mfi14" numeric,
	"mfi14_pct" numeric,
	"stoch" numeric,
	"stoch_pct" numeric,
	"macd_hist" numeric,
	"macd_direction" text,
	"atr14" numeric,
	"atr14_pct" numeric,
	"rsi_velocity" numeric,
	"volume_ratio" numeric,
	"volume_ratio_pct" numeric,
	"realized_vol_20d" numeric,
	"bb_upper" numeric,
	"bb_lower" numeric,
	"bb_width" numeric,
	"bb_width_pct" numeric,
	"price_z_score" numeric,
	"ma20" numeric,
	"ma50" numeric,
	"ma200" numeric,
	"ma50_slope_10d" numeric,
	"price_vs_ma20_atr" numeric,
	"price_vs_ma50_atr" numeric,
	"price_vs_ma200_atr" numeric,
	"swing_high_20d" numeric,
	"swing_low_20d" numeric,
	"swing_high_50d" numeric,
	"swing_low_50d" numeric,
	"vwap_20d" numeric,
	"price_vs_vwap_pct" numeric,
	"pivot_point" numeric,
	"pivot_r1" numeric,
	"pivot_s1" numeric,
	"nearest_support_dist_pct" numeric,
	"nearest_resist_dist_pct" numeric,
	"regime" text,
	"falling_knife" integer,
	"atm_put_iv" numeric,
	"iv_rank" numeric,
	"iv_percentile" numeric,
	"implied_move_weekly" numeric,
	"iv_vs_realized_vol" numeric,
	"put_call_volume_ratio" numeric,
	"basic_skew" numeric,
	"iv_term_structure" numeric,
	"gex_net" numeric,
	"put_wall_strike" numeric,
	"call_wall_strike" numeric,
	"max_pain_strike" numeric,
	"delta_skew_25" numeric,
	"earnings_days_out" integer
);
--> statement-breakpoint
CREATE TABLE "trade_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"trade_type" text DEFAULT 'SELL_PUT' NOT NULL,
	"strike" numeric NOT NULL,
	"expiry" date NOT NULL,
	"contracts" integer DEFAULT 1 NOT NULL,
	"premium_per_contract" numeric NOT NULL,
	"confidence" integer NOT NULL,
	"notes" text,
	"iv_rank_at_entry" numeric,
	"tech_score_at_entry" numeric,
	"regime_at_entry" text,
	"vix_at_entry" numeric,
	"signal_at_entry" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"close_premium" numeric,
	"resolved_at" timestamp with time zone,
	"resolved_pnl" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"user_id" integer NOT NULL,
	"ticker" text NOT NULL,
	"tier" integer NOT NULL,
	"status" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "watchlist_user_id_ticker_pk" PRIMARY KEY("user_id","ticker")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_trade_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."trade_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_codes" ADD CONSTRAINT "invite_codes_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_post_id_trade_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."trade_posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "likes" ADD CONSTRAINT "likes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_options" ADD CONSTRAINT "portfolio_options_snapshot_id_portfolio_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."portfolio_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_orders" ADD CONSTRAINT "portfolio_orders_snapshot_id_portfolio_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."portfolio_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_positions" ADD CONSTRAINT "portfolio_positions_snapshot_id_portfolio_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."portfolio_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_buckets" ADD CONSTRAINT "stock_buckets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_posts" ADD CONSTRAINT "trade_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portfolio_options_snapshot_idx" ON "portfolio_options" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "portfolio_orders_snapshot_idx" ON "portfolio_orders" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "portfolio_positions_snapshot_idx" ON "portfolio_positions" USING btree ("snapshot_id");--> statement-breakpoint
CREATE INDEX "idx_positions_ticker" ON "positions" USING btree ("ticker");--> statement-breakpoint
CREATE INDEX "idx_prices_lookup" ON "prices_historical" USING btree ("ticker","date");--> statement-breakpoint
CREATE INDEX "idx_signal_log_ticker" ON "signal_log" USING btree ("ticker","fired_at");