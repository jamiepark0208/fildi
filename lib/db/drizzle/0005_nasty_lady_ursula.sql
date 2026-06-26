CREATE TABLE "edgar_fundamentals" (
	"ticker" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edgar_total_revenue" numeric,
	"edgar_gross_profit" numeric,
	"edgar_net_income" numeric,
	"edgar_ebit" numeric,
	"edgar_ebitda" numeric,
	"edgar_free_cash_flow" numeric,
	"edgar_operating_cash_flow" numeric,
	"edgar_capital_expenditure" numeric,
	"edgar_cash_and_equivalents" numeric,
	"edgar_total_debt" numeric,
	"edgar_total_equity" numeric,
	"edgar_interest_expense" numeric,
	"edgar_shares_outstanding" numeric,
	"edgar_gross_margin" numeric,
	"edgar_net_margin" numeric
);
--> statement-breakpoint
CREATE TABLE "ticker_cik" (
	"ticker" text PRIMARY KEY NOT NULL,
	"cik" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
