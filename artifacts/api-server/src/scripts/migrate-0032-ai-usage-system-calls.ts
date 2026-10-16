/**
 * A130: log every metered LLM call, not only per-user Explain AI.
 * user_id nullable (system jobs: daily brief, desk news, macro, transcripts) + model column for cost.
 *   cd artifacts/api-server && npx tsx src/scripts/migrate-0032-ai-usage-system-calls.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

await db.execute(sql`ALTER TABLE ai_usage_log ALTER COLUMN user_id DROP NOT NULL`);
await db.execute(sql`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS model text`);
console.log("0032 ai_usage_log user_id nullable + model ready");
process.exit(0);
