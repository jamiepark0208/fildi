/**
 * Keep data_sources.calls_today honest across calendar day boundaries.
 * Uses Postgres CURRENT_DATE (local TZ on Postgres.app = America/Los_Angeles),
 * aligned with usageCalendarDate() / API Monitor "Today" — not UTC midnight.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

export async function resetDataSourceDailyCountersIfNeeded(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE data_sources
    SET calls_today = 0,
        last_reset_date = to_char(CURRENT_DATE, 'YYYY-MM-DD')
    WHERE last_reset_date IS DISTINCT FROM to_char(CURRENT_DATE, 'YYYY-MM-DD')
  `);
  const n = Number((result as { rowCount?: number }).rowCount ?? 0);
  if (n > 0) {
    logger.info({ rows: n }, "data-ops: reset data_sources daily counters");
  }
  return n;
}
