CREATE TABLE "analyst_events" (
	"ticker" text NOT NULL,
	"firm" text NOT NULL,
	"source" text DEFAULT 'yahoo' NOT NULL,
	"action" text NOT NULL,
	"from_grade" text,
	"to_grade" text,
	"event_date" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyst_events_ticker_firm_event_date_source_pk" PRIMARY KEY("ticker","firm","event_date","source")
);
--> statement-breakpoint
CREATE TABLE "explain_cache" (
	"ticker" text NOT NULL,
	"score_type" text NOT NULL,
	"score_hash" text NOT NULL,
	"explanation" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "explain_cache_ticker_score_type_pk" PRIMARY KEY("ticker","score_type")
);
--> statement-breakpoint
CREATE TABLE "user_portfolio_names" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "idx_user_portfolio_names_user_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "yahoo_analyst_actions" (
	"ticker" text NOT NULL,
	"firm" text NOT NULL,
	"action" text NOT NULL,
	"from_grade" text,
	"to_grade" text,
	"event_date" date NOT NULL,
	"source_event_id" text NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "yahoo_analyst_actions_ticker_source_event_id_pk" PRIMARY KEY("ticker","source_event_id")
);
--> statement-breakpoint
ALTER TABLE "user_portfolio_names" ADD CONSTRAINT "user_portfolio_names_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_analyst_events_ticker_fetched" ON "analyst_events" USING btree ("ticker","fetched_at");--> statement-breakpoint
CREATE INDEX "idx_yahoo_analyst_actions_ticker_fetched" ON "yahoo_analyst_actions" USING btree ("ticker","fetched_at");