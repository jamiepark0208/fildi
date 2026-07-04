CREATE TABLE "field_provenance" (
	"ticker" text NOT NULL,
	"field" text NOT NULL,
	"winning_source" text NOT NULL,
	"winning_value" numeric,
	"is_override" boolean DEFAULT false NOT NULL,
	"divergent" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "field_provenance_ticker_field_pk" PRIMARY KEY("ticker","field")
);
--> statement-breakpoint
CREATE TABLE "manual_overrides" (
	"ticker" text NOT NULL,
	"field" text NOT NULL,
	"override_source" text NOT NULL,
	"override_value" numeric,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_overrides_ticker_field_pk" PRIMARY KEY("ticker","field")
);
