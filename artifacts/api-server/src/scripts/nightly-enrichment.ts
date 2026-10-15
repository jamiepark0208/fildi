/**
 * Nightly enrichment: fills null ticker_fundamentals fields using all available sources.
 *
 * Gap analysis:
 *   1. Find tickers with null fields in ticker_fundamentals
 *   2. For each source, identify which of those tickers this source can help with (per FIELD_DEFS)
 *   3. Skip tickers where the source's staging table is fresh (<7 days) — re-fetching won't fill
 *      nulls that the API already returned as null
 *   4. Check remaining budget from api_usage
 *   5. Fetch → upsert staging → record usage, then populate + merge at end
 *
 * Source order (cheapest → most expensive per ticker):
 *   yahoo (free) → edgar (free) → finnhub (free) → polygon (free) → alpha_vantage (25/day) → fmp (220/day)
 *
 * Run: cd artifacts/api-server && npx tsx src/scripts/nightly-enrichment.ts
 * Dry run: npx tsx src/scripts/nightly-enrichment.ts --dry-run
 * Scoped test: npx tsx src/scripts/nightly-enrichment.ts --tickers=RGTI,SPCX --dry-run
 */

import { sleep } from "../lib/http-client.js";
import { sql, eq, inArray } from "drizzle-orm";
import {
  db,
  tickerRegistry,
  tickerFundamentals,
  yahooFundamentals,
  edgarFundamentals,
  finnhubFundamentals,
  avFundamentals,
  fmpFundamentals,
  sourceFundamentals,
  peerGroupMembers,
} from "@workspace/db";
import { FIELD_DEFS, runMergeTrusted } from "./merge-trusted.js";
import { runPopulateSourceFundamentals } from "./populate-source-fundamentals.js";
import { fetchYahooFundamentals }   from "../lib/yahoo-client.js";
import { fetchEdgarFundamentals, bootstrapCikCache } from "../lib/edgar-client.js";
import { fetchFinnhubFundamentals }  from "../lib/finnhub-client.js";
import { fetchAVOverview }           from "../lib/alpha-vantage-client.js";
import { fetchFMPFundamentals }      from "../lib/fmp-client.js";
import { resetDataSourceDailyCountersIfNeeded } from "../lib/reset-data-source-counters.js";
import { runFactsetReferee } from "../lib/factset-referee.js";
import {
  AV_MAX_DAILY_CALLS,
  AV_OVERVIEW_DAILY_CAP,
  CALLS_PER_TICKER as SHARED_CALLS_PER_TICKER,
  FMP_MAX_DAILY_CALLS,
  PEER_EXPANSION_CAP as SHARED_PEER_CAP,
  SOURCE_ORDER as SHARED_SOURCE_ORDER,
  STALE_DAYS as SHARED_STALE_DAYS,
} from "../lib/data-ops-config.js";
import { isFmpPremiumError, isFmpRestricted, markFmpRestricted } from "../lib/fmp-restricted.js";
import {
  EARNINGS_STALE_DAYS,
  getEarningsWindowTickers,
  listEarningsWindowHits,
} from "../lib/refresh-triggers.js";
import {
  log, getRemainingBudgets, prioritizeQueue, computeCoveragePercent, classifyUngroupedTickers,
  detectNodataAnomaly, recordRun,
} from "./nightly-enrichment-support.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const DRY_RUN    = process.argv.includes("--dry-run");
const STALE_DAYS = SHARED_STALE_DAYS;

/** Populated in main() — earnings ± window tickers get priority + shorter stale. */
let earningsWindowTickers = new Set<string>();

// bug/9: peers of an added ticker used to get fetchFundamentals=true synchronously
// on every POST /watchlist (unbounded — one add could flag an entire peer group).
// That flip now happens here instead, capped per run so a large backlog of newly
// unflagged peers can't blow the nightly budget in one pass.
const PEER_EXPANSION_CAP = SHARED_PEER_CAP;

// --fields dividendYield,epsGrowth  → restrict to only these tfCol names (for testing)
const FIELDS_ARG = process.argv.find(a => a.startsWith("--fields="))?.split("=")[1];
const FIELD_FILTER: Set<string> | null = FIELDS_ARG
  ? new Set(FIELDS_ARG.split(",").map(s => s.trim()))
  : null;

// --tickers=RGTI,SPCX  → restrict the universe to these tickers only (for testing
// a small batch before a full run). Intersected with the flagged universe below —
// does not bypass fetch_fundamentals gating. Peer expansion is skipped when this
// is set, so a scoped test run never flips fetch_fundamentals for unrelated peers.
const TICKERS_ARG = process.argv.find(a => a.startsWith("--tickers="))?.split("=")[1];
const TICKER_FILTER: Set<string> | null = TICKERS_ARG
  ? new Set(TICKERS_ARG.split(",").map(s => s.trim().toUpperCase()))
  : null;

// .env.local uses ALPHA_VANTAGE_API_KEY (A84); keep AV_API_KEY as legacy alias.
const AV_API_KEY      = process.env.ALPHA_VANTAGE_API_KEY ?? process.env.AV_API_KEY ?? "";
const FMP_API_KEY     = process.env.FMP_API_KEY     ?? "";
// Daily call limits (Infinity = no hard limit, rate-limited only)
const SOURCE_DAILY_LIMITS: Record<string, number> = {
  yahoo:         Infinity,
  edgar:         Infinity,
  finnhub:       Infinity,
  alpha_vantage: AV_MAX_DAILY_CALLS, // then capped to AV_OVERVIEW_DAILY_CAP after shared api_usage
  fmp:           FMP_MAX_DAILY_CALLS,
};

// Calls consumed per ticker-fetch (for budget math) — re-export shared config
export const CALLS_PER_TICKER: Record<string, number> = { ...SHARED_CALLS_PER_TICKER };

// Rate-limit sleeps
const BATCH_SLEEP_MS: Record<string, number> = {
  yahoo: 1000, edgar: 3500, finnhub: 3500,
  alpha_vantage: 12000, fmp: 1000,
};

const BATCH_CONCURRENT: Record<string, number> = {
  yahoo: 3, edgar: 3, finnhub: 3, alpha_vantage: 1, fmp: 1,
};

// Process order: cheapest first (shared with on-demand enrich-and-merge)
const SOURCE_ORDER = [...SHARED_SOURCE_ORDER];

const n = (v: number | null | undefined): string | null =>
  v !== undefined && v !== null ? String(v) : null;

// ── Gap analysis ───────────────────────────────────────────────────────────────

// Which tfCols are coverable by each source (from FIELD_DEFS priority lists)
function buildSourceFieldMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const { tfCol, priority } of FIELD_DEFS) {
    for (const [src] of priority) {
      if (!map.has(src)) map.set(src, new Set());
      map.get(src)!.add(tfCol as string);
    }
  }
  return map;
}

