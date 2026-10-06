// Support for nightly-enrichment.ts: dated log, budget/queue helpers, coverage snapshot,
// peer-group backfill, and enrichment_runs bookkeeping (moved out; behavior unchanged).

import fs from "node:fs";
import path from "node:path";
import { sql, eq, and, isNull } from "drizzle-orm";
import { db, tickerRegistry, tickerFundamentals, enrichmentRuns } from "@workspace/db";
import { FIELD_DEFS } from "./merge-trusted.js";
import { classifyTicker } from "../lib/peer-classifier.js";
import { isExcludedEtf } from "../lib/etf-exclusions.js";
import { normalizeUsageSource } from "../lib/api-usage.js";
import { usageCalendarDate } from "../lib/usage-date.js";
import { isCohortDueToday } from "../lib/data-ops-config.js";

// ── Logging ────────────────────────────────────────────────────────────────────

const logDir  = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
fs.mkdirSync(logDir, { recursive: true });

export function log(line: string): void {
  const now = new Date().toISOString();
  const stamped = `[${now}] ${line}`;
  console.log(stamped);
  // Date per write: this module stays loaded in the long-lived server, so a
  // module-level date would freeze the filename at server start.
  fs.appendFileSync(path.join(logDir, `nightly-enrichment-${now.slice(0, 10)}.log`), stamped + "\n");
}

// ── Budget check ───────────────────────────────────────────────────────────────

export async function getRemainingBudgets(
  sourceOrder: readonly string[], sourceDailyLimits: Record<string, number>,
): Promise<Map<string, number>> {
  // Align with Settings API Monitor (Pacific day + av alias for alpha_vantage).
  const today = usageCalendarDate();
  const rows = await db.execute<{ source: string; calls_made: number }>(
    sql`SELECT source, calls_made FROM api_usage WHERE date = ${today}::date`,
  );
  const usedToday = new Map<string, number>(rows.rows.map(r => [r.source, r.calls_made]));
  const remaining = new Map<string, number>();
  for (const src of sourceOrder) {
    const limit = sourceDailyLimits[src];
    const key = normalizeUsageSource(src);
    const used = usedToday.get(key) ?? usedToday.get(src) ?? 0;
    remaining.set(src, limit === Infinity ? Infinity : Math.max(0, limit - used));
  }
  return remaining;
}

// Candidate lists come out of buildFetchTargets in a stable order (alphabetical, per
// ticker_registry's orderBy). Budget-capped sources (fmp, alpha_vantage) only ever get
// through the first `maxTickers` — prefer today's cohort so the full universe rotates
// every COHORT_MODULUS days, then fill remaining slots from the rest (shuffled).
export function shuffled<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Earnings-window first, then cohort-due, then the rest. */
export function prioritizeQueue(tickers: string[], earningsWindowTickers: Set<string>): string[] {
  const earn = shuffled(tickers.filter((t) => earningsWindowTickers.has(t)));
  const due = shuffled(tickers.filter((t) => !earningsWindowTickers.has(t) && isCohortDueToday(t)));
  const rest = shuffled(tickers.filter((t) => !earningsWindowTickers.has(t) && !isCohortDueToday(t)));
  return [...earn, ...due, ...rest];
}

// ── Coverage snapshot ────────────────────────────────────────────────────────
// Same % calc as GET /api/admin/data-health: non-null field cells over active
// tickers × FIELD_DEFS columns (excluding the synthetic "grossProfit" alias).

const VALID_FIELD_DEFS = FIELD_DEFS;

export async function computeCoveragePercent(): Promise<number> {
  const [regRows, tfRows] = await Promise.all([
    db.select({ ticker: tickerRegistry.ticker }).from(tickerRegistry).where(eq(tickerRegistry.fetchFundamentals, true)),
    db.select().from(tickerFundamentals),
  ]);
  const activeSet = new Set(regRows.map(r => r.ticker));
  const tfMap = new Map(tfRows.map(r => [r.ticker, r]));
  const totalCells = activeSet.size * VALID_FIELD_DEFS.length;
  if (totalCells === 0) return 0;
  let nonNull = 0;
  for (const ticker of activeSet) {
    const row = tfMap.get(ticker) as Record<string, unknown> | undefined;
    for (const { tfCol } of VALID_FIELD_DEFS) {
      if (row && row[tfCol as string] != null) nonNull++;
    }
  }
  return Math.round((nonNull / totalCells) * 1000) / 10; // one decimal place
}

