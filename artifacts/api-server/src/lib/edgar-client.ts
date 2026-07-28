import { sql } from "drizzle-orm";
import { db, tickerCik } from "@workspace/db";
import { logger } from "./logger.js";
import { logApiCall } from "./api-logger.js";

// ── SEC EDGAR XBRL client ─────────────────────────────────────────────────────
// No API key required. EDGAR is a public US government service.
// CIK cache: bootstrapCikCache() fetches company_tickers.json once (~10k companies)
// and bulk-upserts into ticker_cik. Subsequent lookups are DB-only.
// User-Agent required by EDGAR ToS: TradeDash/1.0 jamiepark0208@gmail.com

const UA = "TradeDash/1.0 jamiepark0208@gmail.com";

export interface EdgarFundamentalsData {
  edgar_totalRevenue?:        number;
  edgar_grossProfit?:         number;
  edgar_netIncome?:           number;
  edgar_ebit?:                number;
  edgar_ebitda?:              number; // not directly available from XBRL — always null
  edgar_freeCashFlow?:        number; // operatingCashFlow - capex
  edgar_operatingCashFlow?:   number;
  edgar_capitalExpenditure?:  number; // stored positive
  edgar_cashAndEquivalents?:  number;
  edgar_totalDebt?:           number;
  edgar_totalEquity?:         number;
  edgar_interestExpense?:     number; // stored positive
  edgar_sharesOutstanding?:   number;
  edgar_grossMargin?:         number; // computed: grossProfit / totalRevenue
  edgar_netMargin?:           number; // computed: netIncome / totalRevenue
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  let delay = 500;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(delay); delay *= 2; continue;
    }
    if (res.status === 429 || res.status === 503) {
      if (attempt === maxRetries) throw new Error(`EDGAR HTTP ${res.status}`);
      logger.warn({ url, status: res.status, attempt }, "edgar: throttled, backing off");
      await sleep(delay * 2); delay *= 2; continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      if (attempt === maxRetries) throw new Error(`EDGAR HTTP ${res.status} for ${url}`);
      await sleep(delay); delay *= 2; continue;
    }
    return res.json();
  }
}

// ── CIK bootstrap ─────────────────────────────────────────────────────────────
// Fetches company_tickers.json once (~10k companies) and bulk-upserts into
// ticker_cik. Call once before the main backfill loop.

export async function bootstrapCikCache(): Promise<number> {
  logger.info("edgar: fetching bulk CIK map from company_tickers.json");

  const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`edgar: company_tickers.json HTTP ${res.status}`);

  const map = await res.json() as Record<string, { cik_str: number; ticker: string }>;
  const entries = Object.values(map);

  // Batch upsert in chunks of 500 to avoid query size limits
  const CHUNK = 500;
  let upserted = 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const values = chunk.map(e => ({
      ticker:    e.ticker.toUpperCase(),
      cik:       String(e.cik_str).padStart(10, "0"),
      fetchedAt: new Date(),
    }));
    await db.insert(tickerCik)
      .values(values)
      .onConflictDoUpdate({
        target: tickerCik.ticker,
        set: {
          cik:       sql`excluded.cik`,
          fetchedAt: sql`now()`,
        },
      });
    upserted += values.length;
  }

  logger.info({ upserted }, "edgar: CIK cache bootstrapped");
  return upserted;
}

// ── CIK lookup from DB ────────────────────────────────────────────────────────

export async function getCIK(ticker: string): Promise<string | null> {
  const rows = await db
    .select({ cik: tickerCik.cik })
    .from(tickerCik)
    .where(sql`${tickerCik.ticker} = ${ticker.toUpperCase()}`)
    .limit(1);
  return rows[0]?.cik ?? null;
}

// ── XBRL concept fetcher ──────────────────────────────────────────────────────

type GaapEntry = { val: number; end: string; form: string };
type GaapFacts = Record<string, { units?: { USD?: GaapEntry[]; shares?: GaapEntry[] } }>;

function latestAnnual(gaap: GaapFacts, concept: string, unit: "USD" | "shares" = "USD"): number | undefined {
  const entries = gaap[concept]?.units?.[unit];
  if (!entries?.length) return undefined;
  const annual = entries
    .filter(e => e.form === "10-K")
    .sort((a, b) => b.end.localeCompare(a.end));
  return annual[0]?.val;
}

// ── Main fetch function ───────────────────────────────────────────────────────

