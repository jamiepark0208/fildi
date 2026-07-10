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
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sql, eq, and, inArray, isNull } from "drizzle-orm";
import {
  db,
  tickerRegistry,
  tickerFundamentals,
  yahooFundamentals,
  edgarFundamentals,
  finnhubFundamentals,
  polygonFundamentals,
  avFundamentals,
  fmpFundamentals,
  sourceFundamentals,
  apiUsage,
  peerGroupMembers,
} from "@workspace/db";
import { FIELD_DEFS } from "./merge-trusted.js";
import { fetchYahooFundamentals }   from "../lib/yahoo-client.js";
import { fetchEdgarFundamentals, bootstrapCikCache } from "../lib/edgar-client.js";
import { fetchFinnhubFundamentals }  from "../lib/finnhub-client.js";
import { fetchPolygonFundamentals }  from "../lib/polygon-client.js";
import { fetchAVOverview }           from "../lib/alpha-vantage-client.js";
import { fetchFMPFundamentals }      from "../lib/fmp-client.js";
import { recordApiUsage }            from "../lib/api-usage.js";
import { checkFMPBudget, recordFMPCalls } from "../lib/fundamentals-db.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const DRY_RUN    = process.argv.includes("--dry-run");
const STALE_DAYS = 7;

// bug/9: peers of an added ticker used to get fetchFundamentals=true synchronously
// on every POST /watchlist (unbounded — one add could flag an entire peer group).
// That flip now happens here instead, capped per run so a large backlog of newly
// unflagged peers can't blow the nightly budget in one pass.
const PEER_EXPANSION_CAP = 25;

// --fields dividendYield,epsGrowth  → restrict to only these tfCol names (for testing)
const FIELDS_ARG = process.argv.find(a => a.startsWith("--fields="))?.split("=")[1];
const FIELD_FILTER: Set<string> | null = FIELDS_ARG
  ? new Set(FIELDS_ARG.split(",").map(s => s.trim()))
  : null;

const AV_API_KEY      = process.env.AV_API_KEY      ?? "";
const FMP_API_KEY     = process.env.FMP_API_KEY     ?? "";
const POLYGON_API_KEY = process.env.POLYGON_API_KEY ?? "";

// Daily call limits (Infinity = no hard limit, rate-limited only)
const SOURCE_DAILY_LIMITS: Record<string, number> = {
  yahoo:         Infinity,
  edgar:         Infinity,
  finnhub:       Infinity,
  polygon:       Infinity,
  alpha_vantage: 25,
  fmp:           220,
};

// Calls consumed per ticker-fetch (for budget math)
const CALLS_PER_TICKER: Record<string, number> = {
  yahoo: 1, edgar: 1, finnhub: 1, polygon: 1, alpha_vantage: 1,
  fmp: 9,   // fetchFMPFundamentals fires 9 endpoints
};

// Rate-limit sleeps
const BATCH_SLEEP_MS: Record<string, number> = {
  yahoo: 1000, edgar: 3500, finnhub: 3500, polygon: 12000,
  alpha_vantage: 12000, fmp: 1000,
};

const BATCH_CONCURRENT: Record<string, number> = {
  yahoo: 3, edgar: 3, finnhub: 3, polygon: 1, alpha_vantage: 1, fmp: 1,
};

// Process order: cheapest first
const SOURCE_ORDER = ["yahoo", "edgar", "finnhub", "polygon", "alpha_vantage", "fmp"];

// ── Logging ────────────────────────────────────────────────────────────────────

const today   = new Date().toISOString().slice(0, 10);
const logDir  = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const logFile = path.join(logDir, `nightly-enrichment-${today}.log`);
fs.mkdirSync(logDir, { recursive: true });