// Returns ticker → Set<tfCol> of null fields (only those covered by FIELD_DEFS)
async function findNullFields(tickers: string[]): Promise<Map<string, Set<string>>> {
  const rows = await db.select().from(tickerFundamentals)
    .where(inArray(tickerFundamentals.ticker, tickers));

  const allCovered = new Set(FIELD_DEFS.map(f => f.tfCol as string));
  const covered = FIELD_FILTER
    ? new Set([...allCovered].filter(f => FIELD_FILTER.has(f)))
    : allCovered;
  const result  = new Map<string, Set<string>>();
  const seen    = new Set<string>();

  for (const row of rows) {
    seen.add(row.ticker);
    const nulls = new Set<string>();
    for (const col of covered) {
      if ((row as any)[col] === null || (row as any)[col] === undefined) {
        nulls.add(col);
      }
    }
    if (nulls.size > 0) result.set(row.ticker, nulls);
  }

  // Tickers flagged in ticker_registry but with no ticker_fundamentals row yet
  // (e.g. just added via the watchlist) never appear in `rows` above — nothing
  // else seeds an empty row for them, so without this they'd be silently
  // invisible to the fetch pipeline forever.
  for (const ticker of tickers) {
    if (!seen.has(ticker)) result.set(ticker, new Set(covered));
  }

  return result;
}

// Returns which tickers a source should fetch for, given the null fields that need filling.
//
// Skip logic (a ticker is skipped for a source if EITHER condition holds):
//   1. source_fundamentals already has a non-null value from this source for ALL the fields
//      this source could fill for this ticker → the data is in the DB, just re-run merge.
//   2. Staging table is fresh (<7 days) AND source_fundamentals has at least one entry from
//      this source for this ticker → source was fetched recently and returned null for those
//      fields; re-fetching won't help.
//
// A ticker IS included when: staging is stale/missing OR source_fundamentals has no data from
// this source at all for this ticker (never fetched).
async function buildFetchTargets(
  nullFieldsMap: Map<string, Set<string>>,
  sourceFieldMap: Map<string, Set<string>>,
): Promise<Map<string, string[]>> {
  const tickers = [...nullFieldsMap.keys()];
  const staleThreshold = new Date(Date.now() - STALE_DAYS * 86_400_000);
  const earningsStaleThreshold = new Date(Date.now() - EARNINGS_STALE_DAYS * 86_400_000);

  // Load staging freshness for all sources in one pass
  const [yahooRows, edgarRows, finnhubRows, avRows, fmpRows] = await Promise.all([
    db.select({ ticker: yahooFundamentals.ticker, fetchedAt: yahooFundamentals.fetchedAt }).from(yahooFundamentals).where(inArray(yahooFundamentals.ticker, tickers)),
    db.select({ ticker: edgarFundamentals.ticker, fetchedAt: edgarFundamentals.fetchedAt }).from(edgarFundamentals).where(inArray(edgarFundamentals.ticker, tickers)),
    db.select({ ticker: finnhubFundamentals.ticker, fetchedAt: finnhubFundamentals.fetchedAt }).from(finnhubFundamentals).where(inArray(finnhubFundamentals.ticker, tickers)),
    db.select({ ticker: avFundamentals.ticker, fetchedAt: avFundamentals.fetchedAt }).from(avFundamentals).where(inArray(avFundamentals.ticker, tickers)),
    db.select({ ticker: fmpFundamentals.ticker, fetchedAt: fmpFundamentals.fetchedAt, fmpPeRatio: fmpFundamentals.fmpPeRatio, fmpNetIncome: fmpFundamentals.fmpNetIncome }).from(fmpFundamentals).where(inArray(fmpFundamentals.ticker, tickers)),
  ]);

  // Build staging-freshness maps: source → Set<ticker> that are fresh
  const stagingFresh = new Map<string, Set<string>>();
  const stagingFreshEarnings = new Map<string, Set<string>>();
  function freshSet(rows: { ticker: string; fetchedAt: Date | null }[], cutoff: Date, extra?: (r: any) => boolean): Set<string> {
    return new Set(rows.filter(r => {
      if (!r.fetchedAt || r.fetchedAt < cutoff) return false;
      return !extra || !extra(r);
    }).map(r => r.ticker));
  }
  function setBoth(src: string, rows: { ticker: string; fetchedAt: Date | null }[], extra?: (r: any) => boolean) {
    stagingFresh.set(src, freshSet(rows, staleThreshold, extra));
    stagingFreshEarnings.set(src, freshSet(rows, earningsStaleThreshold, extra));
  }
  setBoth("yahoo", yahooRows);
  setBoth("edgar", edgarRows);
  setBoth("finnhub", finnhubRows);
  setBoth("alpha_vantage", avRows);
  // Real-data check for fmp uses peRatio/netIncome, not wacc/roic — those are FMP-exclusive
  // but legitimately null for most tickers (need a specific balance sheet shape), which made
  // ~92% of rows look like placeholders forever and starved the budget on the same tickers
  // every run. See backfill-fmp.ts's isRecentlyBackfilled for the same fix.
  setBoth("fmp", fmpRows, r => r.fmpPeRatio === null && r.fmpNetIncome === null);

  // Load source_fundamentals for all tickers+sources in one query:
  // ticker → source → Set<sfField> that have non-null values
  const sfRows = await db
    .select({ ticker: sourceFundamentals.ticker, source: sourceFundamentals.source, field: sourceFundamentals.field })
    .from(sourceFundamentals)
    .where(inArray(sourceFundamentals.ticker, tickers));

  // ticker → source → Set<canonical field names with non-null data>
  const sfIndex = new Map<string, Map<string, Set<string>>>();
  for (const row of sfRows) {
    if (!sfIndex.has(row.ticker)) sfIndex.set(row.ticker, new Map());
    const bySource = sfIndex.get(row.ticker)!;
    if (!bySource.has(row.source)) bySource.set(row.source, new Set());
    bySource.get(row.source)!.add(row.field);
  }

  // For each source, determine which sfFields map to tfCols (reverse-map from FIELD_DEFS)
  // source → sfField → tfCol
  const sfToTfCol = new Map<string, Map<string, string>>();
  for (const { tfCol, priority } of FIELD_DEFS) {
    for (const [src, sfField] of priority) {
      if (!sfToTfCol.has(src)) sfToTfCol.set(src, new Map());
      sfToTfCol.get(src)!.set(sfField, tfCol as string);
    }
  }

  const result = new Map<string, string[]>();

  for (const src of SOURCE_ORDER) {
    const coverableFields = sourceFieldMap.get(src) ?? new Set<string>();
    const isStagingFresh  = stagingFresh.get(src) ?? new Set<string>();
    const sfFieldToTfCol  = sfToTfCol.get(src) ?? new Map<string, string>();

    const isStagingFreshEarn = stagingFreshEarnings.get(src) ?? new Set<string>();

    const targets = tickers.filter(ticker => {
      const nullTfCols = nullFieldsMap.get(ticker)!;
      // Fields this source could fill for this ticker's nulls
      const needed = [...nullTfCols].filter(f => coverableFields.has(f));
      // Earnings window: re-pull yahoo/finnhub/fmp even when gold has no nulls
      const earningsForce =
        earningsWindowTickers.has(ticker) &&
        (src === "yahoo" || src === "finnhub" || src === "fmp");
      if (needed.length === 0 && !earningsForce) return false;

      const sourceSfFields = sfIndex.get(ticker)?.get(src) ?? new Set<string>();

      // Check which needed tfCols are already covered by non-null source_fundamentals entries
      const alreadyCovered = needed.filter(tfCol => {
        // Find the sfField(s) this source uses for this tfCol
        for (const [sfField, mappedTfCol] of sfFieldToTfCol) {
          if (mappedTfCol === tfCol && sourceSfFields.has(sfField)) return true;
        }
        return false;
      });

      if (!earningsForce && alreadyCovered.length === needed.length) {
        // All needed fields already in source_fundamentals → just re-run populate+merge, no API call
        return false;
      }

      // Staging fresh means we attempted this source for this ticker within STALE_DAYS —
      // whether it returned partial data or nothing at all, don't burn budget retrying
      // it again until the staleness window passes. Previously this only skipped when
      // sourceSfFields.size > 0, so tickers that came back with zero data (the common
      // case for small/foreign tickers on FMP/AV) were retried every single run,
      // starving never-tried tickers of the tiny FMP/AV daily budget.
      // Earnings window uses EARNINGS_STALE_DAYS (1d) so post-print numbers get one refresh.
      if (earningsWindowTickers.has(ticker)) {
        if (isStagingFreshEarn.has(ticker)) return false;
      } else if (isStagingFresh.has(ticker)) {
        return false;
      }

      return true;
    });

    result.set(src, targets);
  }

  return result;
}

