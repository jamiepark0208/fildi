/**
 * Populate source_fundamentals from all four staging tables that currently have data.
 * One row per (ticker, source, field) with camelCase canonical field names.
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/populate-source-fundamentals.ts
 */

import { sql } from "drizzle-orm";
import {
  db,
  yahooFundamentals,
  edgarFundamentals,
  finnhubFundamentals,
  fmpFundamentals,
  polygonFundamentals,
  avFundamentals,
  sourceFundamentals,
} from "@workspace/db";
import { finnhubFieldTimelinessMs, finnhubQuarterlyOrAnnual } from "../lib/finnhub-metric-period.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SEC_SYNC_PY = join(REPO_ROOT, "scripts/watchlist_sync/dcf/sec_gold_fields.py");
const WATCHLIST_VENV = join(REPO_ROOT, "scripts/watchlist_sync/.venv/bin/python");

type Row = Record<string, unknown>;

// ── Field maps: JS property name → canonical camelCase field name ─────────────

const YAHOO_FIELDS: Record<string, string> = {
  yahooGrossMargins:          "grossMargin",
  yahooOperatingMargins:      "operatingMargin",
  yahooProfitMargins:         "netMargin",
  yahooReturnOnEquity:        "returnOnEquity",
  yahooReturnOnAssets:        "returnOnAssets",
  yahooRevenueGrowth:         "revenueGrowth",
  yahooDebtToEquity:          "debtToEquity",
  yahooCurrentRatio:          "currentRatio",
  yahooTotalRevenue:          "totalRevenue",
  yahooTotalDebt:             "totalDebt",
  yahooTotalCash:             "totalCash",
  yahooFreeCashflow:          "freeCashFlow",
  yahooOperatingCashflow:     "operatingCashFlow",
  yahooEbitda:                "ebitda",
  yahooDividendYield:         "dividendYield",
  yahooTargetMeanPrice:       "analystTargetPrice",
  yahooTrailingPe:            "peRatio",
  yahooForwardPe:             "forwardPe",
  yahooPegRatio:              "pegRatio",
  yahooPriceToBook:           "priceToBook",
  yahooEnterpriseToEbitda:    "evEbitda",
  yahooEnterpriseToRevenue:   "evRevenue",
  yahooTrailingEps:           "trailingEps",
  yahooForwardEps:            "forwardEps",
  yahooBeta:                  "beta",
  yahooSharesOutstanding:     "sharesOutstanding",
  yahooFloatShares:           "floatShares",
  yahooHeldPercentInsiders:   "heldPercentInsiders",
  yahooShortRatio:            "shortRatio",
  yahooAnnualTotalRevenue:    "annualTotalRevenue",
  yahooAnnualGrossProfit:     "annualGrossProfit",
  yahooAnnualEbit:            "annualEbit",
  yahooAnnualNetIncome:       "annualNetIncome",
  yahooAnnualRevenueYoy:      "annualRevenueYoy",
  yahooAnnualRevenueYoyPrior: "revenueGrowthYoyPrior",
  yahooAnnualCash:            "annualCash",
  yahooAnnualTotalDebt:       "annualTotalDebt",
  yahooAnnualTotalEquity:     "annualTotalEquity",
  yahooAnnualOperatingCashFlow: "annualOperatingCashFlow",
  yahooAnnualCapex:           "annualCapex",
  yahooAnnualFreeCashFlow:    "annualFreeCashFlow",
  yahooEpsGrowth:             "epsGrowth",
  yahooSharesOutstandingPrior:"sharesOutstandingPrior",
  yahooEffectiveTaxRate:      "effectiveTaxRate",
  yahooInterestExpense:       "interestExpense",
  yahooQuarterlyOcf:          "quarterlyOperatingCashFlow",
  yahooRoic:                  "roic",
  yahooWacc:                  "wacc",
};

const EDGAR_FIELDS: Record<string, string> = {
  edgarTotalRevenue:       "totalRevenue",
  edgarGrossProfit:        "grossProfit",
  edgarNetIncome:          "netIncome",
  edgarEbit:               "ebit",
  edgarEbitda:             "ebitda",
  edgarFreeCashFlow:       "freeCashFlow",
  edgarOperatingCashFlow:  "operatingCashFlow",
  edgarCapitalExpenditure: "capitalExpenditure",
  edgarCashAndEquivalents: "cashAndEquivalents",
  edgarTotalDebt:          "totalDebt",
  edgarTotalEquity:        "totalEquity",
  edgarInterestExpense:    "interestExpense",
  edgarSharesOutstanding:  "sharesOutstanding",
  edgarGrossMargin:        "grossMargin",
  edgarNetMargin:          "netMargin",
  edgarDepreciationAmortization: "depreciationAmortization",
};

