CREATE TABLE "peer_group_members" (
	"group_id" text NOT NULL,
	"ticker" text NOT NULL,
	CONSTRAINT "peer_group_members_group_id_ticker_pk" PRIMARY KEY("group_id","ticker")
);
--> statement-breakpoint
CREATE TABLE "peer_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scoring_mode" text NOT NULL,
	"metric_exclusions" text[],
	"benchmarks" text[],
	"low_confidence" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticker_registry" ADD COLUMN "primary_peer_group_id" text;--> statement-breakpoint
ALTER TABLE "peer_group_members" ADD CONSTRAINT "peer_group_members_group_id_peer_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."peer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticker_registry" ADD CONSTRAINT "ticker_registry_primary_peer_group_id_peer_groups_id_fk" FOREIGN KEY ("primary_peer_group_id") REFERENCES "public"."peer_groups"("id") ON DELETE no action ON UPDATE no action;