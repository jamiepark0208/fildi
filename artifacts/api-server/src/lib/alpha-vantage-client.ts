import { logger } from "./logger.js";

const AV_BASE = "https://www.alphavantage.co/query";

// Subset of ticker_fundamentals fields that Alpha Vantage OVERVIEW covers.
// Used as a fill-in when FMP returns empty for non-large-cap tickers.
// All number fields in natural decimal units (margins as 0.25, not 25%).
export interface AVFundamentalsData {
  // VALUE
  peRatio?: number;
  pegRatio?: number;
  forwardPe?: number;
  pbRatio?: number;
  dividendYield?: number;
  analystTargetPrice?: number;
  // QUALITY
  netMargin?: number;
  operatingMargin?: number;
  returnOnEquity?: number;
  // INCOME STATEMENT raw ($)
  totalRevenue?: number;
  ebitda?: number;
  // MARKET
  beta?: number;
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
      if (attempt === maxRetries) throw new Error(`AV rate limit exceeded after ${maxRetries} retries`);
      logger.warn({ url, attempt }, "av: rate limited, backing off");
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (!res.ok) {
      if (attempt === maxRetries) throw new Error(`AV HTTP ${res.status} for ${url}`);
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

// AV returns all numbers as strings — parse and validate.
function avN(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "None" || v === "-") return undefined;
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

// AV OVERVIEW returns margins as decimals already (0.25 = 25%) — no conversion needed.
export async function fetchAVOverview(
  ticker: string,
  apiKey: string,
): Promise<AVFundamentalsData> {
  const t = ticker.toUpperCase();
  const url = `${AV_BASE}?function=OVERVIEW&symbol=${t}&apikey=${apiKey}`;

  const raw = await fetchWithRetry(url);

  // AV returns {"Information": "..."} when rate-limited or {"Note": "..."} for soft limit
  if (raw?.Information || raw?.Note) {
    const msg = raw.Information ?? raw.Note;
    logger.warn({ ticker: t, msg }, "av: API limit hit");
    throw new Error(`AV API limit: ${msg}`);
  }

  // Empty object or missing Symbol means ticker not found / not covered
  if (!raw?.Symbol) {
    logger.warn({ ticker: t }, "av: no data returned (ticker not covered or invalid)");
    return {};
  }

  logger.info({ ticker: t, symbol: raw.Symbol, name: raw.Name }, "av: overview fetched");

  const result: AVFundamentalsData = {};

  // ── VALUE ────────────────────────────────────────────────────────────────────
  result.peRatio            = avN(raw.PERatio);
  result.pegRatio           = avN(raw.PEGRatio);
  result.forwardPe          = avN(raw.ForwardPE);
  result.pbRatio            = avN(raw.PriceToBookRatio);
  result.dividendYield      = avN(raw.DividendYield);
  result.analystTargetPrice = avN(raw.AnalystTargetPrice);

  // ── QUALITY ──────────────────────────────────────────────────────────────────
  result.netMargin       = avN(raw.ProfitMargin);
  result.operatingMargin = avN(raw.OperatingMarginTTM);
  result.returnOnEquity  = avN(raw.ReturnOnEquityTTM);

  // ── INCOME STATEMENT raw ($) ─────────────────────────────────────────────────
  result.totalRevenue = avN(raw.RevenueTTM);
  result.ebitda       = avN(raw.EBITDA);

  // ── MARKET ───────────────────────────────────────────────────────────────────
  result.beta = avN(raw.Beta);

  return result;
}

// ── Quick test: run with ts-node or tsx ──────────────────────────────────────
// tsx api-server/src/lib/alpha-vantage-client.ts
if (process.argv[1]?.endsWith("alpha-vantage-client.ts") || process.argv[1]?.endsWith("alpha-vantage-client.js")) {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    console.error("ALPHA_VANTAGE_API_KEY not set");
    process.exit(1);
  }
  fetchAVOverview("NVDA", apiKey)
    .then(data => {
      console.log("AV OVERVIEW result for NVDA:");
      console.log(JSON.stringify(data, null, 2));
    })
    .catch(err => {
      console.error("AV fetch failed:", err.message);
      process.exit(1);
    });
}