const FINNHUB_FIELDS: Record<string, string> = {
  finnhubPeRatio:               "peRatio",
  finnhubPegRatio:              "forwardPeg", // Finnhub forwardPEG — not trailing pegRatio
  finnhubPbRatio:               "pbRatio",
  finnhubPsRatio:               "psRatio",
  finnhubPriceToBook:           "priceToBook",
  finnhubEv:                    "ev",
  finnhubMarketCap:             "marketCap",
  finnhubGrossMargin:           "grossMargin",
  finnhubOperatingMargin:       "operatingMargin",
  finnhubNetMargin:             "netMargin",
  finnhubFcfMargin:             "fcfMargin",
  finnhubReturnOnEquity:        "returnOnEquity",
  finnhubReturnOnAssets:        "returnOnAssets",
  finnhubRoic:                  "roic",
  finnhubRevenueGrowth:         "revenueGrowth",
  finnhubEpsGrowth:             "epsGrowth",
  finnhubDebtToEquity:          "debtToEquity",
  finnhubLongTermDebtToEquity:  "longTermDebtToEquity",
  finnhubNetDebtToEquity:       "netDebtToEquity",
  finnhubCurrentRatio:          "currentRatio",
  finnhubQuickRatio:            "quickRatio",
  finnhubFcfPerShare:           "fcfPerShare",
  finnhubBookValue:             "bookValue",
  finnhubTangibleBookValuePerShare: "tangibleBookValuePerShare",
  finnhubBeta:                  "beta",
  finnhubEps:                   "eps",
  finnhubEbitPerShare:          "ebitPerShare",
  finnhubEarningsPerShare:      "earningsPerShare",
  finnhub52weekHigh:            "weekHigh52",
  finnhub52weekLow:             "weekLow52",
  finnhubDividendYield:         "dividendYield",
};

const POLYGON_FIELDS: Record<string, string> = {
  polygonTotalRevenue:               "totalRevenue",
  polygonNetIncome:                  "netIncome",
  polygonInterestExpense:            "interestExpense",
  polygonGrossMargin:                "grossMargin",
  polygonOperatingMargin:            "operatingMargin",
  polygonTotalDebt:                  "totalDebt",
  polygonTotalStockholdersEquity:    "totalStockholdersEquity",
  polygonQuarterlyOperatingCashFlow: "operatingCashFlow",
};

const AV_FIELDS: Record<string, string> = {
  avPeRatio:            "peRatio",
  avPegRatio:           "pegRatio",
  avForwardPe:          "forwardPe",
  avPbRatio:            "priceToBook",
  avDividendYield:      "dividendYield",
  avAnalystTargetPrice: "analystTargetPrice",
  avNetMargin:          "netMargin",
  avOperatingMargin:    "operatingMargin",
  avReturnOnEquity:     "returnOnEquity",
  avTotalRevenue:       "totalRevenue",
  avEbitda:             "ebitda",
  avBeta:               "beta",
};

