/**
 * Backfill fundamental data for all watchlist + peer group tickers.
 *
 * Logic:
 *   - Distinct tickers from watchlist + peer_group_members
 *   - Skip tickers whose DB row is fresh AND has zero null CRITICAL fields
 *   - Waterfall per source: Polygon → Alpha Vantage → FMP
 *   - Polygon/AV merge into existing row (patchFundamentals); FMP does full upsert
 *   - checkFMPBudget() before every FMP call; stop FMP batch when budget exhausted
 *   - Max 3 concurrent per batch, batch size 5
 *   - Log per data-agent.md format
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/backfill-fundamentals.ts
 * Do NOT run automatically — invoke manually after FMP daily limit resets (midnight UTC).
 */

import fs from "node:fs";
import path from "node:path";
import { eq, isNull, or, inArray } from "drizzle-orm";
import {
  db,
  tickerRegistry,
  peerGroupMembers,
  tickerFundamentals,
  sourceTickerMap,
  type TickerFundamentalsRow,
} from "@workspace/db";
import { WATCHLIST } from "../lib/constants.js";
import { fetchFMPFundamentals, type FMPFundamentalsData } from "../lib/fmp-client.js";
import { fetchAVOverview } from "../lib/alpha-vantage-client.js";
import { fetchPolygonFundamentals } from "../lib/polygon-client.js";
import {
  checkFMPBudget,
  recordFMPCalls,
  writeFundamentalsRow,
} from "../lib/fundamentals-db.js";
import { logger } from "../lib/logger.js";

// ── Config ────────────────────────────────────────────────────────────────────

const BATCH_SIZE      = 5;
const MAX_CONCURRENT  = 1;   // Polygon is 5/min; 1 concurrent + 13s sleep = ~4.6/min
const STALE_DAYS      = 7;
const CALLS_PER_TICKER_FMP = 7; // fmp-client makes ~7 endpoints per ticker

const AV_KEY   = process.env.ALPHA_VANTAGE_API_KEY ?? "";
const POLY_KEY = process.env.POLYGON_API_KEY ?? "";
const FMP_KEY  = process.env.FMP_API_KEY ?? "";

// ── Null-field definitions (data-agent.md CRITICAL + IMPORTANT) ───────────────

const CRITICAL_FIELDS: (keyof TickerFundamentalsRow)[] = [
  "grossMargin", "netMargin", "operatingMargin", "totalRevenue",
  "netIncome", "freeCashFlow", "ebitda", "ebit", "totalDebt",
  "cashAndEquivalents", "returnOnEquity", "revenueGrowthYoY",
];

