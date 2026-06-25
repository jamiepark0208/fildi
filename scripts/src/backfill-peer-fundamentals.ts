/**
 * backfill-peer-fundamentals.ts
 *
 * Fetches FMP fundamentals for:
 *   - All watchlist tickers
 *   - All peer group members of each watchlist ticker's primary_peer_group_id
 *
 * Skips tickers with complete, fresh data (< 7 days + all required columns set).
 * Respects FMP daily budget. Run once manually — NOT triggered on startup.
 *
 * Usage: pnpm --filter @workspace/scripts backfill:peers
 */

import {
  db,
  tickerFundamentals,
  tickerRegistry,
  peerGroupMembers,
  fmpApiUsage,
  type TickerFundamentalsRow,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

// ── Constants ─────────────────────────────────────────────────────────────────

const WATCHLIST = [
  "NVDA","INTC","MRVL","PLTR","HOOD","RDDT","AAPL","AMZN","GOOGL","TSLA","NOW",
  "BABA","SMCI","SNOW","AAOI","NFLX","NET","OPEN","ONDS","POET","SHOP","FSLY","RUM",
  "JOBY","ACHR","BB","IONQ","SOFI","TTD","RKLB","RDW",
];

// Columns that must be non-null for a row to be considered "complete"
const REQUIRED_COLS: (keyof TickerFundamentalsRow)[] = [
  "forwardPe","evEbitda","evRevenue","revenueGrowthYoyPrior",
  "freeCashFlow","priceToBook","dividendYield","ebitda","wacc",
];

const STALE_DAYS       = 7;
const BATCH_SIZE       = 5;
const CALLS_PER_TICKER = 9;   // 9 FMP endpoints per full fetch
const MAX_DAILY_CALLS  = 220; // conservative free-tier budget
const INTER_BATCH_MS   = 2000;
const FMP_BASE         = "https://financialmodelingprep.com/stable";

// ── FMP helpers (self-contained — no pino) ────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function fmpN(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

function firstOf(arr: unknown): Record<string, unknown> {
  return (Array.isArray(arr) && arr.length > 0 ? arr[0] : {}) as Record<string, unknown>;
}

function secondOf(arr: unknown): Record<string, unknown> {
  return (Array.isArray(arr) && arr.length > 1 ? arr[1] : {}) as Record<string, unknown>;
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try { res = await fetch(url); } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(delay); delay *= 2; continue;
    }
    if (res.status === 429) {
      console.warn(`  rate-limited (attempt ${attempt + 1}), backing off ${delay}ms`);
      if (attempt === maxRetries) throw new Error("FMP rate limit exceeded after retries");
      await sleep(delay); delay *= 2; continue;
    }
    if (!res.ok) {
      if (attempt === maxRetries) throw new Error(`FMP HTTP ${res.status}`);
      await sleep(delay); delay *= 2; continue;
    }
    return res.json();
  }
}

interface FMPData {
  peRatio?: number; pegRatio?: number; forwardPe?: number; evEbitda?: number;
  evRevenue?: number; priceToBook?: number; priceToSales?: number; debtToEquity?: number;
  dividendYield?: number; analystTargetPrice?: number; revenueGrowthYoY?: number;
  revenueGrowthYoyPrior?: number; epsGrowth?: number; earningsPerShare?: number;
  grossMargin?: number; operatingMargin?: number; netMargin?: number;
  returnOnEquity?: number; returnOnAssets?: number; effectiveTaxRate?: number;
  totalRevenue?: number; netIncome?: number; ebitda?: number; freeCashFlow?: number;
  ebit?: number; interestExpense?: number; currentRatio?: number; wacc?: number;
  roic?: number; totalDebt?: number; totalStockholdersEquity?: number;
  cashAndEquivalents?: number; quarterlyOperatingCashFlow?: number;
  sharesOutstanding?: number; sharesOutstandingPrior?: number;
}