// ── Per-source fetch + upsert ──────────────────────────────────────────────────

async function fetchYahoo(ticker: string): Promise<"ok" | "fail" | "nodata"> {
  const data = await fetchYahooFundamentals(ticker);
  const nonNull = Object.values(data).filter(v => v != null).length;
  if (nonNull === 0) return "nodata";
  await db.insert(yahooFundamentals).values({
    ticker, fetchedAt: new Date(),
    yahooGrossMargins:            data.yahoo_grossMargins?.toString()            ?? null,
    yahooOperatingMargins:        data.yahoo_operatingMargins?.toString()        ?? null,
    yahooProfitMargins:           data.yahoo_profitMargins?.toString()           ?? null,
    yahooReturnOnEquity:          data.yahoo_returnOnEquity?.toString()          ?? null,
    yahooReturnOnAssets:          data.yahoo_returnOnAssets?.toString()          ?? null,
    yahooRevenueGrowth:           data.yahoo_revenueGrowth?.toString()           ?? null,
    yahooDebtToEquity:            data.yahoo_debtToEquity?.toString()            ?? null,
    yahooCurrentRatio:            data.yahoo_currentRatio?.toString()            ?? null,
    yahooTotalRevenue:            data.yahoo_totalRevenue?.toString()            ?? null,
    yahooTotalDebt:               data.yahoo_totalDebt?.toString()               ?? null,
    yahooTotalCash:               data.yahoo_totalCash?.toString()               ?? null,
    yahooFreeCashflow:            data.yahoo_freeCashflow?.toString()            ?? null,
    yahooOperatingCashflow:       data.yahoo_operatingCashflow?.toString()       ?? null,
    yahooEbitda:                  data.yahoo_ebitda?.toString()                  ?? null,
    yahooTargetMeanPrice:         data.yahoo_targetMeanPrice?.toString()         ?? null,
    yahooForwardPe:               data.yahoo_forwardPE?.toString()               ?? null,
    yahooPegRatio:                data.yahoo_pegRatio?.toString()                ?? null,
    yahooPriceToBook:             data.yahoo_priceToBook?.toString()             ?? null,
    yahooEnterpriseToEbitda:      data.yahoo_enterpriseToEbitda?.toString()      ?? null,
    yahooEnterpriseToRevenue:     data.yahoo_enterpriseToRevenue?.toString()     ?? null,
    yahooTrailingEps:             data.yahoo_trailingEps?.toString()             ?? null,
    yahooForwardEps:              data.yahoo_forwardEps?.toString()              ?? null,
    yahooBeta:                    data.yahoo_beta?.toString()                    ?? null,
    yahooSharesOutstanding:       data.yahoo_sharesOutstanding?.toString()       ?? null,
    yahooFloatShares:             data.yahoo_floatShares?.toString()             ?? null,
    yahooHeldPercentInsiders:     data.yahoo_heldPercentInsiders?.toString()     ?? null,
    yahooShortRatio:              data.yahoo_shortRatio?.toString()              ?? null,
    yahooAnnualTotalRevenue:      data.yahoo_annualTotalRevenue?.toString()      ?? null,
    yahooAnnualGrossProfit:       data.yahoo_annualGrossProfit?.toString()       ?? null,
    yahooAnnualEbit:              data.yahoo_annualEbit?.toString()              ?? null,
    yahooAnnualNetIncome:         data.yahoo_annualNetIncome?.toString()         ?? null,
    yahooAnnualRevenueYoy:        data.yahoo_annualRevenueYoy?.toString()        ?? null,
    yahooAnnualRevenueYoyPrior:   data.yahoo_annualRevenueYoyPrior?.toString()   ?? null,
    yahooAnnualCash:              data.yahoo_annualCash?.toString()              ?? null,
    yahooAnnualTotalDebt:         data.yahoo_annualTotalDebt?.toString()         ?? null,
    yahooAnnualTotalEquity:       data.yahoo_annualTotalEquity?.toString()       ?? null,
    yahooAnnualOperatingCashFlow: data.yahoo_annualOperatingCashFlow?.toString() ?? null,
    yahooAnnualCapex:             data.yahoo_annualCapex?.toString()             ?? null,
    yahooAnnualFreeCashFlow:      data.yahoo_annualFreeCashFlow?.toString()      ?? null,
    yahooTrailingPe:              data.yahoo_trailingPE?.toString()              ?? null,
    yahooDividendYield:           data.yahoo_dividendYield?.toString()           ?? null,
    yahooEffectiveTaxRate:        data.yahoo_effectiveTaxRate?.toString()        ?? null,
    yahooEpsGrowth:               data.yahoo_epsGrowth?.toString()               ?? null,
    yahooInterestExpense:         data.yahoo_interestExpense?.toString()         ?? null,
    yahooQuarterlyOcf:            data.yahoo_quarterlyOcf?.toString()            ?? null,
    yahooRoic:                    data.yahoo_roic?.toString()                    ?? null,
    yahooSharesOutstandingPrior:  data.yahoo_sharesOutstandingPrior?.toString()  ?? null,
    yahooWacc:                    data.yahoo_wacc?.toString()                    ?? null,
  }).onConflictDoUpdate({ target: yahooFundamentals.ticker, set: {
    fetchedAt: sql`now()`,
    yahooGrossMargins:            sql`excluded.yahoo_gross_margins`,
    yahooOperatingMargins:        sql`excluded.yahoo_operating_margins`,
    yahooProfitMargins:           sql`excluded.yahoo_profit_margins`,
    yahooReturnOnEquity:          sql`excluded.yahoo_return_on_equity`,
    yahooReturnOnAssets:          sql`excluded.yahoo_return_on_assets`,
    yahooRevenueGrowth:           sql`excluded.yahoo_revenue_growth`,
    yahooDebtToEquity:            sql`excluded.yahoo_debt_to_equity`,
    yahooCurrentRatio:            sql`excluded.yahoo_current_ratio`,
    yahooTotalRevenue:            sql`excluded.yahoo_total_revenue`,
    yahooTotalDebt:               sql`excluded.yahoo_total_debt`,
    yahooTotalCash:               sql`excluded.yahoo_total_cash`,
    yahooFreeCashflow:            sql`excluded.yahoo_free_cashflow`,
    yahooOperatingCashflow:       sql`excluded.yahoo_operating_cashflow`,
    yahooEbitda:                  sql`excluded.yahoo_ebitda`,
    yahooTargetMeanPrice:         sql`excluded.yahoo_target_mean_price`,
    yahooForwardPe:               sql`excluded.yahoo_forward_pe`,
    yahooPegRatio:                sql`excluded.yahoo_peg_ratio`,
    yahooPriceToBook:             sql`excluded.yahoo_price_to_book`,
    yahooEnterpriseToEbitda:      sql`excluded.yahoo_enterprise_to_ebitda`,
    yahooEnterpriseToRevenue:     sql`excluded.yahoo_enterprise_to_revenue`,
    yahooTrailingEps:             sql`excluded.yahoo_trailing_eps`,
    yahooForwardEps:              sql`excluded.yahoo_forward_eps`,
    yahooBeta:                    sql`excluded.yahoo_beta`,
    yahooSharesOutstanding:       sql`excluded.yahoo_shares_outstanding`,
    yahooFloatShares:             sql`excluded.yahoo_float_shares`,
    yahooHeldPercentInsiders:     sql`excluded.yahoo_held_percent_insiders`,
    yahooShortRatio:              sql`excluded.yahoo_short_ratio`,
    yahooAnnualTotalRevenue:      sql`excluded.yahoo_annual_total_revenue`,
    yahooAnnualGrossProfit:       sql`excluded.yahoo_annual_gross_profit`,
    yahooAnnualEbit:              sql`excluded.yahoo_annual_ebit`,
    yahooAnnualNetIncome:         sql`excluded.yahoo_annual_net_income`,
    yahooAnnualRevenueYoy:        sql`excluded.yahoo_annual_revenue_yoy`,
    yahooAnnualRevenueYoyPrior:   sql`excluded.yahoo_annual_revenue_yoy_prior`,
    yahooAnnualCash:              sql`excluded.yahoo_annual_cash`,
    yahooAnnualTotalDebt:         sql`excluded.yahoo_annual_total_debt`,
    yahooAnnualTotalEquity:       sql`excluded.yahoo_annual_total_equity`,
    yahooAnnualOperatingCashFlow: sql`excluded.yahoo_annual_operating_cash_flow`,
    yahooAnnualCapex:             sql`excluded.yahoo_annual_capex`,
    yahooAnnualFreeCashFlow:      sql`excluded.yahoo_annual_free_cash_flow`,
    yahooTrailingPe:              sql`excluded.yahoo_trailing_pe`,
    yahooDividendYield:           sql`excluded.yahoo_dividend_yield`,
    yahooEffectiveTaxRate:        sql`excluded.yahoo_effective_tax_rate`,
    yahooEpsGrowth:               sql`excluded.yahoo_eps_growth`,
    yahooInterestExpense:         sql`excluded.yahoo_interest_expense`,
    yahooQuarterlyOcf:            sql`excluded.yahoo_quarterly_ocf`,
    yahooRoic:                    sql`excluded.yahoo_roic`,
    yahooSharesOutstandingPrior:  sql`excluded.yahoo_shares_outstanding_prior`,
    yahooWacc:                    sql`excluded.yahoo_wacc`,
  }});
  return "ok";
}

