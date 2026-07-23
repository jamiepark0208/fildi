import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { computeRegime, type RegimeResult } from "../lib/regime-classifier.js";
import { logger } from "../lib/logger.js";
import { db, marketRegime } from "@workspace/db";
import { desc } from "drizzle-orm";

// Multi-signal business-cycle regime (expansion/contraction/late_cycle/etc.),
// DB-persisted with signalScores/confirming/conflicting signals, 24h cache.
// Distinct from the intraday VIX-band volatility regime served at
// /volatility/regime (routes/macro-regime.ts) — different taxonomy, feeds
// home/fundamentals/feed scoring rather than option-strike selection.

const router = Router();
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let _cache: (RegimeResult & { cachedAt: number }) | null = null;

function isFresh(): boolean {
  return _cache !== null && Date.now() - _cache.cachedAt < CACHE_TTL_MS;
}

// On a cold process (post-restart), a persisted row from within the TTL window
// means we don't need to recompute — computeRegime() is cheap CPU-only scoring,
// but computeAndPersist() also writes a fresh market_regime row every time it
// runs, so avoiding an unnecessary call here also avoids an unnecessary insert.
async function seedFromDb(): Promise<void> {
  const [row] = await db.select()
    .from(marketRegime)
    .orderBy(desc(marketRegime.computedAt))
    .limit(1);
  if (!row) return;
  const cachedAt = row.computedAt.getTime();
  if (Date.now() - cachedAt >= CACHE_TTL_MS) return;
  _cache = {
    regime:             row.regime as RegimeResult["regime"],
    confidence:         row.confidence,
    signalScores:       row.signalScores as RegimeResult["signalScores"],
    confirmingSignals:  row.confirmingSignals,
    conflictingSignals: row.conflictingSignals,
    indicatorSnapshot:  row.indicatorSnapshot as RegimeResult["indicatorSnapshot"],
    computedAt:         row.computedAt,
    cachedAt,
  };
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
  if (!isFresh()) {
    await seedFromDb().catch((err: unknown) => logger.warn({ err: String(err) }, "regime: DB seed failed"));
  }
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

// For the admin cache monitor — exposes the in-process cache's fill state without
// letting other modules read/mutate _cache directly.
export function getCacheState(): { cachedAt: number } | null {
  return _cache ? { cachedAt: _cache.cachedAt } : null;
}

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