export async function fetchEdgarFundamentals(
  ticker: string,
): Promise<{ data: EdgarFundamentalsData; cik: string | null }> {
  const t = ticker.toUpperCase();
  const cik = await getCIK(t);
  if (!cik) {
    logApiCall({ source: "edgar", fn: "fetchEdgarFundamentals", trigger: "backfill-edgar script", ticker: t, outcome: "failure", error: "CIK not in cache — run bootstrapCikCache() first", requestedFields: "us-gaap XBRL company facts" });
    return { data: {}, cik: null };
  }

  let facts: any;
  try {
    facts = await fetchWithRetry(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  } catch (err: any) {
    logApiCall({ source: "edgar", fn: "fetchEdgarFundamentals", trigger: "backfill-edgar script", ticker: t, outcome: "failure", error: String(err?.message ?? err), requestedFields: "us-gaap XBRL company facts" });
    throw err;
  }
  if (!facts) {
    logApiCall({ source: "edgar", fn: "fetchEdgarFundamentals", trigger: "backfill-edgar script", ticker: t, outcome: "failure", error: "company facts 404", requestedFields: "us-gaap XBRL company facts" });
    return { data: {}, cik };
  }

  const gaap: GaapFacts = facts.facts?.["us-gaap"] ?? {};

  function annual(concept: string) { return latestAnnual(gaap, concept, "USD"); }
  function annualShares(concept: string) { return latestAnnual(gaap, concept, "shares"); }

  const totalRevenue  = annual("Revenues") ?? annual("RevenueFromContractWithCustomerExcludingAssessedTax");
  const grossProfit   = annual("GrossProfit");
  const netIncome     = annual("NetIncomeLoss");
  const ebit          = annual("OperatingIncomeLoss");
  const opCF          = annual("NetCashProvidedByUsedInOperatingActivities");
  const rawCapex      = annual("PaymentsToAcquirePropertyPlantAndEquipment");
  const capex         = rawCapex != null ? Math.abs(rawCapex) : undefined;
  const cash          = annual("CashAndCashEquivalentsAtCarryingValue");
  const totalDebt     = annual("LongTermDebt");
  const totalEquity   = annual("StockholdersEquity");
  const rawIntExp     = annual("InterestExpense");
  const shares        = annualShares("CommonStockSharesOutstanding")
                     ?? annual("CommonStockSharesOutstanding");

  const freeCashFlow  = opCF != null && capex != null ? opCF - capex : undefined;
  const grossMargin   = grossProfit != null && totalRevenue ? grossProfit / totalRevenue : undefined;
  const netMargin     = netIncome   != null && totalRevenue ? netIncome   / totalRevenue : undefined;

  const result = {
    cik,
    data: {
      edgar_totalRevenue:       totalRevenue,
      edgar_grossProfit:        grossProfit,
      edgar_netIncome:          netIncome,
      edgar_ebit:               ebit,
      edgar_ebitda:             undefined,
      edgar_freeCashFlow:       freeCashFlow,
      edgar_operatingCashFlow:  opCF,
      edgar_capitalExpenditure: capex,
      edgar_cashAndEquivalents: cash,
      edgar_totalDebt:          totalDebt,
      edgar_totalEquity:        totalEquity,
      edgar_interestExpense:    rawIntExp != null ? Math.abs(rawIntExp) : undefined,
      edgar_sharesOutstanding:  shares,
      edgar_grossMargin:        grossMargin,
      edgar_netMargin:          netMargin,
    },
  };

  const fieldsReturned = Object.values(result.data).filter(v => v !== undefined).length;
  logApiCall({ source: "edgar", fn: "fetchEdgarFundamentals", trigger: "backfill-edgar script", ticker: t, outcome: "success", fieldsReturned });
  return result;
}

// ── Multi-year statement history (for the Accounting Statements UI tab) ────────
// fetchEdgarFundamentals() above only keeps the single latest annual value per
// concept (for triangulation scoring). This keeps the last ~5 annual (10-K, FY)
// values per line item so the UI can show trends, not just a snapshot.

export type EdgarStatementType = "income" | "balance" | "cashflow";

export interface EdgarStatementRow {
  statementType: EdgarStatementType;
  lineItem: string;
  fiscalYear: number;
  value: number;
  filedDate: string;
}

type XbrlAnnualFact = { form?: string; fp?: string; fy?: number; val?: number; filed?: string };

// Tries each tag in order and uses the first one with data — filers don't all use the
// same XBRL concept for the same line item (e.g. Revenues vs
// RevenueFromContractWithCustomerExcludingAssessedTax).
const STATEMENT_LINE_ITEM_TAGS: Record<string, { statementType: EdgarStatementType; tags: string[] }> = {
  revenue:            { statementType: "income", tags: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"] },
  costOfRevenue:       { statementType: "income", tags: ["CostOfRevenue", "CostOfGoodsAndServicesSold"] },
  grossProfit:         { statementType: "income", tags: ["GrossProfit"] },
  operatingIncome:     { statementType: "income", tags: ["OperatingIncomeLoss"] },
  netIncome:           { statementType: "income", tags: ["NetIncomeLoss"] },
  epsDiluted:          { statementType: "income", tags: ["EarningsPerShareDiluted"] },

  totalAssets:         { statementType: "balance", tags: ["Assets"] },
  currentAssets:       { statementType: "balance", tags: ["AssetsCurrent"] },
  totalLiabilities:    { statementType: "balance", tags: ["Liabilities"] },
  currentLiabilities:  { statementType: "balance", tags: ["LiabilitiesCurrent"] },
  stockholdersEquity:  { statementType: "balance", tags: ["StockholdersEquity"] },
  longTermDebt:        { statementType: "balance", tags: ["LongTermDebtNoncurrent", "LongTermDebt"] },
  cashAndEquivalents:  { statementType: "balance", tags: ["CashAndCashEquivalentsAtCarryingValue"] },

  operatingCashFlow:   { statementType: "cashflow", tags: ["NetCashProvidedByUsedInOperatingActivities"] },
  investingCashFlow:   { statementType: "cashflow", tags: ["NetCashProvidedByUsedInInvestingActivities"] },
  financingCashFlow:   { statementType: "cashflow", tags: ["NetCashProvidedByUsedInFinancingActivities"] },
  capex:               { statementType: "cashflow", tags: ["PaymentsToAcquirePropertyPlantAndEquipment"] },
};

/**
 * Fetches SEC XBRL companyfacts for `ticker` and extracts up to 5 years of annual
 * (10-K, FY) values per line item, deduping restated years by keeping the most
 * recently filed value. Returns null if there's no CIK on file or the fetch fails.
 * Requires getCIK(ticker) to already be populated (bootstrapCikCache / backfill-edgar).
 */
export async function fetchEdgarStatementHistory(ticker: string): Promise<EdgarStatementRow[] | null> {
  const t = ticker.toUpperCase();
  const cik = await getCIK(t);
  if (!cik) return null;

  let facts: any;
  try {
    facts = await fetchWithRetry(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  } catch (err: any) {
    logApiCall({ source: "edgar", fn: "fetchEdgarStatementHistory", trigger: "accounting-statements route", ticker: t, outcome: "failure", error: String(err?.message ?? err), requestedFields: "multi-year us-gaap XBRL statements" });
    throw err;
  }
  if (!facts?.facts?.["us-gaap"]) return null;

  const gaap: Record<string, { units?: { USD?: XbrlAnnualFact[] } }> = facts.facts["us-gaap"];
  const rows: EdgarStatementRow[] = [];

  for (const [lineItem, def] of Object.entries(STATEMENT_LINE_ITEM_TAGS)) {
    let units: XbrlAnnualFact[] | null = null;
    for (const tag of def.tags) {
      const usd = gaap[tag]?.units?.USD;
      if (Array.isArray(usd) && usd.length > 0) { units = usd; break; }
    }
    if (!units) continue;

    const byYear = new Map<number, { value: number; filedDate: string }>();
    for (const fact of units) {
      if (fact.form !== "10-K" || fact.fp !== "FY" || typeof fact.val !== "number" || !fact.fy || !fact.filed) continue;
      const existing = byYear.get(fact.fy);
      if (!existing || fact.filed > existing.filedDate) {
        byYear.set(fact.fy, { value: fact.val, filedDate: fact.filed });
      }
    }

    const years = [...byYear.keys()].sort((a, b) => b - a).slice(0, 5);
    for (const fy of years) {
      const entry = byYear.get(fy)!;
      rows.push({ statementType: def.statementType, lineItem, fiscalYear: fy, value: entry.value, filedDate: entry.filedDate });
    }
  }

  const fieldsReturned = rows.length;
  logApiCall({ source: "edgar", fn: "fetchEdgarStatementHistory", trigger: "accounting-statements route", ticker: t, outcome: "success", fieldsReturned });
  return rows;
}

// ── Self-test block ───────────────────────────────────────────────────────────
// Run: npx tsx artifacts/api-server/src/lib/edgar-client.ts NVDA
if (process.argv[1]?.endsWith("edgar-client.ts") || process.argv[1]?.endsWith("edgar-client.js")) {
  const ticker = process.argv[2] ?? "NVDA";
  console.log(`\nFetching EDGAR fundamentals for: ${ticker}\n`);
  bootstrapCikCache()
    .then(() => fetchEdgarFundamentals(ticker))
    .then(({ data, cik }) => {
      const filled = Object.values(data).filter(v => v !== undefined).length;
      console.log(`CIK: ${cik}`);
      console.log(`Fields populated: ${filled} / ${Object.keys(data).length}`);
      console.log(JSON.stringify(data, null, 2));
    })
    .catch(err => { console.error(err.message); process.exit(1); });
}