async function fetchEdgar(ticker: string): Promise<"ok" | "fail" | "nodata"> {
  const { data } = await fetchEdgarFundamentals(ticker);
  const nonNull = Object.values(data).filter(v => v != null).length;
  if (nonNull === 0) return "nodata";
  await db.insert(edgarFundamentals).values({
    ticker, fetchedAt: new Date(),
    edgarTotalRevenue:       data.edgar_totalRevenue?.toString()       ?? null,
    edgarGrossProfit:        data.edgar_grossProfit?.toString()        ?? null,
    edgarNetIncome:          data.edgar_netIncome?.toString()          ?? null,
    edgarEbit:               data.edgar_ebit?.toString()               ?? null,
    edgarEbitda:             data.edgar_ebitda?.toString()             ?? null,
    edgarFreeCashFlow:       data.edgar_freeCashFlow?.toString()       ?? null,
    edgarOperatingCashFlow:  data.edgar_operatingCashFlow?.toString()  ?? null,
    edgarCapitalExpenditure: data.edgar_capitalExpenditure?.toString() ?? null,
    edgarCashAndEquivalents: data.edgar_cashAndEquivalents?.toString() ?? null,
    edgarTotalDebt:          data.edgar_totalDebt?.toString()          ?? null,
    edgarTotalEquity:        data.edgar_totalEquity?.toString()        ?? null,
    edgarInterestExpense:    data.edgar_interestExpense?.toString()    ?? null,
    edgarSharesOutstanding:  data.edgar_sharesOutstanding?.toString()  ?? null,
    edgarGrossMargin:        data.edgar_grossMargin?.toString()        ?? null,
    edgarNetMargin:          data.edgar_netMargin?.toString()          ?? null,
    edgarDepreciationAmortization: data.edgar_depreciationAmortization?.toString() ?? null,
  } as any).onConflictDoUpdate({ target: edgarFundamentals.ticker, set: {
    fetchedAt:               sql`now()`,
    edgarTotalRevenue:       sql`excluded.edgar_total_revenue`,
    edgarGrossProfit:        sql`excluded.edgar_gross_profit`,
    edgarNetIncome:          sql`excluded.edgar_net_income`,
    edgarEbit:               sql`excluded.edgar_ebit`,
    edgarEbitda:             sql`excluded.edgar_ebitda`,
    edgarFreeCashFlow:       sql`excluded.edgar_free_cash_flow`,
    edgarOperatingCashFlow:  sql`excluded.edgar_operating_cash_flow`,
    edgarCapitalExpenditure: sql`excluded.edgar_capital_expenditure`,
    edgarCashAndEquivalents: sql`excluded.edgar_cash_and_equivalents`,
    edgarTotalDebt:          sql`excluded.edgar_total_debt`,
    edgarTotalEquity:        sql`excluded.edgar_total_equity`,
    edgarInterestExpense:    sql`excluded.edgar_interest_expense`,
    edgarSharesOutstanding:  sql`excluded.edgar_shares_outstanding`,
    edgarGrossMargin:        sql`excluded.edgar_gross_margin`,
    edgarNetMargin:          sql`excluded.edgar_net_margin`,
    edgarDepreciationAmortization: sql`excluded.edgar_depreciation_amortization`,
  } as any});
  return "ok";
}

