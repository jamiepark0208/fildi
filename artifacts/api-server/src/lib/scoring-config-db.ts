import { eq } from "drizzle-orm";
import { db, appConfig } from "@workspace/db";

export const SCORING_CONFIG_KEY = "scoring_weights";

export async function getScoringConfigValue(): Promise<unknown | null> {
  const rows = await db.select().from(appConfig).where(eq(appConfig.key, SCORING_CONFIG_KEY)).limit(1);
  return rows[0]?.value ?? null;
}

export async function upsertScoringConfigValue(value: unknown): Promise<void> {
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, SCORING_CONFIG_KEY)).limit(1);
  if (existing.length === 0) {
    await db.insert(appConfig).values({ key: SCORING_CONFIG_KEY, value });
  } else {
    await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, SCORING_CONFIG_KEY));
  }
}

export async function deleteScoringConfigValue(): Promise<void> {
  await db.delete(appConfig).where(eq(appConfig.key, SCORING_CONFIG_KEY));
}
