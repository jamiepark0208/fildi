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

/** A264 — Data Sources panel: inventory catalog + 30d api_usage + research sync stamps. */
router.get("/admin/data-sources", requireAdmin, async (_req, res, next) => {
  try {
    const { DATA_SOURCES_CATALOG } = await import("../lib/data-sources-catalog.js");
    const { getApiUsageHistory } = await import("../lib/api-usage.js");
    const history = await getApiUsageHistory(30);
    const calls30 = new Map<string, number>();
    const lastCallDay = new Map<string, string>();
    for (const r of history) {
      calls30.set(r.source, (calls30.get(r.source) ?? 0) + r.callsMade);
      if (!lastCallDay.has(r.source) || r.date > lastCallDay.get(r.source)!) {
        lastCallDay.set(r.source, r.date);
      }
    }

    type SyncRow = { dataset: string; last_ok: string | null; rows: number | null; notes: string | null };
    const rowsOf = <T,>(r: unknown): T[] =>
      Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] })?.rows ?? []);
    let sync: SyncRow[] = [];
    try {
      const r = await db.execute(sql`
        SELECT dataset, last_ok_at::text AS last_ok, last_rows AS rows, notes
        FROM wrds_research.sync_state
        ORDER BY dataset`);
      sync = rowsOf<SyncRow>(r);
    } catch { /* schema may be absent on a fresh DB */ }
    try {
      const r = await db.execute(sql`
        SELECT dataset, last_ok_at::text AS last_ok, last_rows AS rows, notes
        FROM lseg_research.sync_state
        ORDER BY dataset`);
      const more = rowsOf<SyncRow>(r);
      sync = [...sync, ...more.map((s) => ({ ...s, dataset: `lseg:${s.dataset}` }))];
    } catch { /* optional */ }

    const sources = DATA_SOURCES_CATALOG.map((c) => {
      const key = c.usageKey;
      const calls = key ? (calls30.get(key) ?? 0) : 0;
      const limit = c.dailyLimit;
      const pctOfDaily = limit != null && limit > 0
        ? Math.min(100, Math.round((calls / 30 / limit) * 1000) / 10)
        : null;
      return {
        ...c,
        calls30d: calls,
        lastCallDate: key ? (lastCallDay.get(key) ?? null) : null,
        avgDailyCalls: Math.round((calls / 30) * 10) / 10,
        pctOfDailyLimit: pctOfDaily,
        nearLimit: pctOfDaily != null && pctOfDaily >= 70,
      };
    });

    res.json({
      asOf: new Date().toISOString(),
      inventoryRef: "research/common/data-inventory.md",
      sources,
      researchSync: sync,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
