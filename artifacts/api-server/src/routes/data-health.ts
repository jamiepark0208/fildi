import { Router } from "express";
import {
  db,
  tickerFundamentals,
  tickerRegistry,
  fieldProvenance,
  polygonFundamentals,
  avFundamentals,
  enrichmentRuns,
} from "@workspace/db";
import { eq, desc, inArray, sql } from "drizzle-orm";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { lastEnrichmentRun, enrichmentRunning, noteEnrichmentRunFromDb } from "../lib/scheduler.js";
import { FIELD_DEFS } from "../scripts/merge-trusted.js";
import { DATA_HEALTH_STALE_DAYS } from "../lib/data-ops-config.js";

const router = Router();

const STALE_DAYS = DATA_HEALTH_STALE_DAYS;
const TOP_NULL_FIELDS = 5;

router.get("/admin/data-health", requireAdmin, async (_req, res, next) => {
  try {
    const [tfRows, regRows, provRows, polygonCountRows, avCountRows, enrichStamp] = await Promise.all([
      db
        .select({
          ticker: tickerFundamentals.ticker,
          fundamentalsLastFetched: tickerFundamentals.fundamentalsLastFetched,
        })
        .from(tickerFundamentals),
      db
        .select({ ticker: tickerRegistry.ticker })
        .from(tickerRegistry)
        .where(eq(tickerRegistry.fetchFundamentals, true)),
      db
        .select({ divergent: fieldProvenance.divergent })
        .from(fieldProvenance)
        .where(eq(fieldProvenance.divergent, true)),
      db.select({ count: sql<number>`count(*)` }).from(polygonFundamentals),
      db.select({ count: sql<number>`count(*)` }).from(avFundamentals),
      // SoT: enrichment_runs (Maintain + nightly), not stale app_config last_enrichment_run
      db
        .select({
          finishedAt: enrichmentRuns.finishedAt,
          trigger: enrichmentRuns.trigger,
          status: enrichmentRuns.status,
        })
        .from(enrichmentRuns)
        .where(inArray(enrichmentRuns.status, ["success", "partial"]))
        .orderBy(desc(enrichmentRuns.finishedAt))
        .limit(1),
    ]);

    const activeSet = new Set(regRows.map((r) => r.ticker));
    const active = tfRows.filter((r) => activeSet.has(r.ticker));
    const now = Date.now();
    const staleMs = STALE_DAYS * 86_400_000;

    let fresh = 0,
      stale = 0,
      neverFetched = 0;
    for (const r of active) {
      if (!r.fundamentalsLastFetched) {
        neverFetched++;
        continue;
      }
      const age = now - new Date(r.fundamentalsLastFetched as unknown as string).getTime();
      if (age < staleMs) fresh++;
      else stale++;
    }

    const allTf = await db.select().from(tickerFundamentals);
    const tfMap = new Map(allTf.map((r) => [r.ticker, r]));
    const validFields = FIELD_DEFS.filter((d) => (d.tfCol as string) !== "grossProfit");
    const fieldNulls = validFields.map((fd) => {
      const col = fd.tfCol as string;
      const nullCount = [...activeSet].filter((t) => {
        const row = tfMap.get(t);
        return !row || (row as Record<string, unknown>)[col] == null;
      }).length;
      return { field: col, nullCount };
    });
    fieldNulls.sort((a, b) => b.nullCount - a.nullCount);
    const topNullFields = fieldNulls.slice(0, TOP_NULL_FIELDS);

    const runRow = enrichStamp[0];
    const fromRuns = runRow?.finishedAt ? new Date(runRow.finishedAt as unknown as string) : null;
    const mem = lastEnrichmentRun;
    const last =
      fromRuns && mem
        ? fromRuns.getTime() >= mem.getTime()
          ? fromRuns
          : mem
        : (fromRuns ?? mem);
    if (fromRuns) noteEnrichmentRunFromDb(fromRuns);

    res.json({
      totalActive: active.length,
      fresh,
      stale,
      neverFetched,
      staleDaysThreshold: STALE_DAYS,
      divergentCount: provRows.length,
      topNullFields,
      lastEnrichmentRun: last?.toISOString() ?? null,
      lastEnrichmentTrigger: runRow?.trigger ?? null,
      lastEnrichmentStatus: runRow?.status ?? null,
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
