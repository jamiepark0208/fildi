// Prunes tables that grow append-only with no natural cap. Anything keyed by a
// bounded set (ticker, ticker+scoreType, source+date) doesn't need this — only
// per-request/per-event logs do. Runs once/day off the same heartbeat as the
// nightly enrichment scheduler (see scheduler.ts) rather than a separate cron.
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

const AI_USAGE_LOG_RETENTION_DAYS = 90;
const API_USAGE_RETENTION_DAYS    = 180;
// Per-day intraday keys in app_config (intraday_regime_*, intraday_entry_signals_*,
// entry_signal_history_*) all embed an ISO date suffix, so a lexicographic key
// compare doubles as a date compare. 90 days keeps enough history for verdict grading.
const INTRADAY_CONFIG_RETENTION_DAYS = 90;

export async function pruneOldRows(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - INTRADAY_CONFIG_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    const aiUsage = await db.execute(
      sql`DELETE FROM ai_usage_log WHERE created_at < now() - ${sql.raw(`interval '${AI_USAGE_LOG_RETENTION_DAYS} days'`)}`
    );
    const apiUsage = await db.execute(
      sql`DELETE FROM api_usage WHERE date < current_date - ${API_USAGE_RETENTION_DAYS}`
    );
    const intradayKeys = await db.execute(
      sql`DELETE FROM app_config
          WHERE (key LIKE 'intraday_regime_%' AND key < ${`intraday_regime_${cutoff}`})
             OR (key LIKE 'intraday_entry_signals_%' AND key < ${`intraday_entry_signals_${cutoff}`})
             OR (key LIKE 'entry_signal_history_%' AND key < ${`entry_signal_history_${cutoff}`})`
    );
    logger.info(
      { aiUsageDeleted: aiUsage.rowCount ?? 0, apiUsageDeleted: apiUsage.rowCount ?? 0, intradayConfigDeleted: intradayKeys.rowCount ?? 0 },
      "retention: pruned old rows",
    );
  } catch (err) {
    logger.error({ err }, "retention: prune failed");
  }
}