const FMP_FIELDS: Record<string, string> = {
  fmpPeRatio:                    "peRatio",
  fmpPegRatio:                   "pegRatio",
  fmpForwardPe:                  "forwardPe",
  fmpEvEbitda:                   "evEbitda",
  fmpEvRevenue:                  "evRevenue",
  fmpPriceToBook:                "priceToBook",
  fmpPriceToSales:               "priceToSales",
  fmpTangibleBookValuePerShare:  "tangibleBookValuePerShare",
  fmpAnalystTargetPrice:         "analystTargetPrice",
  fmpRevenueGrowthYoY:           "revenueGrowthYoY",
  fmpRevenueGrowthYoyPrior:      "revenueGrowthYoyPrior",
  fmpEpsGrowth:                  "epsGrowth",
  fmpEarningsPerShare:           "earningsPerShare",
  fmpGrossMargin:                "grossMargin",
  fmpOperatingMargin:            "operatingMargin",
  fmpNetMargin:                  "netMargin",
  fmpReturnOnEquity:             "returnOnEquity",
  fmpReturnOnAssets:             "returnOnAssets",
  fmpEffectiveTaxRate:           "effectiveTaxRate",
  fmpTotalRevenue:               "totalRevenue",
  fmpNetIncome:                  "netIncome",
  fmpEbitda:                     "ebitda",
  fmpEbit:                       "ebit",
  fmpInterestExpense:            "interestExpense",
  fmpFreeCashFlow:               "freeCashFlow",
  fmpCurrentRatio:               "currentRatio",
  fmpDebtToEquity:               "debtToEquity",
  fmpTotalDebt:                  "totalDebt",
  fmpTotalStockholdersEquity:    "totalStockholdersEquity",
  fmpCashAndEquivalents:         "cashAndEquivalents",
  fmpTotalAssets:                "totalAssets",
  fmpGrossProfit:                "grossProfit",
  fmpWacc:                       "wacc",
  fmpRoic:                       "roic",
  fmpQuarterlyOperatingCashFlow: "quarterlyOperatingCashFlow",
  fmpAnnualOperatingCashFlow:    "annualOperatingCashFlow",
  fmpSharesOutstanding:          "sharesOutstanding",
  fmpSharesOutstandingPrior:     "sharesOutstandingPrior",
  fmpDividendYield:              "dividendYield",
  fmpBeta:                       "beta",
};

// ── Rejection rules (applied before writing to source_fundamentals) ───────────
// These mirror the SQL cleanup run on 2026-07-04. Any future backfill passes
// through these guards so invalid values are never written.

type RejectionRule = { fields: string[]; test: (v: number) => boolean; reason: string };

const REJECTION_RULES: RejectionRule[] = [
  {
    fields: ["grossMargin", "operatingMargin", "netMargin"],
    test: (v) => v > 1.0 || v < -1.0,
    reason: "margin outside [-1, 1] range",
  },
  {
    fields: ["returnOnEquity", "returnOnAssets"],
    test: (v) => Math.abs(v) > 2.0,
    reason: "|ROE/ROA| > 2.0 (200%)",
  },
  {
    fields: ["currentRatio", "priceToBook", "peRatio"],
    test: (v) => v < 0,
    reason: "ratio cannot be negative",
  },
];

function isRejected(field: string, value: number): boolean {
  for (const rule of REJECTION_RULES) {
    if (rule.fields.includes(field) && rule.test(value)) return true;
  }
  return false;
}

// ── Core function ─────────────────────────────────────────────────────────────

async function populateFromTable(
  rows: Row[],
  source: string,
  fieldMap: Record<string, string>,
  fetchedAtKey: string,
  transforms: Record<string, (v: number) => number> = {},
  fetchedAtForField?: (row: Row, canonical: string, defaultAt: Date) => Date,
  valueOverride?: (row: Row, canonical: string, numVal: number) => number | undefined,
) {
  let tickers = 0;
  let totalFields = 0;
  let rejected = 0;

  for (const row of rows) {
    const ticker = row["ticker"] as string;
    const fetchedAt = (row[fetchedAtKey] as Date | null) ?? new Date();
    const batch: { ticker: string; source: string; field: string; value: string; fetchedAt: Date }[] = [];

    for (const [prop, canonical] of Object.entries(fieldMap)) {
      const val = row[prop];
      if (val === null || val === undefined) continue;
      let numVal = typeof val === "string" ? parseFloat(val) : Number(val);
      if (!isFinite(numVal)) continue;
      const overridden = valueOverride?.(row, canonical, numVal);
      if (overridden !== undefined && isFinite(overridden)) numVal = overridden;
      if (transforms[canonical]) numVal = transforms[canonical](numVal);
      if (isRejected(canonical, numVal)) { rejected++; continue; }
      const at = fetchedAtForField?.(row, canonical, fetchedAt) ?? fetchedAt;
      batch.push({ ticker, source, field: canonical, value: String(numVal), fetchedAt: at });
    }

    if (batch.length === 0) continue;

    // Bulk upsert in one query per ticker
    await db
      .insert(sourceFundamentals)
      .values(batch)
      .onConflictDoUpdate({
        target: [sourceFundamentals.ticker, sourceFundamentals.source, sourceFundamentals.field],
        set: {
          value:     sql`excluded.value`,
          fetchedAt: sql`excluded.fetched_at`,
        },
      });

    tickers++;
    totalFields += batch.length;
  }

  return { tickers, totalFields, rejected };
}