const IMPORTANT_FIELDS: (keyof TickerFundamentalsRow)[] = [
  "forwardPe", "evEbitda", "evRevenue", "priceToBook", "dividendYield",
  "wacc", "revenueGrowthYoyPrior", "epsGrowth",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isFresh(row: TickerFundamentalsRow): boolean {
  if (!row.fundamentalsLastFetched) return false;
  return Date.now() - new Date(row.fundamentalsLastFetched).getTime() < STALE_DAYS * 86_400_000;
}

function nullCriticalCount(row: TickerFundamentalsRow): number {
  return CRITICAL_FIELDS.filter(f => row[f] == null).length;
}

function nullImportantCount(row: TickerFundamentalsRow): number {
  return IMPORTANT_FIELDS.filter(f => row[f] == null).length;
}

// Merge partial data on top of an existing DB row, preserving non-null incumbents.
function mergeIntoRow(
  existing: FMPFundamentalsData,
  partial: Partial<FMPFundamentalsData>,
): FMPFundamentalsData {
  const merged: FMPFundamentalsData = { ...existing };
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined && (merged as Record<string, unknown>)[k] === undefined) {
      (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}

// Convert a DB row back to FMPFundamentalsData (string columns → number).
function rowToFMPData(row: TickerFundamentalsRow): FMPFundamentalsData {
  const numericKeys: (keyof FMPFundamentalsData)[] = [
    "peRatio","pegRatio","forwardPe","evEbitda","evRevenue","priceToBook","priceToSales",
    "debtToEquity","dividendYield","analystTargetPrice","revenueGrowthYoY","revenueGrowthYoyPrior",
    "epsGrowth","earningsPerShare","grossMargin","operatingMargin","netMargin","returnOnEquity",
    "returnOnAssets","effectiveTaxRate","totalRevenue","netIncome","ebitda","freeCashFlow",
    "ebit","interestExpense","currentRatio","wacc","roic","totalDebt","totalStockholdersEquity",
    "cashAndEquivalents","quarterlyOperatingCashFlow","sharesOutstanding","sharesOutstandingPrior","beta",
  ];
  const result: FMPFundamentalsData = {};
  const r = row as Record<string, unknown>;
  for (const k of numericKeys) {
    const v = r[k];
    if (v !== null && v !== undefined) {
      const n = Number(v);
      if (isFinite(n)) (result as Record<string, number>)[k] = n;
    }
  }
  return result;
}

async function upsertSourceMap(ticker: string, source: string, worked: boolean, notes?: string): Promise<void> {
  await db
    .insert(sourceTickerMap)
    .values({ ticker, source, sourceTicker: ticker, active: worked, notes: notes ?? null })
    .onConflictDoUpdate({
      target: [sourceTickerMap.ticker, sourceTickerMap.source],
      set: { active: worked, notes: notes ?? null },
    })
    .catch(() => {}); // non-fatal
}

// ── Ticker collection ─────────────────────────────────────────────────────────

// Mirror the /fundamentals/stock-db route: WATCHLIST constant → tickerRegistry peer groups → peerGroupMembers.
async function getAllTargetTickers(): Promise<string[]> {
  const upper = WATCHLIST.map((t: string) => t.toUpperCase());

  const regRows = await db
    .select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, upper));

  const groupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];

  const memberRows = groupIds.length > 0
    ? await db.select({ ticker: peerGroupMembers.ticker })
        .from(peerGroupMembers)
        .where(inArray(peerGroupMembers.groupId, groupIds))
    : [];

  const all = [...upper, ...memberRows.map(r => r.ticker.toUpperCase())];
  return [...new Set(all)].sort();
}

// ── Work queue builder ────────────────────────────────────────────────────────

interface WorkItem {
  ticker: string;
  existingRow: TickerFundamentalsRow | null;
  nullCritical: number;
  nullImportant: number;
}

async function buildWorkQueue(tickers: string[]): Promise<WorkItem[]> {
  const rows = await db.select().from(tickerFundamentals);
  const rowMap = new Map(rows.map(r => [r.ticker.toUpperCase(), r]));

  const work: WorkItem[] = [];
  let skipped = 0;

  for (const ticker of tickers) {
    const existing = rowMap.get(ticker) ?? null;

    if (existing && isFresh(existing) && nullCriticalCount(existing) === 0) {
      skipped++;
      continue; // fresh + complete → skip
    }

    const nullCritical  = existing ? nullCriticalCount(existing)  : CRITICAL_FIELDS.length;
    const nullImportant = existing ? nullImportantCount(existing) : IMPORTANT_FIELDS.length;
    work.push({ ticker, existingRow: existing, nullCritical, nullImportant });
  }

  // Prioritize: no row first, then most null critical fields
  work.sort((a, b) => {
    if (a.existingRow === null && b.existingRow !== null) return -1;
    if (a.existingRow !== null && b.existingRow === null) return 1;
    return b.nullCritical - a.nullCritical;
  });

  console.log(`[${ts()}] Work queue: ${work.length} tickers need backfill, ${skipped} skipped (fresh+complete)`);
  return work;
}

// ── Per-ticker backfill ───────────────────────────────────────────────────────

interface FillResult {
  ticker: string;
  filled: number;     // fields newly filled this run
  sources: string[];  // sources that contributed data
  error?: string;
}

