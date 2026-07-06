ALTER TABLE "ticker_registry" ADD COLUMN "fetch_fundamentals" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "ticker_registry"
SET "fetch_fundamentals" = true
WHERE "ticker" IN (SELECT "ticker" FROM "fmp_fundamentals");