function log(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(logFile, stamped + "\n");
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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

  for (const row of rows) {
    const nulls = new Set<string>();
    for (const col of covered) {
      if ((row as any)[col] === null || (row as any)[col] === undefined) {
        nulls.add(col);
      }
    }
    if (nulls.size > 0) result.set(row.ticker, nulls);
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

  // Load staging freshness for all sources in one pass
  const [yahooRows, edgarRows, finnhubRows, polyRows, avRows, fmpRows] = await Promise.all([
    db.select({ ticker: yahooFundamentals.ticker, fetchedAt: yahooFundamentals.fetchedAt }).from(yahooFundamentals).where(inArray(yahooFundamentals.ticker, tickers)),
    db.select({ ticker: edgarFundamentals.ticker, fetchedAt: edgarFundamentals.fetchedAt }).from(edgarFundamentals).where(inArray(edgarFundamentals.ticker, tickers)),
    db.select({ ticker: finnhubFundamentals.ticker, fetchedAt: finnhubFundamentals.fetchedAt }).from(finnhubFundamentals).where(inArray(finnhubFundamentals.ticker, tickers)),
    db.select({ ticker: polygonFundamentals.ticker, fetchedAt: polygonFundamentals.fetchedAt }).from(polygonFundamentals).where(inArray(polygonFundamentals.ticker, tickers)),
    db.select({ ticker: avFundamentals.ticker, fetchedAt: avFundamentals.fetchedAt }).from(avFundamentals).where(inArray(avFundamentals.ticker, tickers)),
    db.select({ ticker: fmpFundamentals.ticker, fetchedAt: fmpFundamentals.fetchedAt, fmpWacc: fmpFundamentals.fmpWacc, fmpRoic: fmpFundamentals.fmpRoic }).from(fmpFundamentals).where(inArray(fmpFundamentals.ticker, tickers)),
  ]);

  // Build staging-freshness maps: source → Set<ticker> that are fresh
  const stagingFresh = new Map<string, Set<string>>();
  function freshSet(rows: { ticker: string; fetchedAt: Date | null }[], extra?: (r: any) => boolean): Set<string> {
    return new Set(rows.filter(r => {
      if (!r.fetchedAt || r.fetchedAt < staleThreshold) return false;
      return !extra || !extra(r);
    }).map(r => r.ticker));
  }
  stagingFresh.set("yahoo",         freshSet(yahooRows));
  stagingFresh.set("edgar",         freshSet(edgarRows));
  stagingFresh.set("finnhub",       freshSet(finnhubRows));
  stagingFresh.set("polygon",       freshSet(polyRows));
  stagingFresh.set("alpha_vantage", freshSet(avRows));
  stagingFresh.set("fmp",           freshSet(fmpRows, r => r.fmpWacc === null && r.fmpRoic === null));

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

    const targets = tickers.filter(ticker => {
      const nullTfCols = nullFieldsMap.get(ticker)!;
      // Fields this source could fill for this ticker's nulls
      const needed = [...nullTfCols].filter(f => coverableFields.has(f));
      if (needed.length === 0) return false;

      const sourceSfFields = sfIndex.get(ticker)?.get(src) ?? new Set<string>();

      // Check which needed tfCols are already covered by non-null source_fundamentals entries
      const alreadyCovered = needed.filter(tfCol => {
        // Find the sfField(s) this source uses for this tfCol
        for (const [sfField, mappedTfCol] of sfFieldToTfCol) {
          if (mappedTfCol === tfCol && sourceSfFields.has(sfField)) return true;
        }
        return false;
      });

      if (alreadyCovered.length === needed.length) {
        // All needed fields already in source_fundamentals → just re-run populate+merge, no API call
        return false;
      }

      // If staging is fresh AND source has at least some data in sf → source returned null recently
      if (isStagingFresh.has(ticker) && sourceSfFields.size > 0) return false;

      return true;
    });

    result.set(src, targets);
  }

  return result;
}

// ── Budget check ───────────────────────────────────────────────────────────────

async function getRemainingBudgets(): Promise<Map<string, number>> {
  const rows = await db.execute<{ source: string; calls_made: number }>(
    sql`SELECT source, calls_made FROM api_usage WHERE date = current_date`
  );
  const usedToday = new Map<string, number>(rows.rows.map(r => [r.source, r.calls_made]));
  const remaining = new Map<string, number>();
  for (const src of SOURCE_ORDER) {
    const limit = SOURCE_DAILY_LIMITS[src];
    const used  = usedToday.get(src) ?? 0;
    remaining.set(src, limit === Infinity ? Infinity : Math.max(0, limit - used));
  }
  return remaining;
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
    yahooAnnualCash:              data.yahoo_annualCash?.toString()              ?? null,
    yahooAnnualTotalDebt:         data.yahoo_annualTotalDebt?.toString()         ?? null,
    yahooAnnualTotalEquity:       data.yahoo_annualTotalEquity?.toString()       ?? null,
    yahooAnnualOperatingCashFlow: data.yahoo_annualOperatingCashFlow?.toString() ?? null,
    yahooAnnualCapex:             data.yahoo_annualCapex?.toString()             ?? null,
    yahooAnnualFreeCashFlow:      data.yahoo_annualFreeCashFlow?.toString()      ?? null,
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
    yahooAnnualCash:              sql`excluded.yahoo_annual_cash`,
    yahooAnnualTotalDebt:         sql`excluded.yahoo_annual_total_debt`,
    yahooAnnualTotalEquity:       sql`excluded.yahoo_annual_total_equity`,
    yahooAnnualOperatingCashFlow: sql`excluded.yahoo_annual_operating_cash_flow`,
    yahooAnnualCapex:             sql`excluded.yahoo_annual_capex`,
    yahooAnnualFreeCashFlow:      sql`excluded.yahoo_annual_free_cash_flow`,
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
  }).onConflictDoUpdate({ target: edgarFundamentals.ticker, set: {
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
  }});
  return "ok";
}