// ── Peer-group backfill ──────────────────────────────────────────────────────

// Any ticker in the scoring universe (ticker_fundamentals) whose registry row has no
// primary_peer_group_id gets run through the normal 3-tier auto-classifier
// (peer overlap → sector/industry keyword map → unmapped). Persisting is exactly what
// classifyTicker does for a never-seen ticker; this just stops it being lazy.
export async function classifyUngroupedTickers(): Promise<void> {
  try {
    const ungrouped = (await db
      .select({ ticker: tickerRegistry.ticker })
      .from(tickerRegistry)
      .where(and(eq(tickerRegistry.fetchFundamentals, true), isNull(tickerRegistry.primaryPeerGroupId))))
      .map(r => r.ticker)
      .filter(t => !isExcludedEtf(t));

    if (ungrouped.length === 0) return;
    log(`peer-group backfill: ${ungrouped.length} fetch_fundamentals ticker(s) with no peer group`);

    let mapped = 0;
    for (const ticker of ungrouped) {
      try {
        const res = await classifyTicker(ticker);
        if (res.groupId && res.groupId !== "__global__" && res.confidence !== "unmapped") {
          mapped++;
          log(`  ${ticker} → ${res.groupId} (${res.confidence})`);
        } else {
          log(`  ${ticker} → still unmapped (needs a manual peer-group override)`);
        }
      } catch (err: any) {
        log(`  WARN: ${ticker} classify failed: ${err?.message ?? String(err)}`);
      }
    }
    log(`peer-group backfill: ${mapped}/${ungrouped.length} newly mapped`);
  } catch (err: any) {
    log(`WARN: peer-group backfill failed: ${err?.message ?? String(err)}`);
  }
}

// ── Run accountability ───────────────────────────────────────────────────────
// Writes one enrichment_runs row per invocation so run history is queryable
// instead of living only in the per-day log file. Never throws — a failure to
// record history must not mask (or replace) the actual enrichment outcome.

export type SourceTotals = { fetched: number; skippedBudget: number; failed: number; nodata: number };

export async function detectNodataAnomaly(perSource: Record<string, SourceTotals>): Promise<string | null> {
  const recent = await db.select({ perSource: enrichmentRuns.perSource })
    .from(enrichmentRuns)
    .where(eq(enrichmentRuns.status, "success"))
    .orderBy(sql`${enrichmentRuns.startedAt} desc`)
    .limit(5);

  for (const [source, totals] of Object.entries(perSource)) {
    const attempted = totals.fetched + totals.nodata + totals.failed;
    if (attempted < 5) continue; // too small a sample to judge

    const nodataRate = totals.nodata / attempted;
    const baselineRates: number[] = [];
    for (const row of recent) {
      const prior = (row.perSource as Record<string, SourceTotals> | null)?.[source];
      if (!prior) continue;
      const priorAttempted = prior.fetched + prior.nodata + prior.failed;
      if (priorAttempted >= 5) baselineRates.push(prior.nodata / priorAttempted);
    }
    if (baselineRates.length === 0) continue;

    const baseline = baselineRates.reduce((a, b) => a + b, 0) / baselineRates.length;
    // Flag only a real jump, not a source that's always nodata-heavy
    if (nodataRate > 0.5 && nodataRate > baseline * 2) {
      return `${source}: nodata rate ${(nodataRate * 100).toFixed(0)}% vs baseline ${(baseline * 100).toFixed(0)}%`;
    }
  }
  return null;
}

export async function recordRun(row: {
  startedAt: Date;
  status: "success" | "partial" | "failed";
  trigger: "scheduled" | "manual" | "maintain" | "maintain_full";
  perSource?: Record<string, SourceTotals>;
  coverageBefore: number | null;
  coverageAfter: number | null;
  error?: string;
}): Promise<void> {
  try {
    await db.insert(enrichmentRuns).values({
      startedAt:      row.startedAt,
      finishedAt:     new Date(),
      status:         row.status,
      trigger:        row.trigger,
      perSource:      row.perSource ?? {},
      coverageBefore: row.coverageBefore != null ? String(row.coverageBefore) : null,
      coverageAfter:  row.coverageAfter  != null ? String(row.coverageAfter)  : null,
      error:          row.error ?? null,
    });
  } catch (err: any) {
    log(`WARN: failed to record enrichment_runs row: ${err?.message}`);
  }
}