async function fetchFinnhub(ticker: string): Promise<"ok" | "fail" | "nodata"> {
  const data = await fetchFinnhubFundamentals(ticker);
  const nonNull = Object.values(data as Record<string,unknown>).filter(v => v != null).length;
  if (nonNull === 0) return "nodata";
  await db.insert(finnhubFundamentals).values({
    ticker, fetchedAt: new Date(),
    finnhubPeRatio:               data.finnhub_peRatio?.toString()              ?? null,
    finnhubPegRatio:              data.finnhub_pegRatio?.toString()             ?? null,
    finnhubPbRatio:               data.finnhub_pbRatio?.toString()              ?? null,
    finnhubPsRatio:               data.finnhub_psRatio?.toString()              ?? null,
    finnhubPriceToBook:           data.finnhub_priceToBook?.toString()          ?? null,
    finnhubEv:                    data.finnhub_ev?.toString()                   ?? null,
    finnhubMarketCap:             data.finnhub_marketCap?.toString()            ?? null,
    finnhubGrossMargin:           data.finnhub_grossMargin?.toString()          ?? null,
    finnhubOperatingMargin:       data.finnhub_operatingMargin?.toString()      ?? null,
    finnhubNetMargin:             data.finnhub_netMargin?.toString()            ?? null,
    finnhubFcfMargin:             data.finnhub_fcfMargin?.toString()            ?? null,
    finnhubReturnOnEquity:        data.finnhub_returnOnEquity?.toString()       ?? null,
    finnhubReturnOnAssets:        data.finnhub_returnOnAssets?.toString()       ?? null,
    finnhubRoic:                  data.finnhub_roic?.toString()                 ?? null,
    finnhubRevenueGrowth:         data.finnhub_revenueGrowth?.toString()        ?? null,
    finnhubEpsGrowth:             data.finnhub_epsGrowth?.toString()            ?? null,
    finnhubDebtToEquity:          data.finnhub_debtToEquity?.toString()         ?? null,
    finnhubLongTermDebtToEquity:  data.finnhub_longTermDebtToEquity?.toString() ?? null,
    finnhubNetDebtToEquity:       data.finnhub_netDebtToEquity?.toString()      ?? null,
    finnhubCurrentRatio:          data.finnhub_currentRatio?.toString()         ?? null,
    finnhubQuickRatio:            data.finnhub_quickRatio?.toString()           ?? null,
    finnhubFcfPerShare:           data.finnhub_fcfPerShare?.toString()          ?? null,
    finnhubBookValue:             data.finnhub_bookValue?.toString()            ?? null,
    finnhubTangibleBookValuePerShare: data.finnhub_tangibleBookValuePerShare?.toString() ?? null,
    finnhubBeta:                  data.finnhub_beta?.toString()                 ?? null,
    finnhubEps:                   data.finnhub_eps?.toString()                  ?? null,
    finnhubEbitPerShare:          data.finnhub_ebitPerShare?.toString()         ?? null,
    finnhubEarningsPerShare:      data.finnhub_earningsPerShare?.toString()     ?? null,
    finnhub52weekHigh:            data.finnhub_52weekHigh?.toString()           ?? null,
    finnhub52weekLow:             data.finnhub_52weekLow?.toString()            ?? null,
    finnhubDividendYield:         data.finnhub_dividendYield?.toString()        ?? null,
  } as any).onConflictDoUpdate({ target: finnhubFundamentals.ticker, set: {
    fetchedAt:                   sql`now()`,
    finnhubPeRatio:              sql`excluded.finnhub_pe_ratio`,
    finnhubPegRatio:             sql`excluded.finnhub_peg_ratio`,
    finnhubPbRatio:              sql`excluded.finnhub_pb_ratio`,
    finnhubPsRatio:              sql`excluded.finnhub_ps_ratio`,
    finnhubPriceToBook:          sql`excluded.finnhub_price_to_book`,
    finnhubEv:                   sql`excluded.finnhub_ev`,
    finnhubMarketCap:            sql`excluded.finnhub_market_cap`,
    finnhubGrossMargin:          sql`excluded.finnhub_gross_margin`,
    finnhubOperatingMargin:      sql`excluded.finnhub_operating_margin`,
    finnhubNetMargin:            sql`excluded.finnhub_net_margin`,
    finnhubFcfMargin:            sql`excluded.finnhub_fcf_margin`,
    finnhubReturnOnEquity:       sql`excluded.finnhub_return_on_equity`,
    finnhubReturnOnAssets:       sql`excluded.finnhub_return_on_assets`,
    finnhubRoic:                 sql`excluded.finnhub_roic`,
    finnhubRevenueGrowth:        sql`excluded.finnhub_revenue_growth`,
    finnhubEpsGrowth:            sql`excluded.finnhub_eps_growth`,
    finnhubDebtToEquity:         sql`excluded.finnhub_debt_to_equity`,
    finnhubLongTermDebtToEquity: sql`excluded.finnhub_long_term_debt_to_equity`,
    finnhubNetDebtToEquity:      sql`excluded.finnhub_net_debt_to_equity`,
    finnhubCurrentRatio:         sql`excluded.finnhub_current_ratio`,
    finnhubQuickRatio:           sql`excluded.finnhub_quick_ratio`,
    finnhubFcfPerShare:          sql`excluded.finnhub_fcf_per_share`,
    finnhubBookValue:            sql`excluded.finnhub_book_value`,
    finnhubTangibleBookValuePerShare: sql`excluded.finnhub_tangible_book_value_per_share`,
    finnhubBeta:                 sql`excluded.finnhub_beta`,
    finnhubEps:                  sql`excluded.finnhub_eps`,
    finnhubEbitPerShare:         sql`excluded.finnhub_ebit_per_share`,
    finnhubEarningsPerShare:     sql`excluded.finnhub_earnings_per_share`,
    finnhub52weekHigh:           sql`excluded.finnhub_52week_high`,
    finnhub52weekLow:            sql`excluded.finnhub_52week_low`,
    finnhubDividendYield:        sql`excluded.finnhub_dividend_yield`,
  } as any});
  return "ok";
}

