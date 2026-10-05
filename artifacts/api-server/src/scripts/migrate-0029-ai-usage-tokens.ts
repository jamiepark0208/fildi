/**
 * Add input_tokens / output_tokens to ai_usage_log.
 *   cd artifacts/api-server && npx tsx src/scripts/migrate-0029-ai-usage-tokens.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

await db.execute(sql`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS input_tokens integer`);
await db.execute(sql`ALTER TABLE ai_usage_log ADD COLUMN IF NOT EXISTS output_tokens integer`);
console.log("0029 ai_usage_log input_tokens / output_tokens ready");
process.exit(0);
