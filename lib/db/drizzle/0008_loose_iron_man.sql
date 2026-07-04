CREATE TABLE "source_fundamentals" (
	"ticker" text NOT NULL,
	"source" text NOT NULL,
	"field" text NOT NULL,
	"value" numeric NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_fundamentals_ticker_source_field_pk" PRIMARY KEY("ticker","source","field")
);