/** A84: Polygon /vX/reference/financials is GONE — kept as no-op stub if anything still references it. */
async function fetchPolygon(_ticker: string): Promise<"ok" | "fail" | "nodata"> {
  return "nodata";
}

async function fetchAV(ticker: string): Promise<"ok" | "fail" | "nodata"> {
  if (!AV_API_KEY) return "fail";
  const data = await fetchAVOverview(ticker, AV_API_KEY);
  const nonNull = Object.values(data as Record<string,unknown>).filter(v => v != null).length;
  if (nonNull === 0) return "nodata";
  await db.insert(avFundamentals).values({
    ticker, fetchedAt: new Date(),
    avPeRatio:            n(data.peRatio),
    avPegRatio:           n(data.pegRatio),
    avForwardPe:          n(data.forwardPe),
    avPbRatio:            n(data.pbRatio),
    avDividendYield:      n(data.dividendYield),
    avAnalystTargetPrice: n(data.analystTargetPrice),
    avNetMargin:          n(data.netMargin),
    avOperatingMargin:    n(data.operatingMargin),
    avReturnOnEquity:     n(data.returnOnEquity),
    avTotalRevenue:       n(data.totalRevenue),
    avEbitda:             n(data.ebitda),
    avBeta:               n(data.beta),
  }).onConflictDoUpdate({ target: avFundamentals.ticker, set: {
    fetchedAt:            sql`now()`,
    avPeRatio:            sql`excluded.av_pe_ratio`,
    avPegRatio:           sql`excluded.av_peg_ratio`,
    avForwardPe:          sql`excluded.av_forward_pe`,
    avPbRatio:            sql`excluded.av_pb_ratio`,
    avDividendYield:      sql`excluded.av_dividend_yield`,
    avAnalystTargetPrice: sql`excluded.av_analyst_target_price`,
    avNetMargin:          sql`excluded.av_net_margin`,
    avOperatingMargin:    sql`excluded.av_operating_margin`,
    avReturnOnEquity:     sql`excluded.av_return_on_equity`,
    avTotalRevenue:       sql`excluded.av_total_revenue`,
    avEbitda:             sql`excluded.av_ebitda`,
    avBeta:               sql`excluded.av_beta`,
  }});
  return "ok";
}

async function fetchFMP(ticker: string): Promise<"ok" | "fail" | "nodata"> {
  if (await isFmpRestricted(ticker)) return "nodata";
  let data: Awaited<ReturnType<typeof fetchFMPFundamentals>>;
  try {
    data = await fetchFMPFundamentals(ticker, FMP_API_KEY, "nightly-enrichment", true);
  } catch (err: any) {
    if (isFmpPremiumError(err)) {
      await markFmpRestricted(ticker);
      return "nodata";
    }
    throw err;
  }
  const nonNull = Object.values(data as Record<string,unknown>).filter(v => v != null).length;
  if (nonNull === 0) return "nodata";
  await db.insert(fmpFundamentals).values({
    ticker, fetchedAt: new Date(),
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
    fmpTotalAssets:                n(data.totalAssets),
    fmpGrossProfit:                n(data.grossProfit),
    fmpTangibleBookValuePerShare:  n(data.tangibleBookValuePerShare),
    fmpWacc:                       n(data.wacc),
    fmpRoic:                       n(data.roic),
    fmpQuarterlyOperatingCashFlow: n(data.quarterlyOperatingCashFlow),
    fmpAnnualOperatingCashFlow:    n(data.annualOperatingCashFlow),
    fmpSharesOutstanding:          n(data.sharesOutstanding),
    fmpSharesOutstandingPrior:     n(data.sharesOutstandingPrior),
    fmpDividendYield:              n(data.dividendYield),
    fmpBeta:                       n(data.beta),
  } as any).onConflictDoUpdate({ target: fmpFundamentals.ticker, set: {
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
    fmpTotalAssets:                sql`excluded.fmp_total_assets`,
    fmpGrossProfit:                sql`excluded.fmp_gross_profit`,
    fmpTangibleBookValuePerShare:  sql`excluded.fmp_tangible_book_value_per_share`,
    fmpWacc:                       sql`excluded.fmp_wacc`,
    fmpRoic:                       sql`excluded.fmp_roic`,
    fmpQuarterlyOperatingCashFlow: sql`excluded.fmp_quarterly_operating_cash_flow`,
    fmpAnnualOperatingCashFlow:    sql`excluded.fmp_annual_operating_cash_flow`,
    fmpSharesOutstanding:          sql`excluded.fmp_shares_outstanding`,
    fmpSharesOutstandingPrior:     sql`excluded.fmp_shares_outstanding_prior`,
    fmpDividendYield:              sql`excluded.fmp_dividend_yield`,
    fmpBeta:                       sql`excluded.fmp_beta`,
  } as any});
  return "ok";
}

// ── Per-source dispatch ────────────────────────────────────────────────────────

export const FETCH_FN: Record<string, (ticker: string) => Promise<"ok" | "fail" | "nodata">> = {
  yahoo:         fetchYahoo,
  edgar:         fetchEdgar,
  finnhub:       fetchFinnhub,
  polygon:       fetchPolygon,
  alpha_vantage: fetchAV,
  fmp:           fetchFMP,
};

// ── Process one source ─────────────────────────────────────────────────────────

