import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { computeRegime, type RegimeResult } from "../lib/regime-classifier.js";
import { logger } from "../lib/logger.js";
import { db, marketRegime } from "@workspace/db";
import { desc } from "drizzle-orm";

const router = Router();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let _cache: (RegimeResult & { cachedAt: number }) | null = null;

function isFresh(): boolean {
  return _cache !== null && Date.now() - _cache.cachedAt < CACHE_TTL_MS;
}

async function computeAndPersist(): Promise<RegimeResult> {
  const result = computeRegime();
  db.insert(marketRegime).values({
    regime:            result.regime,
    confidence:        result.confidence,
    signalScores:      result.signalScores,
    confirmingSignals: result.confirmingSignals,
    conflictingSignals: result.conflictingSignals,
    indicatorSnapshot: result.indicatorSnapshot,
  }).catch((err: unknown) => logger.warn({ err: String(err) }, "regime: DB insert failed"));
  return result;
}

router.get("/regime/macro", async (_req, res) => {
  if (isFresh()) return res.json(_cache);
  try {
    const result = await computeAndPersist();
    _cache = { ...result, cachedAt: Date.now() };
    return res.json(_cache);
  } catch (err: unknown) {
    logger.error({ err: String(err) }, "regime/macro: computeRegime failed");
    return res.status(500).json({ error: "regime computation failed" });
  }
});

router.post("/regime/macro/refresh", requireAdmin, async (_req, res) => {
  try {
    const result = await computeAndPersist();
    _cache = { ...result, cachedAt: Date.now() };
    return res.json(_cache);
  } catch (err: unknown) {
    logger.error({ err: String(err) }, "regime/macro/refresh: computeRegime failed");
    return res.status(500).json({ error: "regime computation failed" });
  }
});

// Exported for use by other routes (e.g. feed.ts)
export async function getLatestRegime(): Promise<string | null> {
  try {
    const [row] = await db.select({ regime: marketRegime.regime })
      .from(marketRegime)
      .orderBy(desc(marketRegime.computedAt))
      .limit(1);
    return row?.regime ?? null;
  } catch {
    return null;
  }
}

export default router;
