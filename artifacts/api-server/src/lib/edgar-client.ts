import { logger } from "./logger.js";

// ── SEC EDGAR XBRL client ─────────────────────────────────────────────────────
// No API key required. EDGAR is a public US government service.
// CIK lookup is cached in the ticker_cik DB table — only hits the EDGAR search
// endpoint once per ticker, then reuses the cached CIK.
// User-Agent is required by EDGAR ToS: TradeDash/1.0 jamiepark0208@gmail.com
// Rate limit: no hard limit — sleep 500ms between retries to stay respectful.

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
        signal: AbortSignal.timeout(15_000),
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

// ── CIK lookup ────────────────────────────────────────────────────────────────
// Tries the EDGAR company tickers JSON first (fast), falls back to browse-edgar
// XML scrape. Result should be cached in ticker_cik by the caller.

export async function lookupCIK(ticker: string): Promise<string | null> {
  const t = ticker.toUpperCase();

  // Fast path: EDGAR publishes a company_tickers.json mapping
  try {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const map = await res.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
      const entry = Object.values(map).find(e => e.ticker.toUpperCase() === t);
      if (entry) return String(entry.cik_str).padStart(10, "0");
    }
  } catch { /* fall through to browse-edgar */ }

  // Slow fallback: browse-edgar XML
  try {
    const res = await fetch(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(t)}&type=&dateb=&owner=include&count=1&output=atom`,
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const xml = await res.text();
    const m = xml.match(/CIK=(\d+)/);
    if (m) return m[1].padStart(10, "0");
  } catch { /* ignore */ }

  return null;
}

// ── XBRL concept fetcher ──────────────────────────────────────────────────────

type GaapEntry = { val: number; end: string; form: string; filed: string };
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
  cachedCIK?: string | null,
): Promise<{ data: EdgarFundamentalsData; cik: string | null }> {
  const t = ticker.toUpperCase();
  logger.info({ ticker: t }, "edgar: fetching fundamentals");

  // Resolve CIK
  let cik = cachedCIK ?? await lookupCIK(t);
  if (!cik) {
    logger.warn({ ticker: t }, "edgar: CIK not found");
    return { data: {}, cik: null };
  }

  // Fetch company facts
  const facts = await fetchWithRetry(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  if (!facts) {
    logger.warn({ ticker: t, cik }, "edgar: company facts not found");
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

  logger.info({ ticker: t, cik }, "edgar: parsed successfully");

  return {
    cik,
    data: {
      edgar_totalRevenue:       totalRevenue,
      edgar_grossProfit:        grossProfit,
      edgar_netIncome:          netIncome,
      edgar_ebit:               ebit,
      edgar_ebitda:             undefined, // not directly available in XBRL
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
}

// ── Self-test block ───────────────────────────────────────────────────────────
// Run: npx tsx artifacts/api-server/src/lib/edgar-client.ts NVDA
if (process.argv[1]?.endsWith("edgar-client.ts") || process.argv[1]?.endsWith("edgar-client.js")) {
  const ticker = process.argv[2] ?? "NVDA";
  console.log(`\nFetching EDGAR fundamentals for: ${ticker}\n`);
  fetchEdgarFundamentals(ticker).then(({ data, cik }) => {
    const filled = Object.values(data).filter(v => v !== undefined).length;
    const total  = Object.keys(data).length;
    console.log(`CIK: ${cik}`);
    console.log(`Fields populated: ${filled} / ${total}`);
    console.log(JSON.stringify(data, null, 2));
  }).catch(err => { console.error(err.message); process.exit(1); });
}