async function processSource(
  source:    string,
  tickers:   string[],
  remaining: number,
): Promise<{ fetched: number; skippedBudget: number; failed: number; nodata: number }> {
  const callsPerTicker = CALLS_PER_TICKER[source];
  const maxTickers     = remaining === Infinity ? tickers.length : Math.floor(remaining / callsPerTicker);
  // Always surface earnings-window names first (cheap + scarce).
  const candidates     = prioritizeQueue(tickers, earningsWindowTickers);
  const toFetch        = candidates.slice(0, maxTickers);
  const skippedBudget  = tickers.length - toFetch.length;

  if (toFetch.length === 0) {
    log(`[${source}] no budget / no tickers — skipping`);
    return { fetched: 0, skippedBudget, failed: 0, nodata: 0 };
  }

  log(`[${source}] fetching ${toFetch.length} tickers (${skippedBudget} skipped — budget)${DRY_RUN ? " DRY-RUN" : ""}`);

  let fetched = 0, failed = 0, nodata = 0;
  const fn = FETCH_FN[source];
  const concurrent = BATCH_CONCURRENT[source];
  const sleepMs    = BATCH_SLEEP_MS[source];

  for (let i = 0; i < toFetch.length; i += concurrent) {
    const chunk = toFetch.slice(i, i + concurrent);

    if (DRY_RUN) {
      for (const t of chunk) log(`[${source}][${t}] DRY-RUN`);
      fetched += chunk.length;
      if (i + concurrent < toFetch.length) await sleep(100);
      continue;
    }

    const results = await Promise.all(chunk.map(async t => {
      try {
        // Quota counted in client logApiCall only (avoid double-count vs api_usage).
        const status = await fn(t);
        if (status === "ok") {
          log(`[${source}][${t}] OK`);
          return "ok";
        }
        if (status === "nodata") {
          log(`[${source}][${t}] NODATA`);
          return "nodata";
        }
        return "ok";
      } catch (err: any) {
        // AV quota exhaustion stops the whole source (client already logged the failed call)
        if (source === "alpha_vantage" && err?.message?.includes("AV API limit")) {
          log(`[${source}][${t}] QUOTA — ${err.message}`);
          return "quota";
        }
        log(`[${source}][${t}] FAIL — ${err?.message ?? "unknown"}`);
        return "fail";
      }
    }));

    for (const r of results) {
      if (r === "ok")    fetched++;
      else if (r === "fail")  failed++;
      else if (r === "nodata") nodata++;
      else if (r === "quota") { skippedBudget; break; }
    }

    if (i + concurrent < toFetch.length) await sleep(sleepMs);
  }

  return { fetched, skippedBudget, failed, nodata };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(trigger: "scheduled" | "manual" | "maintain_full" = "manual"): Promise<void> {
  const runStartedAt = new Date();
  log(`nightly-enrichment starting${DRY_RUN ? " (DRY RUN)" : ""}${FIELD_FILTER ? ` [fields: ${[...FIELD_FILTER].join(",")}]` : ""}`);

  try {
    await resetDataSourceDailyCountersIfNeeded();
  } catch (err: any) {
    log(`WARN: data_sources counter reset failed: ${err?.message}`);
  }

  let coverageBefore: number | null = null;
  try {
    coverageBefore = await computeCoveragePercent();
  } catch (err: any) {
    log(`WARN: failed to compute pre-run coverage snapshot: ${err?.message}`);
  }

  let fetchPlan: Map<string, string[]>;
  let budgets: Map<string, number>;

  try {

  // 1. Get canonical ticker universe
  let flaggedTickers = (await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.fetchFundamentals, true))
    .orderBy(tickerRegistry.ticker))
    .map(r => r.ticker);

  if (TICKER_FILTER) {
    const before = flaggedTickers.length;
    flaggedTickers = flaggedTickers.filter(t => TICKER_FILTER.has(t));
    const missing = [...TICKER_FILTER].filter(t => !flaggedTickers.includes(t));
    log(`--tickers filter: ${flaggedTickers.length}/${before} flagged tickers matched [${[...TICKER_FILTER].join(",")}]`);
    if (missing.length > 0) log(`WARN: --tickers requested but not fetch_fundamentals=true in registry: ${missing.join(",")}`);
  }
  log(`Universe: ${flaggedTickers.length} tickers (fetch_fundamentals=true)`);

  // 1b. bug/9 — expand to peers of the flagged universe that aren't flagged yet,
  // capped per run, and flip fetch_fundamentals=true for them now (before the
  // fetch pipeline + merge-trusted run below) so peer-relative scoring picks
  // them up this same pass instead of needing a second nightly cycle.
  // Skipped entirely under --tickers: a scoped test run should never flip
  // fetch_fundamentals for tickers outside the requested set.
  const peerGroupIds = !TICKER_FILTER && flaggedTickers.length > 0
    ? [...new Set((await db
        .select({ groupId: peerGroupMembers.groupId })
        .from(peerGroupMembers)
        .where(inArray(peerGroupMembers.ticker, flaggedTickers)))
        .map(r => r.groupId))]
    : [];

  const unflaggedPeers = peerGroupIds.length > 0
    ? [...new Set((await db
        .select({ ticker: peerGroupMembers.ticker })
        .from(peerGroupMembers)
        .where(inArray(peerGroupMembers.groupId, peerGroupIds)))
        .map(r => r.ticker)
        .filter(t => !flaggedTickers.includes(t)))]
      .slice(0, PEER_EXPANSION_CAP)
    : [];

  if (unflaggedPeers.length > 0) {
    if (DRY_RUN) {
      log(`Peer expansion: would flag ${unflaggedPeers.length} peer tickers for fundamentals DRY-RUN (capped at ${PEER_EXPANSION_CAP})`);
    } else {
      await db
        .update(tickerRegistry)
        .set({ fetchFundamentals: true })
        .where(inArray(tickerRegistry.ticker, unflaggedPeers));
      log(`Peer expansion: flagged ${unflaggedPeers.length} peer tickers for fundamentals (capped at ${PEER_EXPANSION_CAP})`);
    }
  }

  const allTickers = [...flaggedTickers, ...unflaggedPeers];

  // 1c. Earnings-window trigger — prioritize names reporting soon / just reported
  earningsWindowTickers = await getEarningsWindowTickers();
  if (TICKER_FILTER) {
    earningsWindowTickers = new Set([...earningsWindowTickers].filter((t) => TICKER_FILTER!.has(t)));
  }
  const earningsHits = await listEarningsWindowHits();
  const earnInUniverse = earningsHits.filter((h) => allTickers.includes(h.ticker));
  log(
    `Earnings trigger window: ${earnInUniverse.length} in universe` +
      (earnInUniverse.length
        ? ` (${earnInUniverse
            .slice(0, 12)
            .map((h) => `${h.ticker}@${h.reportDate}`)
            .join(", ")}${earnInUniverse.length > 12 ? "…" : ""})`
        : ""),
  );

  // 2. Bootstrap Edgar CIK cache
  log("Bootstrapping EDGAR CIK cache…");
  const cikCount = await bootstrapCikCache();
  log(`EDGAR CIK cache: ${cikCount} entries`);

  // 3. Find null fields in ticker_fundamentals
  const nullFieldsMap = await findNullFields(allTickers);
  // Earnings names with full gold still need a post-print refresh path
  for (const t of earningsWindowTickers) {
    if (allTickers.includes(t) && !nullFieldsMap.has(t)) nullFieldsMap.set(t, new Set());
  }
  const tickersWithNulls = [...nullFieldsMap.keys()];
  log(`Tickers with ≥1 null fundamental field (or earnings force): ${tickersWithNulls.length}`);

  // 4. Which sources can fill which fields
  const sourceFieldMap = buildSourceFieldMap();

  // 5. Check remaining budgets
  budgets = await getRemainingBudgets(SOURCE_ORDER, SOURCE_DAILY_LIMITS);
  // Share api_usage source=av with transcripts.py (≤20/day) — OVERVIEW takes ≤5 leftover.
  const avRem = budgets.get("alpha_vantage");
  if (avRem != null && avRem !== Infinity) {
    budgets.set("alpha_vantage", Math.min(avRem, AV_OVERVIEW_DAILY_CAP));
  }
  if (!AV_API_KEY) {
    budgets.set("alpha_vantage", 0);
    log("alpha_vantage: ALPHA_VANTAGE_API_KEY unset — OVERVIEW leg disabled");
  }
  log("API budgets today:");
  for (const src of SOURCE_ORDER) {
    const rem = budgets.get(src)!;
    log(`  ${src.padEnd(14)} remaining: ${rem === Infinity ? "∞" : rem}`);
  }

  // 6. Build per-source fetch plan (empty if no nulls — FactSet referee still runs later)
  log("Building fetch plan (checking source_fundamentals + staging freshness)…");
  fetchPlan = tickersWithNulls.length > 0
    ? await buildFetchTargets(nullFieldsMap, sourceFieldMap)
    : new Map(SOURCE_ORDER.map(s => [s, [] as string[]]));
  for (const src of SOURCE_ORDER) {
    log(`[${src}] ${fetchPlan.get(src)?.length ?? 0} tickers need enrichment`);
  }

  } catch (err: any) {
    log(`FATAL during setup phase — ${err?.message}`);
    await recordRun({ startedAt: runStartedAt, status: "failed", trigger, coverageBefore, coverageAfter: null, error: err?.message ?? String(err) });
    throw err;
  }

  // 8. Process each source in order
  const totals: Record<string, { fetched: number; skippedBudget: number; failed: number; nodata: number }> = {};
  let anyFetched = false;

  for (const src of SOURCE_ORDER) {
    const targets   = fetchPlan.get(src) ?? [];
    const remaining = budgets.get(src)!;

    if (targets.length === 0) { log(`[${src}] no candidates — skip`); continue; }
    if (remaining === 0)      { log(`[${src}] budget exhausted — skip`); continue; }

    const result = await processSource(src, targets, remaining);
    totals[src] = result;
    if (result.fetched > 0) anyFetched = true;
  }

  // 9. Summary
  log("\n── nightly-enrichment summary ──────────────────────────────────");
  for (const src of SOURCE_ORDER) {
    if (!totals[src]) continue;
    const t = totals[src];
    log(`  ${src.padEnd(14)} fetched=${t.fetched}  nodata=${t.nodata}  failed=${t.failed}  budget_skipped=${t.skippedBudget}`);
  }

  let pipelineError: string | null = null;

  if (!anyFetched || DRY_RUN) {
    log("No new free-source data fetched — skipping free populate + merge.");
  } else {
    // 10 + 11. Materialize staging → source_fundamentals → ticker_fundamentals (in-process).
    log("\nRunning populate-source-fundamentals (in-process)…");
    try {
      await runPopulateSourceFundamentals();
    } catch (err: any) {
      pipelineError = `populate-source-fundamentals failed: ${err?.message ?? String(err)}`;
      log(`ERROR: ${pipelineError}`);
    }

    if (!pipelineError) {
      log("\nRunning merge-trusted (in-process)…");
      try {
        await runMergeTrusted();
      } catch (err: any) {
        pipelineError = `merge-trusted failed: ${err?.message ?? String(err)}`;
        log(`ERROR: ${pipelineError}`);
      }
    }
  }

  // 12. FactSet referee — nulls + divergences (budget-capped). Re-merge if anything written.
  if (!DRY_RUN && !pipelineError) {
    log("\nRunning FactSet referee (nulls/divergences)…");
    try {
      const fsResult = await runFactsetReferee({});
      totals["factset"] = {
        fetched: fsResult.fetched,
        skippedBudget: fsResult.skippedBudget,
        failed: fsResult.failed,
        nodata: 0,
      };
      if (fsResult.fieldsWritten > 0) {
        log(`FactSet wrote ${fsResult.fieldsWritten} source fields — re-running merge-trusted…`);
        await runMergeTrusted();
      } else {
        log(`FactSet referee: fetched=${fsResult.fetched} fields=0`);
      }
    } catch (err: any) {
      pipelineError = `factset-referee failed: ${err?.message ?? String(err)}`;
      log(`ERROR: ${pipelineError}`);
    }
  }

  // Classify any scored ticker still missing a peer group. Nothing else does this
  // proactively: classifyTicker() is lazy (called from request paths), while scoring
  // reads ticker_registry.primary_peer_group_id directly. A ticker added to the
  // registry outside the curated sector_taxonomy.json import therefore stayed NULL
  // forever, and a NULL peer group silently means "no sector-relative percentile" —
  // that ticker's metrics get scored 100% universe-wide while its peers are scored
  // 55-70% sector-relative (see SECTOR_WEIGHT in fundamentals-db.ts).
  // Runs AFTER the fetch loop so sector/industry just pulled this run is available
  // to the keyword-map tier of the classifier.
  await classifyUngroupedTickers();

  const coverageAfter = await computeCoveragePercent().catch((err: any) => {
    log(`WARN: failed to compute post-run coverage snapshot: ${err?.message}`);
    return null;
  });
  const anomaly = await detectNodataAnomaly(totals).catch(() => null);
  const regressed = coverageBefore != null && coverageAfter != null && coverageAfter < coverageBefore;
  const status: "success" | "partial" = (pipelineError || anomaly || regressed) ? "partial" : "success";
  if (pipelineError) log(`WARN: enrichment pipeline degraded — ${pipelineError}`);
  if (anomaly)   log(`WARN: nodata anomaly detected — ${anomaly}`);
  if (regressed) log(`WARN: coverage dropped ${coverageBefore}% → ${coverageAfter}%`);
  await recordRun({ startedAt: runStartedAt, status, trigger, perSource: totals, coverageBefore, coverageAfter, error: pipelineError ?? undefined });

  log("\nnightly-enrichment complete.");
}

export { main as runNightlyEnrichment };

// Run directly when invoked as a script — process.exit here is fine, this branch
// only executes for a short-lived `npx tsx nightly-enrichment.ts` CLI invocation.
// main() itself must never call process.exit: it also runs inside the long-lived
// api-server process via scheduler.ts, where exiting would kill the whole server.
const isMain = process.argv[1]?.includes("nightly-enrichment");
if (isMain) {
  const triggerArg = process.argv.find((a) => a.startsWith("--trigger="));
  const triggerRaw = triggerArg?.split("=")[1] ?? "manual";
  const trigger =
    triggerRaw === "scheduled" || triggerRaw === "maintain_full" || triggerRaw === "manual"
      ? triggerRaw
      : "manual";
  main(trigger)
    .then(() => process.exit(0))
    .catch(err => {
      log(`FATAL — ${err.message}`);
      process.exit(1);
    });
}
