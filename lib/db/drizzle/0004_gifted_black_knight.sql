CREATE TABLE "source_ticker_map" (
	"ticker" text NOT NULL,
	"source" text NOT NULL,
	"source_ticker" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_ticker_map_ticker_source_pk" PRIMARY KEY("ticker","source")
);
--> statement-breakpoint
CREATE TABLE "yahoo_fundamentals" (
	"ticker" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"yahoo_gross_margins" numeric,
	"yahoo_operating_margins" numeric,
	"yahoo_profit_margins" numeric,
	"yahoo_return_on_equity" numeric,
	"yahoo_return_on_assets" numeric,
	"yahoo_revenue_growth" numeric,
	"yahoo_debt_to_equity" numeric,
	"yahoo_current_ratio" numeric,
	"yahoo_total_revenue" numeric,
	"yahoo_total_debt" numeric,
	"yahoo_total_cash" numeric,
	"yahoo_free_cashflow" numeric,
	"yahoo_operating_cashflow" numeric,
	"yahoo_ebitda" numeric,
	"yahoo_target_mean_price" numeric,
	"yahoo_forward_pe" numeric,
	"yahoo_peg_ratio" numeric,
	"yahoo_price_to_book" numeric,
	"yahoo_enterprise_to_ebitda" numeric,
	"yahoo_enterprise_to_revenue" numeric,
	"yahoo_trailing_eps" numeric,
	"yahoo_forward_eps" numeric,
	"yahoo_beta" numeric,
	"yahoo_shares_outstanding" numeric,
	"yahoo_float_shares" numeric,
	"yahoo_held_percent_insiders" numeric,
	"yahoo_short_ratio" numeric,
	"yahoo_annual_total_revenue" numeric,
	"yahoo_annual_gross_profit" numeric,
	"yahoo_annual_ebit" numeric,
	"yahoo_annual_net_income" numeric,
	"yahoo_annual_revenue_yoy" numeric,
	"yahoo_annual_cash" numeric,
	"yahoo_annual_total_debt" numeric,
	"yahoo_annual_total_equity" numeric,
	"yahoo_annual_operating_cash_flow" numeric,
	"yahoo_annual_capex" numeric,
	"yahoo_annual_free_cash_flow" numeric
);
--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "forward_pe" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "ev_ebitda" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "ev_revenue" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "revenue_growth_yoy_prior" numeric;--> statement-breakpoint
ALTER TABLE "ticker_fundamentals" ADD COLUMN "regime_at_score" text;