async function backfillTicker(item: WorkItem, fmpAllowed: boolean): Promise<FillResult> {
  const { ticker, existingRow } = item;
  let base = existingRow ? rowToFMPData(existingRow) : {};
  const sources: string[] = [];
  let initialNulls = item.nullCritical + item.nullImportant;

  // ── Polygon ──────────────────────────────────────────────────────────────
  if (POLY_KEY) {
    try {
      const partial = await fetchPolygonFundamentals(ticker, POLY_KEY);
      const count = Object.values(partial).filter(v => v !== undefined).length;
      await upsertSourceMap(ticker, "polygon", count > 0);
      if (count > 0) {
        base = mergeIntoRow(base, partial);
        sources.push(`polygon(${count})`);
      }
    } catch (err) {
      await upsertSourceMap(ticker, "polygon", false, String(err));
      logger.debug({ ticker }, "backfill: polygon failed");
    }
    await sleep(13000); // 13s + MAX_CONCURRENT=1 keeps under 5/min (4.6 calls/min)
  }

  // ── Alpha Vantage ─────────────────────────────────────────────────────────
  if (AV_KEY) {
    try {
      const partial = await fetchAVOverview(ticker, AV_KEY);
      const count = Object.values(partial).filter(v => v !== undefined).length;
      await upsertSourceMap(ticker, "alpha_vantage", count > 0);
      if (count > 0) {
        base = mergeIntoRow(base, partial);
        sources.push(`av(${count})`);
      }
    } catch (err) {
      await upsertSourceMap(ticker, "alpha_vantage", false, String(err));
      logger.debug({ ticker }, "backfill: alpha_vantage failed");
    }
    await sleep(1200); // AV free tier: 1 req/sec
  }

  // ── FMP (budget-gated) ────────────────────────────────────────────────────
  if (FMP_KEY && fmpAllowed) {
    try {
      const fmpData = await fetchFMPFundamentals(ticker, FMP_KEY);
      await recordFMPCalls(CALLS_PER_TICKER_FMP);
      base = mergeIntoRow(base, fmpData);
      sources.push("fmp");
    } catch (err) {
      logger.debug({ ticker }, "backfill: fmp failed");
    }
  }

  // ── Persist merged result ─────────────────────────────────────────────────
  if (sources.length > 0) {
    try {
      await writeFundamentalsRow(ticker, base, [], null);
    } catch (err) {
      return { ticker, filled: 0, sources, error: `persist failed: ${String(err)}` };
    }
  }

  // Count newly filled fields
  const newNullCritical  = CRITICAL_FIELDS.filter(f => (base as Record<string, unknown>)[f] === undefined).length;
  const newNullImportant = IMPORTANT_FIELDS.filter(f => (base as Record<string, unknown>)[f] === undefined).length;
  const filled = initialNulls - (newNullCritical + newNullImportant);

  return { ticker, filled: Math.max(0, filled), sources };
}

// ── Batch runner ──────────────────────────────────────────────────────────────

async function runBatch(items: WorkItem[], fmpAllowed: boolean): Promise<FillResult[]> {
  const results: FillResult[] = [];
  // Max 3 concurrent within the batch
  for (let i = 0; i < items.length; i += MAX_CONCURRENT) {
    const chunk = items.slice(i, i + MAX_CONCURRENT);
    const chunkResults = await Promise.all(chunk.map(item => backfillTicker(item, fmpAllowed)));
    results.push(...chunkResults);
  }
  return results;
}

// ── Logging ───────────────────────────────────────────────────────────────────

