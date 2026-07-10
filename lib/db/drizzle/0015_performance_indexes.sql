-- Wave 2: Performance indexes for hot query paths
CREATE INDEX IF NOT EXISTS "idx_watchlist_user_id"               ON "watchlist"            USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_positions_user_id"               ON "positions"            USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_ticker_fundamentals_last_fetched" ON "ticker_fundamentals" USING btree ("fundamentals_last_fetched");
CREATE INDEX IF NOT EXISTS "idx_ticker_registry_sector"          ON "ticker_registry"      USING btree ("sector");
CREATE INDEX IF NOT EXISTS "idx_ticker_registry_industry"        ON "ticker_registry"      USING btree ("industry_group");
CREATE INDEX IF NOT EXISTS "idx_trade_posts_user_id"             ON "trade_posts"          USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_trade_posts_ticker"              ON "trade_posts"          USING btree ("ticker");
CREATE INDEX IF NOT EXISTS "idx_likes_post_id"                   ON "likes"                USING btree ("post_id");
CREATE INDEX IF NOT EXISTS "idx_likes_user_id"                   ON "likes"                USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_comments_post_id"                ON "comments"             USING btree ("post_id");