async function fetchFMPData(ticker: string, apiKey: string): Promise<FMPData> {
  const q = `symbol=${ticker.toUpperCase()}&apikey=${apiKey}`;
  const [kmRaw, ratiosRaw, incomeRaw, balanceRaw, targetRaw, cfQtrRaw, growthRaw, waccRaw, cfAnnRaw] =
    await Promise.all([
      fetchWithRetry(`${FMP_BASE}/key-metrics?${q}&limit=1`),
      fetchWithRetry(`${FMP_BASE}/ratios?${q}&limit=1`),
      fetchWithRetry(`${FMP_BASE}/income-statement?${q}&limit=2`),
      fetchWithRetry(`${FMP_BASE}/balance-sheet-statement?${q}&limit=2`),
      fetchWithRetry(`${FMP_BASE}/price-target-consensus?${q}`).catch(() => null),
      fetchWithRetry(`${FMP_BASE}/cash-flow-statement?${q}&period=quarter&limit=2`),
      fetchWithRetry(`${FMP_BASE}/financial-growth?${q}&limit=2`),
      fetchWithRetry(`${FMP_BASE}/wacc?${q}&limit=1`).catch(() => null),
      fetchWithRetry(`${FMP_BASE}/cash-flow-statement?${q}&limit=1`),
    ]);

  const km = firstOf(kmRaw), r = firstOf(ratiosRaw), waccRow = firstOf(waccRaw);
  const is0 = firstOf(incomeRaw), is1 = secondOf(incomeRaw);
  const bs = firstOf(balanceRaw), cfAnn = firstOf(cfAnnRaw), cfQ = firstOf(cfQtrRaw);
  const growth = firstOf(growthRaw), growth1 = secondOf(growthRaw);
  const tgt = (targetRaw && !Array.isArray(targetRaw))
    ? targetRaw as Record<string, unknown> : firstOf(targetRaw);

  const raw = fmpN(is0.interestExpense);
  return {
    peRatio:               fmpN(r.priceToEarningsRatio),
    pegRatio:              fmpN(r.priceToEarningsGrowthRatio),
    forwardPe:             fmpN(km.forwardPE),
    evEbitda:              fmpN(km.enterpriseValueOverEBITDA),
    evRevenue:             fmpN(km.evToRevenue),
    priceToBook:           fmpN(r.priceToBookRatio),
    priceToSales:          fmpN(r.priceToSalesRatio),
    debtToEquity:          fmpN(r.debtToEquityRatio),
    dividendYield:         fmpN(r.dividendYield),
    analystTargetPrice:    fmpN(tgt.targetConsensus),
    revenueGrowthYoY:      fmpN(growth.revenueGrowth),
    revenueGrowthYoyPrior: fmpN(growth1.revenueGrowth),
    epsGrowth:             fmpN(growth.epsgrowth),
    earningsPerShare:      fmpN(is0.eps),
    grossMargin:           fmpN(r.grossProfitMargin),
    operatingMargin:       fmpN(r.operatingProfitMargin),
    netMargin:             fmpN(r.netProfitMargin),
    returnOnEquity:        fmpN(r.returnOnEquity) ?? fmpN(km.returnOnEquity),
    returnOnAssets:        fmpN(r.returnOnAssets),
    effectiveTaxRate:      fmpN(r.effectiveTaxRate),
    totalRevenue:          fmpN(is0.revenue),
    netIncome:             fmpN(is0.netIncome),
    ebitda:                fmpN(is0.ebitda),
    ebit:                  fmpN(is0.ebit) ?? fmpN(is0.operatingIncome),
    interestExpense:       raw !== undefined ? Math.abs(raw) : undefined,
    sharesOutstanding:     fmpN(is0.weightedAverageShsOut),
    sharesOutstandingPrior:fmpN(is1.weightedAverageShsOut),
    currentRatio:          fmpN(r.currentRatio) ?? fmpN(km.currentRatio),
    wacc:                  fmpN(waccRow.wacc),
    roic:                  fmpN(km.returnOnInvestedCapital),
    totalDebt:             fmpN(bs.totalDebt),
    totalStockholdersEquity: fmpN(bs.totalStockholdersEquity),
    cashAndEquivalents:    fmpN(bs.cashAndCashEquivalents),
    quarterlyOperatingCashFlow: fmpN(cfQ.operatingCashFlow),
    freeCashFlow:          fmpN(cfAnn.freeCashFlow),
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function n(v: number | undefined): string | null { return v !== undefined ? String(v) : null; }

async function writeRow(ticker: string, data: FMPData): Promise<void> {
  const vals = {
    ticker:                     ticker.toUpperCase(),
    fundamentalsLastFetched:    new Date(),
    peRatio:                    n(data.peRatio),
    pegRatio:                   n(data.pegRatio),
    forwardPe:                  n(data.forwardPe),
    evEbitda:                   n(data.evEbitda),
    evRevenue:                  n(data.evRevenue),
    priceToBook:                n(data.priceToBook),
    priceToSales:               n(data.priceToSales),
    debtToEquity:               n(data.debtToEquity),
    totalRevenue:               n(data.totalRevenue),
    revenueGrowthYoY:           n(data.revenueGrowthYoY),
    revenueGrowthYoyPrior:      n(data.revenueGrowthYoyPrior),
    netIncome:                  n(data.netIncome),
    ebitda:                     n(data.ebitda),
    earningsPerShare:           n(data.earningsPerShare),
    epsGrowth:                  n(data.epsGrowth),
    freeCashFlow:               n(data.freeCashFlow),
    dividendYield:              n(data.dividendYield),
    returnOnEquity:             n(data.returnOnEquity),
    returnOnAssets:             n(data.returnOnAssets),
    currentRatio:               n(data.currentRatio),
    grossMargin:                n(data.grossMargin),
    operatingMargin:            n(data.operatingMargin),
    netMargin:                  n(data.netMargin),
    analystTargetPrice:         n(data.analystTargetPrice),
    wacc:                       n(data.wacc),
    roic:                       n(data.roic),
    interestExpense:            n(data.interestExpense),
    totalDebt:                  n(data.totalDebt),
    totalStockholdersEquity:    n(data.totalStockholdersEquity),
    ebit:                       n(data.ebit),
    effectiveTaxRate:           n(data.effectiveTaxRate),
    cashAndEquivalents:         n(data.cashAndEquivalents),
    quarterlyOperatingCashFlow: n(data.quarterlyOperatingCashFlow),
    sharesOutstanding:          n(data.sharesOutstanding),
    sharesOutstandingPrior:     n(data.sharesOutstandingPrior),
  };
  await db.insert(tickerFundamentals).values(vals)
    .onConflictDoUpdate({ target: tickerFundamentals.ticker, set: { ...vals } });
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function checkBudget(additional: number): Promise<{ allowed: boolean; remaining: number; callsToday: number }> {
  const today = todayISO();
  const rows = await db.select().from(fmpApiUsage).where(eq(fmpApiUsage.id, 1)).limit(1);
  const callsToday = (!rows[0] || rows[0].resetDate !== today) ? 0 : rows[0].callsToday;
  return { allowed: callsToday + additional <= MAX_DAILY_CALLS, callsToday, remaining: MAX_DAILY_CALLS - callsToday };
}

async function recordCalls(calls: number): Promise<void> {
  const today = todayISO();
  const rows = await db.select().from(fmpApiUsage).where(eq(fmpApiUsage.id, 1)).limit(1);
  const existing = rows[0];
  if (!existing || existing.resetDate !== today) {
    await db.insert(fmpApiUsage).values({ id: 1, callsToday: calls, resetDate: today })
      .onConflictDoUpdate({ target: fmpApiUsage.id, set: { callsToday: calls, resetDate: today } });
  } else {
    await db.update(fmpApiUsage).set({ callsToday: existing.callsToday + calls }).where(eq(fmpApiUsage.id, 1));
  }
}

// ── Ticker classification ─────────────────────────────────────────────────────

function isStale(row: TickerFundamentalsRow): boolean {
  if (!row.fundamentalsLastFetched) return true;
  return Date.now() - new Date(row.fundamentalsLastFetched).getTime() > STALE_DAYS * 86_400_000;
}

function missingCols(row: TickerFundamentalsRow): string[] {
  return REQUIRED_COLS.filter(c => row[c] == null);
}

type Plan =
  | { action: "skip";  label: string }
  | { action: "full";  label: string }
  | { action: "patch"; label: string; missing: string[] };

async function classify(ticker: string): Promise<Plan> {
  const rows = await db.select().from(tickerFundamentals)
    .where(eq(tickerFundamentals.ticker, ticker)).limit(1);
  const row = rows[0] ?? null;
  if (!row)          return { action: "full",  label: "no row" };
  if (isStale(row))  return { action: "full",  label: "stale" };
  const missing = missingCols(row);
  if (missing.length) return { action: "patch", label: "missing fields", missing };
  return { action: "skip", label: "fresh" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env["FMP_API_KEY"];
  if (!apiKey) { console.error("FMP_API_KEY not set — aborting"); process.exit(1); }

  // ── 1. Build deduplicated ticker universe ──────────────────────────────────
  console.log("▶ Building ticker universe (watchlist + peer members)…");
  const upper = WATCHLIST.map(t => t.toUpperCase());

  const regRows = await db
    .select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, upper));

  const groupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];

  const memberRows = groupIds.length > 0
    ? await db.select({ ticker: peerGroupMembers.ticker }).from(peerGroupMembers)
        .where(inArray(peerGroupMembers.groupId, groupIds))
    : [];

  const universe = [...new Set([...upper, ...memberRows.map(r => r.ticker.toUpperCase())])].sort();
  console.log(`  ${upper.length} watchlist  +  ${memberRows.length} peer members  →  ${universe.length} unique tickers\n`);

  // ── 2. Classify each ticker ────────────────────────────────────────────────
  console.log("▶ Classifying tickers…");
  const plans: Array<{ ticker: string; plan: Plan }> = [];
  for (const ticker of universe) {
    plans.push({ ticker, plan: await classify(ticker) });
  }

  const toFetch = plans.filter(p => p.plan.action !== "skip");
  const skipped = plans.filter(p => p.plan.action === "skip");
  console.log(`  ${skipped.length} fresh (skip)  |  ${toFetch.length} need fetch\n`);

  if (toFetch.length === 0) { console.log("✓ All tickers fresh — nothing to do."); return; }

  // ── 3. Budget check ────────────────────────────────────────────────────────
  const budget = await checkBudget(toFetch.length * CALLS_PER_TICKER);
  console.log(`▶ FMP budget: ${budget.callsToday} used today / ${MAX_DAILY_CALLS} max  (${budget.remaining} remaining)`);
  if (!budget.allowed) {
    console.warn(`  ⚠ Need ${toFetch.length * CALLS_PER_TICKER} calls but only ${budget.remaining} remain. Run again tomorrow.`);
    process.exit(0);
  }
  console.log();

  // ── 4. Process in batches ──────────────────────────────────────────────────
  let fetched = 0, errors = 0, callsUsed = 0;

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);

    // Re-check budget before each batch
    const mid = await checkBudget(batch.length * CALLS_PER_TICKER);
    if (!mid.allowed) {
      console.warn(`\n⚠ Budget exhausted mid-run (${mid.remaining} remaining). Stopping.`);
      break;
    }

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const total    = Math.ceil(toFetch.length / BATCH_SIZE);
    console.log(`── Batch ${batchNum}/${total} (tickers ${i + 1}–${Math.min(i + BATCH_SIZE, toFetch.length)}) ──`);

    await Promise.allSettled(
      batch.map(async ({ ticker, plan }) => {
        try {
          const data = await fetchFMPData(ticker, apiKey);
          await writeRow(ticker, data);
          await recordCalls(CALLS_PER_TICKER);
          callsUsed += CALLS_PER_TICKER;
          fetched++;
          const detail = plan.action === "patch" ? `patched (${plan.missing.join(",")})` : `fetched (${plan.label})`;
          console.log(`  ✓ ${ticker}: ${detail}`);
        } catch (err: any) {
          errors++;
          console.error(`  ✗ ${ticker}: error — ${err?.message ?? err}`);
        }
      })
    );

    if (i + BATCH_SIZE < toFetch.length) await sleep(INTER_BATCH_MS);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Tickers evaluated : ${universe.length}
  Skipped (fresh)   : ${skipped.length}
  Fetched / patched : ${fetched}
  Errors            : ${errors}
  FMP calls used    : ${callsUsed}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
