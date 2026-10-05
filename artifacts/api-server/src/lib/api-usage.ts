import { sql } from "drizzle-orm";
import { db, apiUsage } from "@workspace/db";
import { logger } from "./logger.js";
import { usageCalendarDate } from "./usage-date.js";

/** Canonical api_usage.source keys (Settings → API Monitor). */
const SOURCE_ALIASES: Record<string, string> = {
  alpha_vantage: "av",
};

export function normalizeUsageSource(source: string): string {
  const s = source.trim().toLowerCase();
  return SOURCE_ALIASES[s] ?? s;
}

// Increment call count for a source on today's (US/Pacific) date.
export async function recordApiUsage(source: string, calls: number): Promise<void> {
  if (!Number.isFinite(calls) || calls <= 0) return;
  const today = usageCalendarDate();
  const key = normalizeUsageSource(source);
  await db
    .insert(apiUsage)
    .values({ source: key, date: today, callsMade: calls })
    .onConflictDoUpdate({
      target: [apiUsage.source, apiUsage.date],
      set: { callsMade: sql`${apiUsage.callsMade} + ${calls}`, updatedAt: sql`now()` },
    });
}

// Return call counts for the past N days across all sources (Pacific calendar window).
export async function getApiUsageHistory(days: number): Promise<{ source: string; date: string; callsMade: number }[]> {
  const n = Math.min(Math.max(days, 1), 30);
  const end = usageCalendarDate();
  const startDate = new Date(`${end}T12:00:00`);
  startDate.setDate(startDate.getDate() - (n - 1));
  const start = usageCalendarDate(startDate);
  const rows = await db.execute<{ source: string; date: string; calls_made: number }>(
    sql`SELECT source, date::text, calls_made FROM api_usage
        WHERE date >= ${start}::date AND date <= ${end}::date
        ORDER BY source, date DESC`,
  );
  return rows.rows.map(r => ({ source: r.source, date: r.date, callsMade: Number(r.calls_made) }));
}

// Check whether a source with a known daily limit has budget remaining.
// throws with a descriptive message if budget is exhausted.
export async function checkDailyBudget(source: string, dailyLimit: number, estimatedCalls: number): Promise<void> {
  const today = usageCalendarDate();
  const key = normalizeUsageSource(source);
  const rows = await db.execute<{ calls_made: number }>(
    sql`SELECT calls_made FROM api_usage WHERE source = ${key} AND date = ${today}::date`,
  );
  const callsToday = rows.rows[0]?.calls_made ?? 0;
  const remaining = dailyLimit - callsToday;
  if (remaining < estimatedCalls) {
    const msg = `${key}: daily budget exhausted — ${callsToday}/${dailyLimit} calls used, need ${estimatedCalls} more`;
    logger.warn({ source: key, callsToday, dailyLimit, estimatedCalls, remaining }, msg);
    throw new Error(msg);
  }
}
