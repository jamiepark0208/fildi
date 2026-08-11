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

// Statement rows are keyed by the calendar year each fiscal period ENDS in (see the
// periodYear comment in fetchEdgarStatementHistory below), so "FY2026" for a company
// whose fiscal year doesn't end in December can look like it's describing the current,
// still-in-progress calendar year when it's actually a closed, filed year. Surfacing the
// company's real fiscal year end (e.g. BlackBerry: "02-28") lets the UI disambiguate that.
export async function fetchFiscalYearEnd(ticker: string): Promise<string | null> {
  const cik = await getCIK(ticker);
  if (!cik) return null;
  const data = await fetchWithRetry(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const raw: string | undefined = data?.fiscalYearEnd; // "MMDD", e.g. "0228"
  if (!raw || raw.length !== 4) return null;
  return `${raw.slice(0, 2)}-${raw.slice(2)}`;
}

// ── XBRL concept fetcher ──────────────────────────────────────────────────────

type GaapEntry = { val: number; end: string; start?: string; form: string; fp?: string; filed?: string };
type GaapFacts = Record<string, { units?: { USD?: GaapEntry[]; shares?: GaapEntry[] } }>;

// Some concepts carry quarterly footnote disclosures (e.g. "selected quarterly data" tables)
// tagged under the same form="10-K", so filtering on form alone can pick up a non-annual
// value. Require a genuine ~1-year period when start is available. Accepts multiple synonym
// concepts (companies retag over time, e.g. MSFT's Revenues -> RevenueFromContractWith...
// in 2018) and picks the single most-recently-*filed* entry across ALL of them — not just
// the first concept with any data, which can lock onto a long-retired tag whose newest
// annual entry is years stale even after a company has moved on to a different tag.
function latestAnnual(gaap: GaapFacts, concepts: string | string[], unit: "USD" | "shares" = "USD"): number | undefined {
  const list = Array.isArray(concepts) ? concepts : [concepts];
  let best: GaapEntry | null = null;
  for (const concept of list) {
    const entries = gaap[concept]?.units?.[unit];
    if (!entries?.length) continue;
    for (const e of entries) {
      if (e.form !== "10-K") continue;
      if (e.start) {
        const days = (new Date(e.end).getTime() - new Date(e.start).getTime()) / 86400000;
        if (days < 340 || days > 386) continue;
      }
      if (!best || e.end > best.end || (e.end === best.end && (e.filed ?? "") > (best.filed ?? ""))) {
        best = e;
      }
    }
  }
  return best?.val;
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

  function annual(concepts: string | string[]) { return latestAnnual(gaap, concepts, "USD"); }
  function annualShares(concept: string) { return latestAnnual(gaap, concept, "shares"); }

  const totalRevenue  = annual(["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"]);
  const grossProfit   = annual("GrossProfit");
  const netIncome     = annual("NetIncomeLoss");
  const ebit          = annual("OperatingIncomeLoss");
  const opCF          = annual("NetCashProvidedByUsedInOperatingActivities");
  const rawCapex      = annual("PaymentsToAcquirePropertyPlantAndEquipment");
  const capex         = rawCapex != null ? Math.abs(rawCapex) : undefined;
  const cash          = annual("CashAndCashEquivalentsAtCarryingValue");
  const totalDebt     = annual(["LongTermDebtNoncurrent", "LongTermDebt"]);
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

type XbrlAnnualFact = { form?: string; fp?: string; fy?: number; val?: number; filed?: string; start?: string; end?: string };

// Tries each tag in order and uses the first one with data — filers don't all use the
// same XBRL concept for the same line item (e.g. Revenues vs
// RevenueFromContractWithCustomerExcludingAssessedTax).
const STATEMENT_LINE_ITEM_TAGS: Record<string, { statementType: EdgarStatementType; tags: string[]; unit?: string }> = {
  revenue:            { statementType: "income", tags: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"] },
  costOfRevenue:       { statementType: "income", tags: ["CostOfRevenue", "CostOfGoodsAndServicesSold"] },
  grossProfit:         { statementType: "income", tags: ["GrossProfit"] },
  operatingIncome:     { statementType: "income", tags: ["OperatingIncomeLoss"] },
  netIncome:           { statementType: "income", tags: ["NetIncomeLoss"] },
  // Per-share facts are reported under unit "USD/shares", not "USD" — every other line
  // item here is a dollar amount so USD is the default.
  epsDiluted:          { statementType: "income", tags: ["EarningsPerShareDiluted"], unit: "USD/shares" },

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
 * Fetches SEC XBRL companyfacts for `ticker` and extracts up to 6 years of annual
 * (10-K, FY) values per line item (5 for display + 1 as a YoY baseline for the oldest
 * displayed year), deduping restated years by keeping the most recently filed value.
 * Returns null if there's no CIK on file or the fetch fails.
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

  const gaap: Record<string, { units?: Record<string, XbrlAnnualFact[]> }> = facts.facts["us-gaap"];
  const perLineItemYears = new Map<string, Map<number, { value: number; filedDate: string }>>();

  for (const [lineItem, def] of Object.entries(STATEMENT_LINE_ITEM_TAGS)) {
    // Companies retag line items over time (e.g. MSFT: Revenues -> RevenueFromContract...
    // in 2018 for ASC 606). Merge facts from ALL synonym tags instead of stopping at the
    // first tag with any data — otherwise a long-retired tag whose last 10-K FY entry is
    // years stale (or whose only "FY" facts are actually quarterly footnote disclosures)
    // silently wins and blocks the active tag from ever being tried.
    const byYear = new Map<number, { value: number; filedDate: string }>();
    for (const tag of def.tags) {
      const usd = gaap[tag]?.units?.[def.unit ?? "USD"];
      if (!Array.isArray(usd)) continue;
      for (const fact of usd) {
        if (fact.form !== "10-K" || fact.fp !== "FY" || typeof fact.val !== "number" || !fact.end || !fact.filed) continue;
        // Some tags carry quarterly footnote data mislabeled fp="FY" — require a genuine
        // ~1-year period so those don't get treated as annual figures.
        if (fact.start) {
          const days = (new Date(fact.end).getTime() - new Date(fact.start).getTime()) / 86400000;
          if (days < 340 || days > 386) continue;
        }
        // Key by the year the reporting PERIOD actually ended, not fact.fy — fact.fy is the
        // fiscal year of the FILING, and a single 10-K discloses 2-3 years of comparatives
        // all stamped with the same fy. Grouping by fact.fy collides distinct periods (e.g.
        // MSFT's FY2026 10-K tags both its FY2026 figure AND its FY2024/FY2025 comparatives
        // as fy=2026), silently overwriting the real year's value with a prior year's.
        const periodYear = new Date(fact.end).getUTCFullYear();
        const existing = byYear.get(periodYear);
        if (!existing || fact.filed > existing.filedDate) {
          byYear.set(periodYear, { value: fact.val, filedDate: fact.filed });
        }
      }
    }
    if (byYear.size > 0) perLineItemYears.set(lineItem, byYear);
  }

  // Anchor the "last N years" window to the ticker's actual current reporting year, not to
  // whatever years happen to exist for each field in isolation. Some companies retire a
  // concept entirely (e.g. Amazon hasn't tagged "GrossProfit" since its FY2009 10-K — their
  // income statement format has no gross-profit subtotal) rather than switch to a synonym.
  // Without this anchor, that field's own "top N" would surface 2007-2009 sitting next to
  // every other field's 2021-2025 — badly stale data masquerading as current.
  let anchorYear = 0;
  for (const byYear of perLineItemYears.values()) {
    for (const year of byYear.keys()) anchorYear = Math.max(anchorYear, year);
  }

  // Fetch 6 years, not 5: the UI displays only the most recent 5, but keeps 1 extra
  // (oldest) year purely as a YoY baseline so the oldest *displayed* year can still show
  // a % change instead of reading as "no prior year exists."
  const rows: EdgarStatementRow[] = [];
  for (const [lineItem, byYear] of perLineItemYears) {
    const def = STATEMENT_LINE_ITEM_TAGS[lineItem]!;
    const years = [...byYear.keys()]
      .filter(y => y > anchorYear - 6)
      .sort((a, b) => b - a)
      .slice(0, 6);
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