async function loadFinnhubMetricByTicker(tickers: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (tickers.length === 0) return out;
  const res = await db.execute(sql`
    SELECT DISTINCT ON (key) key AS ticker, payload->'metric' AS metric
    FROM vendor_raw
    WHERE source = 'finnhub'
      AND endpoint = '/api/v1/stock/metric?metric=all'
      AND key IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})
    ORDER BY key, fetched_on DESC
  `);
  const list = (Array.isArray(res) ? res : (res as unknown as { rows?: { ticker: string; metric: unknown }[] }).rows) ?? [];
  for (const row of list) {
    const m = row.metric;
    if (m && typeof m === "object") out.set(String(row.ticker).toUpperCase(), m as Record<string, unknown>);
  }
  return out;
}

export async function syncSecSourceFundamentals(tickers?: string[]): Promise<void> {
  const py = WATCHLIST_VENV;
  const args = tickers?.length ? tickers : ["--scored-book"];
  await execFileAsync(py, [SEC_SYNC_PY, ...args], {
    cwd: REPO_ROOT,
    timeout: 600_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runPopulateSourceFundamentals() {
  const [yahooRows, edgarRows, finnhubRows, fmpRows, polygonRows, avRows] = await Promise.all([
    db.select().from(yahooFundamentals),
    db.select().from(edgarFundamentals),
    db.select().from(finnhubFundamentals),
    db.select().from(fmpFundamentals),
    db.select().from(polygonFundamentals),
    db.select().from(avFundamentals),
  ]);

  console.log(`Loaded: yahoo=${yahooRows.length} edgar=${edgarRows.length} finnhub=${finnhubRows.length} fmp=${fmpRows.length} polygon=${polygonRows.length} av=${avRows.length}`);

  console.log("\nPopulating from yahoo_fundamentals …");
  const yahoo = await populateFromTable(yahooRows as Row[], "yahoo", YAHOO_FIELDS, "fetchedAt");
  console.log(`  → ${yahoo.tickers} tickers, ${yahoo.totalFields} fields, ${yahoo.rejected} rejected`);

  console.log("Populating from edgar_fundamentals …");
  const edgar = await populateFromTable(edgarRows as Row[], "edgar", EDGAR_FIELDS, "fetchedAt");
  console.log(`  → ${edgar.tickers} tickers, ${edgar.totalFields} fields, ${edgar.rejected} rejected`);

  console.log("Populating from finnhub_fundamentals …");
  const finnhubMetrics = await loadFinnhubMetricByTicker(
    (finnhubRows as Row[]).map((r) => String(r["ticker"]).toUpperCase()),
  );
  const finnhubTimelinessFields = new Set(["currentRatio", "priceToBook", "quickRatio"]);
  // Finnhub is inconsistent: most tickers are already decimal (0.0287 = 2.87%),
  // but some (e.g. AAPL) store percent points (0.35 = 0.35%). Values >20% as a
  // fraction are rare in our universe — treat those as percent points.
  const finnhub = await populateFromTable(
    finnhubRows as Row[],
    "finnhub",
    FINNHUB_FIELDS,
    "fetchedAt",
    { dividendYield: (v) => (v > 0.2 ? v / 100 : v) },
    (row, canonical, defaultAt) => {
      if (!finnhubTimelinessFields.has(canonical)) return defaultAt;
      const ticker = String(row["ticker"]).toUpperCase();
      const metric = finnhubMetrics.get(ticker);
      return new Date(finnhubFieldTimelinessMs(metric, canonical, defaultAt));
    },
    (row, canonical) => {
      if (!finnhubTimelinessFields.has(canonical)) return undefined;
      const metric = finnhubMetrics.get(String(row["ticker"]).toUpperCase());
      if (!metric) return undefined;
      if (canonical === "currentRatio") {
        return finnhubQuarterlyOrAnnual(metric, "currentRatioQuarterly", "currentRatioAnnual");
      }
      if (canonical === "priceToBook") {
        return finnhubQuarterlyOrAnnual(metric, "pbQuarterly", "pbAnnual");
      }
      if (canonical === "quickRatio") {
        return finnhubQuarterlyOrAnnual(metric, "quickRatioQuarterly", "quickRatioAnnual");
      }
      return undefined;
    },
  );
  console.log(`  → ${finnhub.tickers} tickers, ${finnhub.totalFields} fields, ${finnhub.rejected} rejected`);

  console.log("Populating from fmp_fundamentals …");
  const fmp = await populateFromTable(fmpRows as Row[], "fmp", FMP_FIELDS, "fetchedAt");
  console.log(`  → ${fmp.tickers} tickers, ${fmp.totalFields} fields, ${fmp.rejected} rejected`);

  console.log("Populating from polygon_fundamentals …");
  const polygon = await populateFromTable(polygonRows as Row[], "polygon", POLYGON_FIELDS, "fetchedAt");
  console.log(`  → ${polygon.tickers} tickers, ${polygon.totalFields} fields, ${polygon.rejected} rejected`);

  console.log("Populating from av_fundamentals …");
  const av = await populateFromTable(avRows as Row[], "alpha_vantage", AV_FIELDS, "fetchedAt");
  console.log(`  → ${av.tickers} tickers, ${av.totalFields} fields, ${av.rejected} rejected`);

  const totalFields = yahoo.totalFields + edgar.totalFields + finnhub.totalFields + fmp.totalFields + polygon.totalFields + av.totalFields;
  const totalRejected = yahoo.rejected + edgar.rejected + finnhub.rejected + fmp.rejected + polygon.rejected + av.rejected;
  console.log("\nSummary:");
  console.log(`  yahoo:         ${yahoo.tickers} tickers, ${yahoo.totalFields} fields`);
  console.log(`  edgar:         ${edgar.tickers} tickers, ${edgar.totalFields} fields`);
  console.log(`  finnhub:       ${finnhub.tickers} tickers, ${finnhub.totalFields} fields`);
  console.log(`  fmp:           ${fmp.tickers} tickers, ${fmp.totalFields} fields`);
  console.log(`  polygon:       ${polygon.tickers} tickers, ${polygon.totalFields} fields`);
  console.log(`  alpha_vantage: ${av.tickers} tickers, ${av.totalFields} fields`);
  console.log(`  TOTAL:         ${totalFields} rows written, ${totalRejected} rejected`);

  // Fill missing per-source PEG from that source's own PE + epsGrowth (same idea as
  // deriving FactSet P/E from price/EPS). Does NOT overwrite a vendor-published PEG.
  console.log("\nDeriving missing source pegRatio from peRatio÷epsGrowth …");
  await db.execute(sql`
    INSERT INTO source_fundamentals (ticker, source, field, value, fetched_at)
    SELECT
      pe.ticker,
      pe.source,
      'pegRatio',
      (pe.value::double precision / (g.value::double precision * 100)),
      NOW()
    FROM source_fundamentals pe
    INNER JOIN source_fundamentals g
      ON g.ticker = pe.ticker AND g.source = pe.source AND g.field = 'epsGrowth'
    LEFT JOIN source_fundamentals peg
      ON peg.ticker = pe.ticker AND peg.source = pe.source AND peg.field = 'pegRatio'
    WHERE pe.field = 'peRatio'
      AND peg.ticker IS NULL
      AND pe.value::double precision > 0
      AND g.value::double precision > 0.05
      AND g.value::double precision < 3
    ON CONFLICT (ticker, source, field) DO NOTHING
  `);
  console.log("  → fill-in complete (only where source had PE+growth but no PEG)");

  console.log("\nSyncing SEC TTM → source_fundamentals (sec, filed date = timeliness) …");
  try {
    await syncSecSourceFundamentals();
    console.log("  → sec sync complete");
  } catch (err) {
    console.error("  → sec sync failed:", err);
    throw err;
  }
}

// CLI entrypoint only — when imported (e.g. by nightly-enrichment running in the
// long-lived api-server process) the caller invokes runPopulateSourceFundamentals()
// directly and must not have the process exit out from under it.
const isMain = process.argv[1]?.includes("populate-source-fundamentals");
if (isMain) {
  runPopulateSourceFundamentals()
    .then(() => process.exit(0))
    .catch((err) => { console.error("Fatal:", err); process.exit(1); });
}
