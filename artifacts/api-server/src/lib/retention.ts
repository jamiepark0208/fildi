/**
 * Housekeeping for append-only DB tables + unbounded log dirs.
 *
 * What this is:
 *   - api_usage     — daily vendor API call counters (FMP/AV/Polygon/…) for the
 *                     API Monitor budget bars. Not LLM tokens.
 *   - ai_usage_log  — Anthropic explain-button call log (per-user rate limits /
 *                     cost visibility). Pruning old rows keeps the monitor fast;
 *                     it does NOT shrink Cursor/agent context windows.
 *   - app_config intraday_* / entry_signal_history_* — Live writes one key per
 *                     calendar day. Without prune these accumulate forever; 90d
 *                     keeps enough history for Live entry-verdict grading.
 *   - filesystem logs — /tmp/fildi-logs, /tmp/api-server.log, repo logs/*.log
 *
 * What this is NOT:
 *   - Does not delete fundamentals, prices, portfolio, or peer data.
 *   - Does not optimize Cursor chat tokens / agent context (different system).
 *
 * Runs from Mac Maintain (primary) and the API scheduler (backup if Maintain missed).
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";
import {
  rotateApiServerLogIfNeeded,
  pruneScriptLogs,
  pruneFildiRuntimeLogs,
} from "./log-rotation.js";

const AI_USAGE_LOG_RETENTION_DAYS = 90;
const API_USAGE_RETENTION_DAYS = 180;
// Per-day Live keys embed an ISO date suffix — lexicographic compare ≈ date compare.
const INTRADAY_CONFIG_RETENTION_DAYS = 90;

export type RetentionReport = {
  ok: boolean;
  aiUsageDeleted: number;
  apiUsageDeleted: number;
  intradayConfigDeleted: number;
  vendorRawDeleted: number;
  logs: { rotated: boolean; scriptLogsDeleted: number; fildiLogsDeleted: number };
};

export async function pruneOldRows(): Promise<RetentionReport> {
  const empty: RetentionReport = {
    ok: false,
    aiUsageDeleted: 0,
    apiUsageDeleted: 0,
    intradayConfigDeleted: 0,
    vendorRawDeleted: 0,
    logs: { rotated: false, scriptLogsDeleted: 0, fildiLogsDeleted: 0 },
  };
  try {
    const cutoff = new Date(Date.now() - INTRADAY_CONFIG_RETENTION_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const aiUsage = await db.execute(
      sql`DELETE FROM ai_usage_log WHERE created_at < now() - ${sql.raw(`interval '${AI_USAGE_LOG_RETENTION_DAYS} days'`)}`,
    );
    // PG: `date - integer` works; parameterized `$1` is typed numeric and fails (`date < integer`).
    const apiUsage = await db.execute(
      sql`DELETE FROM api_usage WHERE date < current_date - ${sql.raw(String(API_USAGE_RETENTION_DAYS))}`,
    );
    const intradayKeys = await db.execute(
      sql`DELETE FROM app_config
          WHERE (key LIKE 'intraday_regime_%' AND key < ${`intraday_regime_${cutoff}`})
             OR (key LIKE 'intraday_entry_signals_%' AND key < ${`intraday_entry_signals_${cutoff}`})
             OR (key LIKE 'entry_signal_history_%' AND key < ${`entry_signal_history_${cutoff}`})`,
    );

    // Filesystem side — same pass so Maintain covers DB + disk.
    let rotated = false;
    try {
      rotateApiServerLogIfNeeded();
      rotated = true;
    } catch {
      /* logged inside */
    }
    const scriptLogsDeleted = pruneScriptLogs();
    const fildiLogsDeleted = pruneFildiRuntimeLogs();
    let vendorRawDeleted = 0;
    try {
      const { pruneVendorRaw } = await import("./vendor-raw.js");
      vendorRawDeleted = await pruneVendorRaw();
    } catch (err) {
      logger.error({ err }, "retention: vendor_raw prune failed");
    }

    const report: RetentionReport = {
      ok: true,
      aiUsageDeleted: aiUsage.rowCount ?? 0,
      apiUsageDeleted: apiUsage.rowCount ?? 0,
      intradayConfigDeleted: intradayKeys.rowCount ?? 0,
      vendorRawDeleted,
      logs: { rotated, scriptLogsDeleted, fildiLogsDeleted },
    };
    logger.info(report, "retention: pruned old rows + logs");
    return report;
  } catch (err) {
    logger.error({ err }, "retention: prune failed");
    return empty;
  }
}