function writeLog(lines: string[]): void {
  const today = new Date().toISOString().slice(0, 10);
  const logDir = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `data-agent-${today}.log`);
  fs.appendFileSync(logFile, lines.join("\n") + "\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[${ts()}] backfill-fundamentals starting`);

  const allTickers = await getAllTargetTickers();
  console.log(`[${ts()}] ${allTickers.length} distinct tickers (watchlist + peer groups)`);

  const workQueue = await buildWorkQueue(allTickers);
  if (workQueue.length === 0) {
    console.log(`[${ts()}] Nothing to do — all tickers fresh and complete.`);
    return;
  }

  // Check FMP budget once up front
  const budget = await checkFMPBudget(0);
  const fmpAvailableTotal = budget.remaining;
  console.log(`[${ts()}] FMP budget: ${budget.remaining} calls remaining (${budget.callsToday} used today)`);

  let totalFilled = 0;
  let totalStillNull = 0;
  let fmpUsedTotal = 0;
  const sourceCount: Record<string, number> = { polygon: 0, alpha_vantage: 0, fmp: 0 };
  const allErrors: string[] = [];
  const unfillable: string[] = []; // tickers where every source returned zero data

  // Process in batches of BATCH_SIZE
  for (let batchStart = 0; batchStart < workQueue.length; batchStart += BATCH_SIZE) {
    const batch = workQueue.slice(batchStart, batchStart + BATCH_SIZE);
    const batchTickers = batch.map(b => b.ticker);

    // Re-check FMP budget before each batch
    const batchBudget = await checkFMPBudget(batch.length * CALLS_PER_TICKER_FMP);
    const fmpAllowed = batchBudget.allowed && FMP_KEY.length > 0;

    if (!fmpAllowed && FMP_KEY) {
      console.log(`[${ts()}] FMP budget exhausted (${batchBudget.remaining} remaining) — continuing with Polygon + AV only`);
    }

    console.log(`[${ts()}] Batch ${Math.floor(batchStart / BATCH_SIZE) + 1}: [${batchTickers.join(",")}] fmp=${fmpAllowed}`);

    const results = await runBatch(batch, fmpAllowed);

    // Tally batch results
    let batchFilled = 0;
    let batchNull = 0;
    const batchSourceCount: Record<string, number> = { polygon: 0, alpha_vantage: 0, fmp: 0 };

    for (const r of results) {
      totalFilled += r.filled;
      batchFilled += r.filled;
      if (r.error) allErrors.push(`${r.ticker}: ${r.error}`);
      if (r.filled === 0 && r.sources.length === 0) {
        totalStillNull++;
        batchNull++;
        unfillable.push(r.ticker);
      }

      for (const s of r.sources) {
        if (s.startsWith("polygon")) { sourceCount["polygon"]!++; batchSourceCount["polygon"]!++; }
        else if (s.startsWith("av")) { sourceCount["alpha_vantage"]!++; batchSourceCount["alpha_vantage"]!++; }
        else if (s === "fmp")        { sourceCount["fmp"]!++; batchSourceCount["fmp"]!++; fmpUsedTotal += CALLS_PER_TICKER_FMP; }
      }

      const status = r.error ? `ERROR:${r.error}` : `filled:${r.filled} sources:[${r.sources.join(",")}]`;
      console.log(`  [${ts()}] ${r.ticker} ${status}`);
    }

    // Write per-batch log line (data-agent.md format)
    const batchLine = `[${ts()}] BATCH ${batchTickers.join(",")} | filled:${batchFilled} | null:${batchNull} | sources:polygon(${batchSourceCount["polygon"]}) alpha_vantage(${batchSourceCount["alpha_vantage"]}) fmp(${batchSourceCount["fmp"]}) | fmp_remaining:${batchBudget.remaining - (fmpAllowed ? batch.length * CALLS_PER_TICKER_FMP : 0)}`;
    console.log(batchLine);
    writeLog([batchLine]);

    // Brief pause between batches to respect rate limits
    if (batchStart + BATCH_SIZE < workQueue.length) {
      await sleep(2000);
    }
  }

  // ── Session summary ───────────────────────────────────────────────────────
  const topNullFields = await getTopNullFields(allTickers);

  const summaryLines = [
    `[${ts()}] SESSION COMPLETE | tickers:${workQueue.length} | filled:${totalFilled} | still_null:${totalStillNull} | fmp_used:${fmpUsedTotal}`,
    `         top_null_fields:[${topNullFields.join(",")}] | unfillable:[${unfillable.join(",")}]`,
  ];

  console.log(`\n${summaryLines.join("\n")}`);
  writeLog(summaryLines);
}

async function getTopNullFields(tickers: string[]): Promise<string[]> {
  const rows = await db.select().from(tickerFundamentals);
  const target = new Set(tickers);
  const nullCounts: Record<string, number> = {};

  for (const row of rows) {
    if (!target.has(row.ticker.toUpperCase())) continue;
    for (const f of [...CRITICAL_FIELDS, ...IMPORTANT_FIELDS]) {
      if (row[f] == null) nullCounts[f] = (nullCounts[f] ?? 0) + 1;
    }
  }

  return Object.entries(nullCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f, n]) => `${f}(${n})`);
}

main().catch(err => {
  console.error("backfill failed:", err);
  process.exit(1);
});
