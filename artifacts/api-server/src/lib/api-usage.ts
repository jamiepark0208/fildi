import { sql } from "drizzle-orm";
import { db, apiUsage } from "@workspace/db";
import { logger } from "./logger.js";

// Increment call count for a source on today's date.
export async function recordApiUsage(source: string, calls: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await db
    .insert(apiUsage)
    .values({ source, date: today, callsMade: calls })
    .onConflictDoUpdate({
      target: [apiUsage.source, apiUsage.date],
      set: { callsMade: sql`${apiUsage.callsMade} + ${calls}`, updatedAt: sql`now()` },
    });
}

// Return call counts for the past N days across all sources.
export async function getApiUsageHistory(days: number): Promise<{ source: string; date: string; callsMade: number }[]> {
  const rows = await db.execute<{ source: string; date: string; calls_made: number }>(
    sql`SELECT source, date::text, calls_made FROM api_usage WHERE date >= current_date - ${sql.raw(String(days - 1))} ORDER BY source, date DESC`
  );
  return rows.rows.map(r => ({ source: r.source, date: r.date, callsMade: r.calls_made }));
}

// Check whether a source with a known daily limit has budget remaining.
// throws with a descriptive message if budget is exhausted.
export async function checkDailyBudget(source: string, dailyLimit: number, estimatedCalls: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.execute<{ calls_made: number }>(
    sql`SELECT calls_made FROM api_usage WHERE source = ${source} AND date = ${today}::date`
  );
  const callsToday = rows.rows[0]?.calls_made ?? 0;
  const remaining = dailyLimit - callsToday;
  if (remaining < estimatedCalls) {
    const msg = `${source}: daily budget exhausted — ${callsToday}/${dailyLimit} calls used, need ${estimatedCalls} more`;
    logger.warn({ source, callsToday, dailyLimit, estimatedCalls, remaining }, msg);
    throw new Error(msg);
  }
}