async function fetchFinnhub(ticker: string): Promise<"ok" | "fail" | "nodata"> {
  const data = await fetchFinnhubFundamentals(ticker);
  const nonNull = Object.values(data as Record<string,unknown>).filter(v => v != null).length;
  if (nonNull === 0) return "nodata";
  await db.insert(finnhubFundamentals).values({
    ticker, fetchedAt: new Date(),
    finnhubPeRatio:               data.finnhub_peRatio?.toString()              ?? null,
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

async function fetchPolygon(ticker: string): Promise<"ok" | "fail" | "nodata"> {
  const data = await fetchPolygonFundamentals(ticker, POLYGON_API_KEY);
  const nonNull = Object.values(data as Record<string,unknown>).filter(v => v != null).length;
  if (nonNull === 0) return "nodata";
  await db.insert(polygonFundamentals).values({
    ticker, fetchedAt: new Date(),
    polygonTotalRevenue:               data.totalRevenue              != null ? String(data.totalRevenue)              : null,
    polygonNetIncome:                  data.netIncome                 != null ? String(data.netIncome)                 : null,
    polygonInterestExpense:            data.interestExpense           != null ? String(data.interestExpense)           : null,
    polygonGrossMargin:                data.grossMargin               != null ? String(data.grossMargin)               : null,
    polygonOperatingMargin:            data.operatingMargin           != null ? String(data.operatingMargin)           : null,
    polygonTotalDebt:                  data.totalDebt                 != null ? String(data.totalDebt)                 : null,
    polygonTotalStockholdersEquity:    data.totalStockholdersEquity   != null ? String(data.totalStockholdersEquity)   : null,
    polygonQuarterlyOperatingCashFlow: data.quarterlyOperatingCashFlow != null ? String(data.quarterlyOperatingCashFlow) : null,
  }).onConflictDoUpdate({ target: polygonFundamentals.ticker, set: {
    fetchedAt:                         sql`now()`,
    polygonTotalRevenue:               sql`excluded.polygon_total_revenue`,
    polygonNetIncome:                  sql`excluded.polygon_net_income`,
    polygonInterestExpense:            sql`excluded.polygon_interest_expense`,
    polygonGrossMargin:                sql`excluded.polygon_gross_margin`,
    polygonOperatingMargin:            sql`excluded.polygon_operating_margin`,
    polygonTotalDebt:                  sql`excluded.polygon_total_debt`,
    polygonTotalStockholdersEquity:    sql`excluded.polygon_total_stockholders_equity`,
    polygonQuarterlyOperatingCashFlow: sql`excluded.polygon_quarterly_operating_cash_flow`,
  }});
  return "ok";
}

async function fetchAV(ticker: string): Promise<"ok" | "fail" | "nodata"> {
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
  const data = await fetchFMPFundamentals(ticker, FMP_API_KEY, "nightly-enrichment", true);
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
    fmpWacc:                       n(data.wacc),
    fmpRoic:                       n(data.roic),
    fmpQuarterlyOperatingCashFlow: n(data.quarterlyOperatingCashFlow),
    fmpSharesOutstanding:          n(data.sharesOutstanding),
    fmpSharesOutstandingPrior:     n(data.sharesOutstandingPrior),
    fmpDividendYield:              n(data.dividendYield),
    fmpBeta:                       n(data.beta),
  }).onConflictDoUpdate({ target: fmpFundamentals.ticker, set: {
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
  }});
  return "ok";
}

// ── Per-source dispatch ────────────────────────────────────────────────────────

const FETCH_FN: Record<string, (ticker: string) => Promise<"ok" | "fail" | "nodata">> = {
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
  const toFetch        = tickers.slice(0, maxTickers);
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
        const status = await fn(t);
        if (status === "ok") {
          await recordApiUsage(source, callsPerTicker).catch(() => {});
          log(`[${source}][${t}] OK`);
          return "ok";
        }
        if (status === "nodata") {
          log(`[${source}][${t}] NODATA`);
          return "nodata";
        }
        return "ok";
      } catch (err: any) {
        // AV quota exhaustion stops the whole source
        if (source === "alpha_vantage" && err?.message?.includes("AV API limit")) {
          await recordApiUsage("av", 1).catch(() => {});
          log(`[${source}][${t}] QUOTA — ${err.message}`);
          return "quota";
        }
        // FMP: use checkFMPBudget before each fetch was already done above; record on error too
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

async function main(): Promise<void> {
  log(`nightly-enrichment starting${DRY_RUN ? " (DRY RUN)" : ""}${FIELD_FILTER ? ` [fields: ${[...FIELD_FILTER].join(",")}]` : ""}`);

  // 1. Get canonical ticker universe
  const flaggedTickers = (await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(eq(tickerRegistry.fetchFundamentals, true))
    .orderBy(tickerRegistry.ticker))
    .map(r => r.ticker);
  log(`Universe: ${flaggedTickers.length} tickers (fetch_fundamentals=true)`);

  // 1b. bug/9 — expand to peers of the flagged universe that aren't flagged yet,
  // capped per run, and flip fetch_fundamentals=true for them now (before the
  // fetch pipeline + merge-trusted run below) so peer-relative scoring picks
  // them up this same pass instead of needing a second nightly cycle.
  const peerGroupIds = flaggedTickers.length > 0
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

  // 2. Bootstrap Edgar CIK cache
  log("Bootstrapping EDGAR CIK cache…");
  const cikCount = await bootstrapCikCache();
  log(`EDGAR CIK cache: ${cikCount} entries`);

  // 3. Find null fields in ticker_fundamentals
  const nullFieldsMap = await findNullFields(allTickers);
  const tickersWithNulls = [...nullFieldsMap.keys()];
  log(`Tickers with ≥1 null fundamental field: ${tickersWithNulls.length}`);
  if (tickersWithNulls.length === 0) { log("Nothing to enrich — all fields populated."); process.exit(0); }

  // 4. Which sources can fill which fields
  const sourceFieldMap = buildSourceFieldMap();

  // 5. Check remaining budgets
  const budgets = await getRemainingBudgets();
  log("API budgets today:");
  for (const src of SOURCE_ORDER) {
    const rem = budgets.get(src)!;
    log(`  ${src.padEnd(14)} remaining: ${rem === Infinity ? "∞" : rem}`);
  }

  // 6. Build per-source fetch plan: checks source_fundamentals + staging freshness
  //    before including a ticker, so we never call an API for data already in the DB
  log("Building fetch plan (checking source_fundamentals + staging freshness)…");
  const fetchPlan = await buildFetchTargets(nullFieldsMap, sourceFieldMap);
  for (const src of SOURCE_ORDER) {
    log(`[${src}] ${fetchPlan.get(src)?.length ?? 0} tickers need enrichment`);
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

  if (!anyFetched || DRY_RUN) {
    log("No new data fetched — skipping populate + merge.");
    process.exit(0);
  }

  // 10. Repopulate source_fundamentals from staging tables
  log("\nRunning populate-source-fundamentals…");
  const scriptDir = path.resolve(new URL(import.meta.url).pathname, "..");
  try {
    execFileSync("npx", ["tsx", path.join(scriptDir, "populate-source-fundamentals.ts")], {
      stdio: "inherit",
      cwd: path.resolve(scriptDir, "../.."),
      timeout: 120_000,
    });
  } catch (err: any) {
    log(`WARN: populate-source-fundamentals failed: ${err?.message}`);
  }

  // 11. Merge into ticker_fundamentals
  log("\nRunning merge-trusted…");
  try {
    execFileSync("npx", ["tsx", path.join(scriptDir, "merge-trusted.ts")], {
      stdio: "inherit",
      cwd: path.resolve(scriptDir, "../.."),
      timeout: 120_000,
    });
  } catch (err: any) {
    log(`WARN: merge-trusted failed: ${err?.message}`);
  }

  log("\nnightly-enrichment complete.");
  process.exit(0);
}

export { main as runNightlyEnrichment };

// Run directly when invoked as a script
const isMain = process.argv[1]?.includes("nightly-enrichment");
if (isMain) {
  main().catch(err => {
    log(`FATAL — ${err.message}`);
    process.exit(1);
  });
}
