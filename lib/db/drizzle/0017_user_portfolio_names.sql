CREATE TABLE IF NOT EXISTS "user_portfolio_names" (
  "id"         serial PRIMARY KEY NOT NULL,
  "user_id"    integer NOT NULL,
  "name"       text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  CONSTRAINT "idx_user_portfolio_names_user_name" UNIQUE ("user_id", "name")
);

DO $$ BEGIN
  ALTER TABLE "user_portfolio_names" ADD CONSTRAINT "user_portfolio_names_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
