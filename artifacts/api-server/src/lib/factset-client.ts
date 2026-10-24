/**
 * FactSet Overview Report Builder (via Oracle static-IP proxy).
 *
 * Last-resort referee for nulls / cross-source divergences after free-source
 * enrichment. Writes only to source_fundamentals (source=factset); gold comes
 * from merge-trusted. Do not upsert ticker_fundamentals from this module.
 *
 * Valuation ratios (P/E, P/B, PEG, forward P/E) are usually absent from the
 * overview table — we derive them from FactSet fundamentals + a live price:
 *   peRatio      = price / LTM diluted EPS
 *   priceToBook  = price / book value per share
 *   pegRatio     = peRatio / (LTM YoY EPS growth as percent)
 *                — FactSet/FullRatio-style *trailing* PEG (not Lynch 5yr forward)
 *   forwardPe    = price / consensus forward EPS (forwardEps from free sources)
 *                — uses Street consensus as the growth/earnings outlook input
 *
 * Yahoo/FMP PEG often use 5yr *expected* EPS growth (analyst / company guidance
 * embedded in estimates). Those are not comparable to trailing PEG without
 * noting the denominator assumption — merge treats FactSet-derived PEG as the
 * referee benchmark for settling free-source PEG fights, not as gospel.
 */
import { logger } from "./logger.js";
import { mapFactSetHighlightRows } from "./dropped-vendor-fields.js";
import { rememberVendorPayload } from "./vendor-raw.js";

/** Subset of fundamentals fields FactSet overview can supply (+ derived valuations). */
export interface FactSetFundamentalsPartial {
  totalRevenue?: number;
  netIncome?: number;
  ebitda?: number;
  ebit?: number;
  earningsPerShare?: number;
  bookValuePerShare?: number;
  grossMargin?: number;
  operatingMargin?: number;
  netMargin?: number;
  returnOnEquity?: number;
  returnOnAssets?: number;
  totalStockholdersEquity?: number;
  freeCashFlow?: number;
  quarterlyOperatingCashFlow?: number;
  cashAndEquivalents?: number;
  currentRatio?: number;
  debtToEquity?: number;
  revenueGrowthYoY?: number;
  epsGrowth?: number;
  /** FactSet TBV, dollars/share (scale 0). RATIO capital ratios stay percent points. */
  tangibleBookValuePerShare?: number;
  tier1CapitalRatio?: number;
  totalCapitalRatio?: number;
  /** PERCENTAGE → decimal (21.22% stored as 0.2122). */
  rotce?: number;
  netInterestIncome?: number;
  totalDeposits?: number;
  /** Derived: price / LTM EPS */
  peRatio?: number;
  /** Derived: price / BVPS */
  priceToBook?: number;
  /** Derived: trailing PE / (LTM YoY EPS growth %) */
  pegRatio?: number;
  /** Derived: price / consensus forward EPS */
  forwardPe?: number;
}

/**
 * Derive valuation multiples from FactSet fundamentals + spot price.
 * `forwardEps` (consensus) enables forwardPe and a forward-growth PEG fallback.
 *
 * Growth for PEG (institutions differ — we document ours):
 * 1. Prefer LTM YoY EPS growth from FactSet (trailing PEG, FactSet/FullRatio style)
 * 2. If that is ≤0 or absurd, use Street forward growth:
 *    (forwardEps − LTM EPS) / |LTM EPS|  — embeds near-term guidance/estimates
 * 3. Else skip PEG (leave free sources to fight; Needs Review stays honest)
 */
export function deriveFactSetValuations(
  base: FactSetFundamentalsPartial,
  price: number | null | undefined,
  forwardEps?: number | null,
): FactSetFundamentalsPartial {
  if (price == null || !isFinite(price) || price <= 0) return { ...base };

  const out: FactSetFundamentalsPartial = { ...base };
  const eps = base.earningsPerShare;
  if (eps != null && isFinite(eps) && eps !== 0) {
    out.peRatio = price / eps;
  }
  const bvps = base.bookValuePerShare;
  if (bvps != null && isFinite(bvps) && bvps > 0) {
    out.priceToBook = price / bvps;
  }

  let growthForPeg: number | undefined;
  const g = base.epsGrowth;
  if (g != null && isFinite(g) && g !== 0) {
    growthForPeg = g;
  } else if (
    forwardEps != null &&
    isFinite(forwardEps) &&
    eps != null &&
    isFinite(eps) &&
    eps !== 0
  ) {
    const fwdG = (forwardEps - eps) / Math.abs(eps);
    if (isFinite(fwdG) && fwdG !== 0) growthForPeg = fwdG;
  }
  if (out.peRatio != null && growthForPeg != null) {
    const peg = out.peRatio / (growthForPeg * 100);
    if (isFinite(peg)) out.pegRatio = peg;
  }
  if (forwardEps != null && isFinite(forwardEps) && forwardEps !== 0) {
    out.forwardPe = price / forwardEps;
  }
  return out;
}

/**
 * Fetch FactSet financial highlights for a ticker.
 * Returns null when proxy/env missing or the call fails.
 */
export async function fetchFactSetFundamentals(
  ticker: string,
): Promise<FactSetFundamentalsPartial | null> {
  const proxyUrl = process.env.FACTSET_PROXY_URL;
  const proxySecret = process.env.FACTSET_PROXY_SECRET;
  if (!proxyUrl || !proxySecret) return null;

  const id = `${ticker.toUpperCase()}-US`;
  const url = `${proxyUrl}/factset/report/overview/v1/financial-highlights?id=${encodeURIComponent(id)}`;

  const res = await fetch(url, {
    headers: { "X-Proxy-Secret": proxySecret, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    logger.warn({ ticker, status: res.status }, "factset: overview fetch failed");
    return null;
  }

  const json = (await res.json()) as {
    data?: { tables?: { main?: { data?: { rows?: unknown[] } } } };
  };
  await rememberVendorPayload({
    source: "factset",
    endpoint: "/factset/report/overview/v1/financial-highlights",
    key: ticker.toUpperCase(),
    payload: json,
  }).catch((err) => logger.warn({ ticker, err: String(err) }, "vendor_raw: factset store failed"));
  const rows = (json?.data?.tables?.main?.data?.rows ?? []) as Parameters<typeof mapFactSetHighlightRows>[0];
  return mapFactSetHighlightRows(rows);
}
