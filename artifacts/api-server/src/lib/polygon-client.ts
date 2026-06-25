import { logger } from "./logger.js";

const POLY_BASE = "https://api.polygon.io";

// Normalized output from Polygon /vX/reference/financials endpoint.
// Fields match ticker_fundamentals column names per data-agent.md mappings.
// grossMargin and operatingMargin are computed from raw income statement values.
export interface PolygonFundamentalsData {
  totalRevenue?: number;
  grossMargin?: number;       // computed: gross_profit / revenues
  netIncome?: number;
  operatingMargin?: number;   // computed: operating_income_loss / revenues
  interestExpense?: number;   // always positive
  totalDebt?: number;
  totalStockholdersEquity?: number;
  quarterlyOperatingCashFlow?: number;
}

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error(`Polygon rate limit exceeded after ${maxRetries} retries`);
      logger.warn({ url, attempt }, "polygon: rate limited, backing off");
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      if (attempt === maxRetries) throw new Error(`Polygon HTTP ${res.status} for ${url}`);
      await sleep(delay);
      delay *= 2;
      continue;
    }
    return res.json();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function polyN(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

// Fetches the most recent annual filing from /vX/reference/financials.
// Returns undefined for any field Polygon returned null/missing.
// Never throws on individual field absence — only throws on network failure after retries.
export async function fetchPolygonFundamentals(
  ticker: string,
  apiKey: string,
): Promise<PolygonFundamentalsData> {
  const t = ticker.toUpperCase();
  const url = `${POLY_BASE}/vX/reference/financials?ticker=${t}&timeframe=annual&limit=1&apiKey=${apiKey}`;

  const raw = await fetchWithRetry(url);

  if (raw?.status === "ERROR" || raw?.error) {
    logger.warn({ ticker: t, error: raw.error ?? raw.status }, "polygon: API error");
    return {};
  }

  const results: unknown[] = raw?.results ?? [];
  if (!Array.isArray(results) || results.length === 0) {
    logger.warn({ ticker: t }, "polygon: no financial results returned");
    return {};
  }

  logger.info({ ticker: t, period: (results[0] as any)?.fiscal_period, year: (results[0] as any)?.fiscal_year }, "polygon: financials fetched");

  const filing = results[0] as Record<string, any>;
  const is = (filing.financials?.income_statement ?? {}) as Record<string, any>;
  const bs = (filing.financials?.balance_sheet ?? {}) as Record<string, any>;
  const cf = (filing.financials?.cash_flow_statement ?? {}) as Record<string, any>;

  // Polygon wraps each value as { value, unit, label } — extract .value
  const v = (obj: Record<string, any>, key: string): number | undefined =>
    polyN(obj[key]?.value);

  const revenues  = v(is, "revenues");
  const gross     = v(is, "gross_profit");
  const opIncome  = v(is, "operating_income_loss");
  const rawInterest = v(is, "interest_expense");

  const result: PolygonFundamentalsData = {};

  // ── INCOME STATEMENT ─────────────────────────────────────────────────────────
  result.totalRevenue = revenues;
  result.netIncome    = v(is, "net_income_loss");
  result.interestExpense = rawInterest !== undefined ? Math.abs(rawInterest) : undefined;

  // Computed margins — only set when denominator is non-zero
  if (revenues && revenues !== 0) {
    if (gross !== undefined)    result.grossMargin     = gross / revenues;
    if (opIncome !== undefined) result.operatingMargin = opIncome / revenues;
  }

  // ── BALANCE SHEET ────────────────────────────────────────────────────────────
  result.totalDebt               = v(bs, "liabilities");
  result.totalStockholdersEquity = v(bs, "equity");

  // ── CASH FLOW ────────────────────────────────────────────────────────────────
  result.quarterlyOperatingCashFlow = v(cf, "net_cash_flow_from_operating_activities");

  return result;
}

// Quick test — run via: POLYGON_API_KEY=xxx node --input-type=module ...
if (process.argv[1]?.endsWith("polygon-client.ts") || process.argv[1]?.endsWith("polygon-client.js")) {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    console.error("POLYGON_API_KEY not set");
    process.exit(1);
  }
  fetchPolygonFundamentals("NVDA", apiKey)
    .then(data => {
      console.log("NVDA Polygon financials result:");
      console.log(JSON.stringify(data, null, 2));
    })
    .catch(err => {
      console.error("Polygon fetch failed:", err.message);
      process.exit(1);
    });
}
