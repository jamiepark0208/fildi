import { eq } from "drizzle-orm";
import { db, appConfig } from "@workspace/db";
import { logger } from "../logger.js";
import {
  parseAttemptCount,
  nextAttemptCount,
  type RunAttempt,
  NO_ATTEMPT,
} from "../scheduler-catchup.js";

export type AttemptSlot = "enrichment" | "optionScore" | "eventBullets" | "earnings" | "fmp" | "retention";

export const ATTEMPT_AT: Record<AttemptSlot, string> = {
  enrichment: "last_enrichment_attempt",
  optionScore: "last_option_score_attempt",
  eventBullets: "last_event_bullets_attempt",
  earnings: "last_earnings_backfill_attempt",
  fmp: "last_fmp_analyst_feed_attempt",
  retention: "last_retention_prune_attempt",
};

export const ATTEMPT_COUNT: Record<AttemptSlot, string> = {
  enrichment: "enrichment_attempt_count",
  optionScore: "option_score_attempt_count",
  eventBullets: "event_bullets_attempt_count",
  earnings: "earnings_backfill_attempt_count",
  fmp: "fmp_analyst_feed_attempt_count",
  retention: "retention_prune_attempt_count",
};

export const attempts: Record<AttemptSlot, RunAttempt> = {
  enrichment: { ...NO_ATTEMPT },
  optionScore: { ...NO_ATTEMPT },
  eventBullets: { ...NO_ATTEMPT },
  earnings: { ...NO_ATTEMPT },
  fmp: { ...NO_ATTEMPT },
  retention: { ...NO_ATTEMPT },
};

async function getConfigString(key: string): Promise<string | null> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  const value = rows[0]?.value;
  return typeof value === "string" ? value : null;
}

export async function getConfigDate(key: string): Promise<Date | null> {
  const iso = await getConfigString(key);
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function setConfigValue(key: string, value: string): Promise<void> {
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key, value });
  } else {
    await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, key));
  }
}

export async function setConfigDate(key: string, date: Date): Promise<void> {
  await setConfigValue(key, date.toISOString());
}

export async function noteFailedAttempt(slot: AttemptSlot): Promise<void> {
  const now = new Date();
  let prev: string | null = null;
  try {
    prev = await getConfigString(ATTEMPT_COUNT[slot]);
  } catch { /* count starts at 1 */ }
  const next = nextAttemptCount(prev, now);
  attempts[slot] = { lastAttempt: now, attemptsOnDay: parseAttemptCount(next, now) };
  await setConfigValue(ATTEMPT_AT[slot], now.toISOString()).catch((err) =>
    logger.error({ err, slot }, "scheduler: failed to persist attempt time"),
  );
  await setConfigValue(ATTEMPT_COUNT[slot], next).catch((err) =>
    logger.error({ err, slot }, "scheduler: failed to persist attempt count"),
  );
}

export { getConfigString };
