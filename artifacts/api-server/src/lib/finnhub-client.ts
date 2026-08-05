import { logger } from "./logger.js";
import { logApiCall } from "./api-logger.js";

export interface FinnhubFundamentalsData {
  finnhub_peRatio?:               number;
  finnhub_pegRatio?:              number;
  finnhub_pbRatio?:               number;
  finnhub_psRatio?:               number;
  finnhub_grossMargin?:           number;
  finnhub_operatingMargin?:       number;
  finnhub_netMargin?:             number;
  finnhub_returnOnEquity?:        number;
  finnhub_returnOnAssets?:        number;
  finnhub_roic?:                  number;
  finnhub_revenueGrowth?:         number;
  finnhub_epsGrowth?:             number;
  finnhub_debtToEquity?:          number;
  finnhub_currentRatio?:          number;
  finnhub_quickRatio?:            number;
  finnhub_fcfMargin?:             number;
  finnhub_fcfPerShare?:           number;
  finnhub_bookValue?:             number;
  finnhub_ev?:                    number;
  finnhub_beta?:                  number;
  finnhub_eps?:                   number;
  finnhub_ebitPerShare?:          number;
  finnhub_longTermDebtToEquity?:  number;
  finnhub_netDebtToEquity?:       number;
  finnhub_earningsPerShare?:      number;
  finnhub_priceToBook?:           number;
  finnhub_52weekHigh?:            number;
  finnhub_52weekLow?:             number;
  finnhub_marketCap?:             number;
  finnhub_dividendYield?:         number;
}

function n(v: unknown): number | undefined {
  if (v == null) return undefined;
  const num = Number(v);
  return isFinite(num) ? num : undefined;
}

// Divide by 100 to convert percent → decimal, but only when value looks like a percent
function pct(v: unknown): number | undefined {
  const num = n(v);
  if (num === undefined) return undefined;
  return num / 100;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url: string, maxRetries = 3): Promise<any> {
  let delay = 1200; // Finnhub free tier: 50 calls/min → 1200ms between retries
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(delay); delay *= 2; continue;
    }
    if (res.status === 429) {
      if (attempt === maxRetries) throw new Error("Finnhub rate limit (429)");
      logger.warn({ url, attempt }, "finnhub: rate limited, backing off");
      await sleep(delay * 2); delay *= 2; continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      if (attempt === maxRetries) throw new Error(`Finnhub HTTP ${res.status}`);
      await sleep(delay); delay *= 2; continue;
    }
    return res.json();
  }
}

export interface FinnhubEarningsQuarter {
  reportDate: string;
  epsEstimate: number | null;
  epsActual: number | null;
}

// FMP-earnings fallback for tickers FMP's free/current plan gates behind a premium
// paywall (HTTP 402 "Premium Query Parameter") — /stable/earnings 402s for some
// well-known small/mid-caps (e.g. AAOI, GME) despite the ticker having public
// earnings history. Finnhub's /stock/earnings covers the same actual-vs-estimate
// data on the free tier.
export async function fetchFinnhubEarningsHistory(ticker: string, trigger = "unknown"): Promise<FinnhubEarningsQuarter[]> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error("FINNHUB_API_KEY not set");

  const t = ticker.toUpperCase();
  const url = `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(t)}&token=${apiKey}`;

  try {
    const raw = await fetchWithRetry(url);
    const rows: FinnhubEarningsQuarter[] = (Array.isArray(raw) ? raw : []).map((r: any) => ({
      reportDate: r.period,
      epsEstimate: n(r.estimate) ?? null,
      epsActual: n(r.actual) ?? null,
    })).filter(r => !!r.reportDate);
    logApiCall({ source: "finnhub", fn: "fetchFinnhubEarningsHistory", trigger, ticker: t, outcome: "success", fieldsReturned: rows.length });
    return rows;
  } catch (err: any) {
    logApiCall({ source: "finnhub", fn: "fetchFinnhubEarningsHistory", trigger, ticker: t, outcome: "failure", error: String(err?.message ?? err), requestedFields: "stock/earnings" });
    throw err;
  }
}

