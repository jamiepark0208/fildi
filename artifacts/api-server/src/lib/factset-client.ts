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
  const rows: any[] = json?.data?.tables?.main?.data?.rows ?? [];

  type RowEntry = { cells: (string | null)[]; scale: number; isPct: boolean };
  const byLabel = new Map<string, RowEntry>();
  for (const row of rows) {
    if (!row.cells || row.rowType === "Header") continue;
    const label = (row.cells[0] ?? "").trim();
    if (!label) continue;
    const vt = row.rowMetadata?.valueType?.value ?? "";
    const rt = row.rowMetadata?.rowType?.value ?? "";
    const metricType = row.rowMetadata?.metric?.value ?? "";
    const isPct = vt === "PERCENTAGE" || rt === "MARGIN" || rt === "MARGIN_RATIO";
    const explicitScale = row.rowMetadata?.scale?.value;
    const scale =
      explicitScale != null
        ? Number(explicitScale)
        : metricType === "FIN" && !isPct
          ? 6
          : 0;
    byLabel.set(label, { cells: row.cells, scale, isPct });
  }

  function val(label: string, colIdx = 1): number | undefined {
    const entry = byLabel.get(label);
    if (!entry) return undefined;
    // FactSet overview columns: [0]=label, [1]=latest (LTM/current), [2]=prior FY, …
    const raw = entry.cells[colIdx] ?? null;
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    if (!isFinite(n)) return undefined;
    const scaled = entry.scale === 6 ? n * 1_000_000 : n;
    return entry.isPct ? scaled / 100 : scaled;
  }

  const revenue = val("Revenue");
  const netIncome = val("Net Income");
  const revPrior = val("Revenue", 2);
  const epsPrior = val("EPS (Diluted)", 2);
  const revenueGrowthYoY =
    revenue !== undefined && revPrior && revPrior !== 0
      ? (revenue - revPrior) / Math.abs(revPrior)
      : undefined;
  const epsCur = val("EPS (Diluted)");
  const epsGrowth =
    epsCur !== undefined && epsPrior && epsPrior !== 0
      ? (epsCur - epsPrior) / Math.abs(epsPrior)
      : undefined;

  return {
    totalRevenue: revenue,
    netIncome,
    ebitda: val("EBITDA"),
    ebit: val("EBIT"),
    earningsPerShare: val("EPS (Diluted)"),
    bookValuePerShare: val("Book Value Per Share"),
    grossMargin: val("Gross Margin (%)") ?? val("Gross Margin (%) "),
    operatingMargin: val("Operating Margin (%) ") ?? val("EBIT Margin (%)"),
    netMargin: val("Net Margin (%)") ?? val("Net Margin (%) "),
    returnOnEquity: val("Return on Equity (%)"),
    returnOnAssets: val("Return on Asset (%)"),
    totalStockholdersEquity: val("Total Shareholder Equity"),
    freeCashFlow: val("Free Cash Flow"),
    quarterlyOperatingCashFlow: val("Net Operating Cash Flow"),
    cashAndEquivalents: val("Cash & ST Inv"),
    currentRatio: val("Current Ratio"),
    debtToEquity: (() => {
      const v = byLabel.get("Total Debt / Total Eq (%)");
      if (!v) return undefined;
      const n = Number(v.cells[1] ?? v.cells[2]);
      return isFinite(n) ? n / 100 : undefined;
    })(),
    revenueGrowthYoY,
    epsGrowth,
  };
}
