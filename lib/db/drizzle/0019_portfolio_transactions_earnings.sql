CREATE TABLE IF NOT EXISTS "portfolio_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"txn_id" text NOT NULL,
	"account" text NOT NULL,
	"symbol" text NOT NULL,
	"txn_type" text,
	"category" text,
	"side" text,
	"quantity" numeric,
	"price" numeric,
	"amount" numeric,
	"txn_date" timestamp with time zone,
	"source" text,
	"confidence" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_transactions_txn_id_unique" UNIQUE("txn_id")
);
CREATE INDEX IF NOT EXISTS "portfolio_transactions_symbol_idx" ON "portfolio_transactions" ("symbol");

CREATE TABLE IF NOT EXISTS "portfolio_ticker_earnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"account" text NOT NULL,
	"ticker" text NOT NULL,
	"total_unrealized" numeric,
	"total_realized" numeric,
	"total_earned" numeric,
	"sell_put" numeric,
	"sell_call" numeric,
	"long_call" numeric,
	"long_put" numeric,
	"dividends" numeric,
	"stocks_realized" numeric,
	"stocks_unrealized" numeric,
	"total_stocks" numeric,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_ticker_earnings_account_ticker_unique" UNIQUE("account","ticker")
);
