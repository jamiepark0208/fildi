/**
 * Gap-targeted FMP backfill for the canonical 256-ticker universe.
 *
 * fetchFMPFundamentals bundles all 9 FMP endpoints per call (no way to call
 * individual endpoints selectively), so the skip unit is per-ticker, not
 * per-endpoint.
 *
 * Skip logic:
 *   - Row was fetched within the last 7 days AND has real data (peRatio or netIncome
 *     non-null, i.e. not a placeholder empty row) → already backfilled, skip.
 *
 * Budget: 9 calls per ticker. checkFMPBudget / recordFMPCalls from fundamentals-db.
 *
 * Run: cd artifacts/api-server && npx tsx src/scripts/backfill-fmp.ts
 * Dry run: npx tsx src/scripts/backfill-fmp.ts --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { sql, lt, and, isNotNull, eq } from "drizzle-orm";
import { db, fmpFundamentals, tickerRegistry } from "@workspace/db";
import { fetchFMPFundamentals } from "../lib/fmp-client.js";
import { checkFMPBudget, recordFMPCalls } from "../lib/fundamentals-db.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const FMP_API_KEY = process.env.FMP_API_KEY ?? "";

const CALLS_PER_TICKER = 9; // fetchFMPFundamentals fires 9 endpoints in parallel
const STALE_DAYS = 7;       // re-fetch after this many days

// ── Log file ───────────────────────────────────────────────────────────────────

const today   = new Date().toISOString().slice(0, 10);
const logDir  = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const logFile = path.join(logDir, `backfill-fmp-${today}.log`);

fs.mkdirSync(logDir, { recursive: true });

function ts() { return new Date().toISOString(); }

function appendLog(line: string): void {
  const stamped = `[${ts()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(logFile, stamped + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ── Types ──────────────────────────────────────────────────────────────────────

type FmpRow = { ticker: string; fetchedAt: Date | null; fmpPeRatio: string | null; fmpNetIncome: string | null };

type TickerResult = {
  ticker: string;
  status: "ok" | "skip" | "fail" | "budget_stop";
  fieldsWritten?: number;
  reason?: string;
};

// ── Core per-ticker logic ──────────────────────────────────────────────────────

function isRecentlyBackfilled(row: FmpRow): boolean {
  if (!row.fetchedAt) return false;
  // Has real data, not just a placeholder empty row. wacc/roic were used for this check
  // previously, but those are legitimately null for most tickers (need a specific balance
  // sheet shape) — that made ~92% of rows look like "placeholders" forever and starved the
  // budget on the same handful of tickers every run. peRatio/netIncome come from the
  // ratios/income-statement endpoints, which return data for any ticker FMP actually covers.
  if (row.fmpPeRatio === null && row.fmpNetIncome === null) return false;
  const staleThreshold = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);
  return row.fetchedAt > staleThreshold;
}

async function processTicker(row: FmpRow): Promise<TickerResult> {
  const ticker = row.ticker;

  if (isRecentlyBackfilled(row)) {
    appendLog(`[${ticker}] SKIP — fetched within ${STALE_DAYS} days with FMP data`);
    return { ticker, status: "skip" };
  }

  if (DRY_RUN) {
    appendLog(`[${ticker}] DRY-RUN — would call all ${CALLS_PER_TICKER} FMP endpoints`);
    return { ticker, status: "ok", fieldsWritten: 0 };
  }

  const budget = await checkFMPBudget(CALLS_PER_TICKER);
  if (!budget.allowed) {
    appendLog(`[${ticker}] BUDGET_STOP — need ${CALLS_PER_TICKER}, remaining ${budget.remaining}`);
    return { ticker, status: "budget_stop", reason: `need ${CALLS_PER_TICKER}, remaining ${budget.remaining}` };
  }

  let data: Awaited<ReturnType<typeof fetchFMPFundamentals>>;
  try {
    data = await fetchFMPFundamentals(ticker, FMP_API_KEY, "backfill-fmp script", true);
  } catch (err: any) {
    appendLog(`[${ticker}] FAIL — fetch error: ${err?.message ?? "unknown"}`);
    return { ticker, status: "fail", reason: err?.message };
  }

  await recordFMPCalls(CALLS_PER_TICKER);

  const n = (v: number | undefined): string | null =>
    v !== undefined && v !== null ? String(v) : null;

  const fieldsWritten = Object.values(data).filter(v => v !== undefined && v !== null).length;

  try {
    await db
      .insert(fmpFundamentals)
      .values({
        ticker,
        fetchedAt:                     new Date(),
        fmpPeRatio:                    n(data.peRatio),
        fmpPegRatio:                   n(data.pegRatio),
        fmpForwardPe:                  n(data.forwardPe),
        fmpEvEbitda:                   n(data.evEbitda),
        fmpEvRevenue:                  n(data.evRevenue),
        fmpPriceToBook:                n(data.priceToBook),
        fmpPriceToSales:               n(data.priceToSales),
        fmpAnalystTargetPrice:         n(data.analystTargetPrice),
        fmpRevenueGrowthYoY:           n(data.revenueGrowthYoY),
        fmpRevenueGrowthYoyPrior:      n(data.revenueGrowthYoyPrior),
        fmpEpsGrowth:                  n(data.epsGrowth),
        fmpEarningsPerShare:           n(data.earningsPerShare),
        fmpGrossMargin:                n(data.grossMargin),
        fmpOperatingMargin:            n(data.operatingMargin),
        fmpNetMargin:                  n(data.netMargin),
        fmpReturnOnEquity:             n(data.returnOnEquity),
        fmpReturnOnAssets:             n(data.returnOnAssets),
        fmpEffectiveTaxRate:           n(data.effectiveTaxRate),
        fmpTotalRevenue:               n(data.totalRevenue),
        fmpNetIncome:                  n(data.netIncome),
        fmpEbitda:                     n(data.ebitda),
        fmpEbit:                       n(data.ebit),
        fmpInterestExpense:            n(data.interestExpense),
        fmpFreeCashFlow:               n(data.freeCashFlow),
        fmpCurrentRatio:               n(data.currentRatio),
        fmpDebtToEquity:               n(data.debtToEquity),
        fmpTotalDebt:                  n(data.totalDebt),
        fmpTotalStockholdersEquity:    n(data.totalStockholdersEquity),
        fmpCashAndEquivalents:         n(data.cashAndEquivalents),
        fmpWacc:                       n(data.wacc),
        fmpRoic:                       n(data.roic),
        fmpQuarterlyOperatingCashFlow: n(data.quarterlyOperatingCashFlow),
        fmpSharesOutstanding:          n(data.sharesOutstanding),
        fmpSharesOutstandingPrior:     n(data.sharesOutstandingPrior),
        fmpDividendYield:              n(data.dividendYield),
        fmpBeta:                       n(data.beta),
      })
      .onConflictDoUpdate({
        target: fmpFundamentals.ticker,
        set: {
          fetchedAt:                     sql`now()`,
          fmpPeRatio:                    sql`excluded.fmp_pe_ratio`,
          fmpPegRatio:                   sql`excluded.fmp_peg_ratio`,
          fmpForwardPe:                  sql`excluded.fmp_forward_pe`,
          fmpEvEbitda:                   sql`excluded.fmp_ev_ebitda`,
          fmpEvRevenue:                  sql`excluded.fmp_ev_revenue`,
          fmpPriceToBook:                sql`excluded.fmp_price_to_book`,
          fmpPriceToSales:               sql`excluded.fmp_price_to_sales`,
          fmpAnalystTargetPrice:         sql`excluded.fmp_analyst_target_price`,
          fmpRevenueGrowthYoY:           sql`excluded.fmp_revenue_growth_yoy`,
          fmpRevenueGrowthYoyPrior:      sql`excluded.fmp_revenue_growth_yoy_prior`,
          fmpEpsGrowth:                  sql`excluded.fmp_eps_growth`,
          fmpEarningsPerShare:           sql`excluded.fmp_earnings_per_share`,
          fmpGrossMargin:                sql`excluded.fmp_gross_margin`,
          fmpOperatingMargin:            sql`excluded.fmp_operating_margin`,
          fmpNetMargin:                  sql`excluded.fmp_net_margin`,
          fmpReturnOnEquity:             sql`excluded.fmp_return_on_equity`,
          fmpReturnOnAssets:             sql`excluded.fmp_return_on_assets`,
          fmpEffectiveTaxRate:           sql`excluded.fmp_effective_tax_rate`,
          fmpTotalRevenue:               sql`excluded.fmp_total_revenue`,
          fmpNetIncome:                  sql`excluded.fmp_net_income`,
          fmpEbitda:                     sql`excluded.fmp_ebitda`,
          fmpEbit:                       sql`excluded.fmp_ebit`,
          fmpInterestExpense:            sql`excluded.fmp_interest_expense`,
          fmpFreeCashFlow:               sql`excluded.fmp_free_cash_flow`,
          fmpCurrentRatio:               sql`excluded.fmp_current_ratio`,
          fmpDebtToEquity:               sql`excluded.fmp_debt_to_equity`,
          fmpTotalDebt:                  sql`excluded.fmp_total_debt`,
          fmpTotalStockholdersEquity:    sql`excluded.fmp_total_stockholders_equity`,
          fmpCashAndEquivalents:         sql`excluded.fmp_cash_and_equivalents`,
          fmpWacc:                       sql`excluded.fmp_wacc`,
          fmpRoic:                       sql`excluded.fmp_roic`,
          fmpQuarterlyOperatingCashFlow: sql`excluded.fmp_quarterly_operating_cash_flow`,
          fmpSharesOutstanding:          sql`excluded.fmp_shares_outstanding`,
          fmpSharesOutstandingPrior:     sql`excluded.fmp_shares_outstanding_prior`,
          fmpDividendYield:              sql`excluded.fmp_dividend_yield`,
          fmpBeta:                       sql`excluded.fmp_beta`,
        },
      });
  } catch (err: any) {
    appendLog(`[${ticker}] FAIL — db write: ${err?.message ?? "unknown"}`);
    return { ticker, status: "fail", reason: err?.message };
  }

  appendLog(`[${ticker}] OK — ${fieldsWritten} fields`);
  return { ticker, status: "ok", fieldsWritten };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!FMP_API_KEY && !DRY_RUN) {
    appendLog("FATAL — FMP_API_KEY not set");
    process.exit(1);
  }

  appendLog(`backfill-fmp starting${DRY_RUN ? " (DRY RUN)" : ""}`);

  const universeTickers = (await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.fetchFundamentals, true))
    .orderBy(tickerRegistry.ticker))
    .map(r => r.ticker);

  const stalenessRows = await db
    .select({ ticker: fmpFundamentals.ticker, fetchedAt: fmpFundamentals.fetchedAt, fmpPeRatio: fmpFundamentals.fmpPeRatio, fmpNetIncome: fmpFundamentals.fmpNetIncome })
    .from(fmpFundamentals);
  const fmpStaleMap = new Map(stalenessRows.map(r => [r.ticker, r]));

  // Shuffled so a budget stop doesn't always cut off the same alphabetical tail of the
  // universe on every run — tickers that never return usable FMP data (rate limits, gaps)
  // stay eligible forever and would otherwise monopolize the early slots every time.
  const rows: FmpRow[] = shuffle(universeTickers.map(ticker =>
    fmpStaleMap.get(ticker) ?? { ticker, fetchedAt: null, fmpPeRatio: null, fmpNetIncome: null }
  ));

  appendLog(`${rows.length} canonical tickers (fetch_fundamentals=true)`);

  if (!DRY_RUN) {
    const budget = await checkFMPBudget(0);
    appendLog(`FMP budget: ${budget.callsToday} used today, ${budget.remaining} remaining`);
  }

  const results: TickerResult[] = [];
  let budgetStopped = false;

  for (const row of rows) {
    const result = await processTicker(row);
    results.push(result);

    if (result.status === "budget_stop") {
      budgetStopped = true;
      appendLog("Budget exhausted — stopping. Re-run after midnight UTC quota reset.");
      break;
    }

    // Serial mode spaces calls 400ms apart (3.6s/ticker); small gap here for safety.
    if (!DRY_RUN && (result.status === "ok" || result.status === "fail")) {
      await sleep(500);
    }
  }

  const ok      = results.filter(r => r.status === "ok");
  const skipped = results.filter(r => r.status === "skip");
  const failed  = results.filter(r => r.status === "fail");

  const totalCalls  = ok.length * CALLS_PER_TICKER;
  const totalFields = ok.reduce((s, r) => s + (r.fieldsWritten ?? 0), 0);

  const summary = [
    "",
    "── backfill-fmp summary ────────────────────",
    `  Mode           : ${DRY_RUN ? "DRY RUN" : "live"}`,
    `  Processed      : ${ok.length}`,
    `  Skipped        : ${skipped.length} (recently backfilled)`,
    `  Failed         : ${failed.length}`,
    budgetStopped ? `  Budget stop    : after ${ok.length + skipped.length + failed.length} tickers` : "",
    `  Total FMP calls: ${totalCalls}`,
    `  Fields written : ${totalFields}`,
    failed.length > 0 ? `  Failures       : ${failed.map(r => r.ticker).join(", ")}` : "",
    "────────────────────────────────────────────",
  ].filter(Boolean);

  for (const line of summary) appendLog(line);
}

main().catch(err => {
  appendLog(`FATAL — ${err.message}`);
  process.exit(1);
});
