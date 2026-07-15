// Prunes tables that grow append-only with no natural cap. Anything keyed by a
// bounded set (ticker, ticker+scoreType, source+date) doesn't need this — only
// per-request/per-event logs do. Runs once/day off the same heartbeat as the
// nightly enrichment scheduler (see scheduler.ts) rather than a separate cron.
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

const AI_USAGE_LOG_RETENTION_DAYS = 90;
const API_USAGE_RETENTION_DAYS    = 180;

export async function pruneOldRows(): Promise<void> {
  try {
    const aiUsage = await db.execute(
      sql`DELETE FROM ai_usage_log WHERE created_at < now() - ${sql.raw(`interval '${AI_USAGE_LOG_RETENTION_DAYS} days'`)}`
    );
    const apiUsage = await db.execute(
      sql`DELETE FROM api_usage WHERE date < current_date - ${API_USAGE_RETENTION_DAYS}`
    );
    logger.info(
      { aiUsageDeleted: aiUsage.rowCount ?? 0, apiUsageDeleted: apiUsage.rowCount ?? 0 },
      "retention: pruned old rows",
    );
  } catch (err) {
    logger.error({ err }, "retention: prune failed");
  }
}
