import { Router } from "express";
import { db, tickerFundamentals, tickerRegistry, fieldProvenance, polygonFundamentals, avFundamentals } from "@workspace/db";
import { eq, isNull, isNotNull, sql } from "drizzle-orm";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { lastEnrichmentRun, enrichmentRunning } from "../lib/scheduler.js";
import { FIELD_DEFS } from "../scripts/merge-trusted.js";
import { DATA_HEALTH_STALE_DAYS } from "../lib/data-ops-config.js";

const router = Router();

const STALE_DAYS = DATA_HEALTH_STALE_DAYS;
const TOP_NULL_FIELDS = 5;

router.get("/admin/data-health", requireAdmin, async (_req, res, next) => {
  try {
    const [tfRows, regRows, provRows, polygonCountRows, avCountRows] = await Promise.all([
      db.select({
        ticker: tickerFundamentals.ticker,
        fundamentalsLastFetched: tickerFundamentals.fundamentalsLastFetched,
      }).from(tickerFundamentals),
      db.select({ ticker: tickerRegistry.ticker })
        .from(tickerRegistry)
        .where(eq(tickerRegistry.fetchFundamentals, true)),
      db.select({ divergent: fieldProvenance.divergent })
        .from(fieldProvenance)
        .where(eq(fieldProvenance.divergent, true)),
      db.select({ count: sql<number>`count(*)` }).from(polygonFundamentals),
      db.select({ count: sql<number>`count(*)` }).from(avFundamentals),
    ]);

    const activeSet = new Set(regRows.map(r => r.ticker));
    const active = tfRows.filter(r => activeSet.has(r.ticker));
    const now = Date.now();
    const staleMs = STALE_DAYS * 86_400_000;

    let fresh = 0, stale = 0, neverFetched = 0;
    for (const r of active) {
      if (!r.fundamentalsLastFetched) { neverFetched++; continue; }
      const age = now - new Date(r.fundamentalsLastFetched as unknown as string).getTime();
      if (age < staleMs) fresh++; else stale++;
    }

    // Null count per field across active tickers
    const allTf = await db.select().from(tickerFundamentals);
    const tfMap = new Map(allTf.map(r => [r.ticker, r]));
    const validFields = FIELD_DEFS.filter(d => (d.tfCol as string) !== "grossProfit");
    const fieldNulls = validFields.map(fd => {
      const col = fd.tfCol as string;
      const nullCount = [...activeSet].filter(t => {
        const row = tfMap.get(t);
        return !row || (row as Record<string, unknown>)[col] == null;
      }).length;
      return { field: col, nullCount };
    });
    fieldNulls.sort((a, b) => b.nullCount - a.nullCount);
    const topNullFields = fieldNulls.slice(0, TOP_NULL_FIELDS);

    res.json({
      totalActive: active.length,
      fresh,
      stale,
      neverFetched,
      staleDaysThreshold: STALE_DAYS,
      divergentCount: provRows.length,
      topNullFields,
      lastEnrichmentRun: lastEnrichmentRun?.toISOString() ?? null,
      enrichmentRunning,
      bronze: {
        polygonRows: Number(polygonCountRows[0]?.count ?? 0),
        avRows: Number(avCountRows[0]?.count ?? 0),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