export async function fetchFinnhubFundamentals(ticker: string): Promise<FinnhubFundamentalsData> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) throw new Error("FINNHUB_API_KEY not set");

  const t = ticker.toUpperCase();
  const url = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(t)}&metric=all&token=${apiKey}`;

  let raw: any;
  try {
    raw = await fetchWithRetry(url);
  } catch (err: any) {
    logApiCall({ source: "finnhub", fn: "fetchFinnhubFundamentals", trigger: "backfill-finnhub script", ticker: t, outcome: "failure", error: String(err?.message ?? err), requestedFields: "stock/metric?metric=all" });
    throw err;
  }

  if (!raw) {
    logApiCall({ source: "finnhub", fn: "fetchFinnhubFundamentals", trigger: "backfill-finnhub script", ticker: t, outcome: "failure", error: "404 — ticker not found", requestedFields: "stock/metric?metric=all" });
    return {};
  }

  const m = raw.metric ?? {};

  const result: FinnhubFundamentalsData = {
    finnhub_peRatio:              n(m["peBasicExclExtraTTM"]) ?? n(m["peTTM"]),
    // Finnhub only exposes forward PEG (forwardPEG) — no trailing PEG field exists on this
    // endpoint. Kept as a lower-priority fallback in merge-trusted.ts since it's not directly
    // comparable to yahoo/fmp's trailing PEG.
    finnhub_pegRatio:              n(m["forwardPEG"]),
    finnhub_pbRatio:              n(m["pb"]),
    finnhub_psRatio:              n(m["psTTM"]),
    finnhub_grossMargin:          pct(m["grossMarginTTM"]),
    finnhub_operatingMargin:      pct(m["operatingMarginTTM"]),
    finnhub_netMargin:            pct(m["netProfitMarginTTM"]),
    finnhub_returnOnEquity:       pct(m["roeTTM"]),
    finnhub_returnOnAssets:       pct(m["roaTTM"]),
    finnhub_roic:                 pct(m["roicTTM"]),
    finnhub_revenueGrowth:        pct(m["revenueGrowthTTMYoy"]),
    finnhub_epsGrowth:            pct(m["epsGrowthTTMYoy"]),
    // totalDebt/totalEquityAnnual (and its long-term/net variants) are plain ratios from
    // Finnhub, like pb/currentRatioAnnual — not percentages. pct() was wrongly dividing
    // them by 100, producing values ~100x too small vs fmp's debtToEquity.
    finnhub_debtToEquity:         n(m["totalDebt/totalEquityAnnual"]),
    finnhub_currentRatio:         n(m["currentRatioAnnual"]),
    finnhub_quickRatio:           n(m["quickRatioAnnual"]),
    finnhub_fcfMargin:            pct(m["fcfMargin"]),
    finnhub_fcfPerShare:          n(m["fcfPerShareTTM"]),
    finnhub_bookValue:            n(m["bookValue"]),
    finnhub_ev:                   n(m["ev"]),
    finnhub_beta:                 n(m["beta"]),
    finnhub_eps:                  n(m["eps"]),
    finnhub_ebitPerShare:         n(m["ebitPerShare"]),
    finnhub_longTermDebtToEquity: n(m["longtermDebtTotalEquity"]),
    finnhub_netDebtToEquity:      n(m["netDebtToTotalEquity"]),
    finnhub_earningsPerShare:     n(m["epsBasicExclExtraItemsTTM"]),
    finnhub_priceToBook:          n(m["pbAnnual"]),
    finnhub_52weekHigh:           n(m["52WeekHigh"]),
    finnhub_52weekLow:            n(m["52WeekLow"]),
    finnhub_marketCap:            n(m["marketCapitalization"]),
    // Finnhub reports dividendYield in percentage format (0.9495 = 0.9495%), so pct() ÷100 → decimal
    finnhub_dividendYield:        pct(m["dividendYieldIndicatedAnnual"]) ?? pct(m["currentDividendYieldTTM"]),
  };

  const fieldsReturned = Object.values(result).filter(v => v !== undefined).length;
  logApiCall({ source: "finnhub", fn: "fetchFinnhubFundamentals", trigger: "backfill-finnhub script", ticker: t, outcome: "success", fieldsReturned });
  return result;
}

// Run: npx tsx artifacts/api-server/src/lib/finnhub-client.ts NVDA
if (process.argv[1]?.endsWith("finnhub-client.ts") || process.argv[1]?.endsWith("finnhub-client.js")) {
  const tickers = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["NVDA"];
  (async () => {
    for (const ticker of tickers) {
      console.log(`\nFetching Finnhub fundamentals for: ${ticker}`);
      try {
        const data = await fetchFinnhubFundamentals(ticker);
        const filled = Object.values(data).filter(v => v !== undefined).length;
        const total  = Object.keys(data).length;
        console.log(`Fields populated: ${filled} / ${total}`);
        console.log(JSON.stringify(data, null, 2));
      } catch (err: any) {
        console.error(`ERROR: ${err.message}`);
      }
    }
    process.exit(0);
  })();
}
