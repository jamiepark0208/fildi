/**
 * A266 — fields we already pay for and were dropping.
 * Display + source_fundamentals only. Not score inputs.
 *
 * FactSet RATIO (Tier 1, total capital) is percent points — do not /100.
 * FactSet PERCENTAGE (ROTCE) is divided by 100, same as other margins.
 * Finnhub growth / payout follow this file's existing pct() (percent → decimal).
 * FMP ratios/key-metrics are already decimals (A263 AAPL payout 0.1377).
 */

export const MAPPED_FIELDS = [
  "forwardPe",
  "pegTtm",
  "epsGrowth5Y",
  "revenueGrowth5Y",
  "payoutRatio",
  "interestCoverage",
  "priceToFcf",
  "fcfYield",
  "sbcToRevenue",
  "incomeQuality",
  "priceToTbv",
  "tier1CapitalRatio",
  "totalCapitalRatio",
  "rotce",
  "netInterestIncome",
  "totalDeposits",
] as const;

export type MappedField = (typeof MAPPED_FIELDS)[number];

/**
 * Queued for an S089-style stock-board test (rel_21, marginal vs StarMine + lab_tech).
 * analysis/s089_osap_signals.py is a live study — do not edit it from this row.
 * tangibleBookValuePerShare is the existing gold column; FactSet TBV now fills it last.
 */
export const STOCK_BOARD_CANDIDATE_FIELDS = [
  ...MAPPED_FIELDS,
  "tangibleBookValuePerShare",
] as const;

export type VendorRawIdentity = {
  source: string;
  endpoint: string;
  key: string;
  latestOnly?: boolean;
};

export function vendorRawFromHttpUrl(source: string, url: string, latestOnly = false): VendorRawIdentity {
  const u = new URL(url);
  const drop = new Set(["apikey", "token", "api_key"]);
  const keyRaw = (
    u.searchParams.get("symbol")
    || u.searchParams.get("ticker")
    || u.pathname.split("/").filter(Boolean).pop()
    || "global"
  ).replace(/\.json$/i, "");
  const parts = [...u.searchParams.entries()]
    .filter(([k]) => {
      const lk = k.toLowerCase();
      return !drop.has(lk) && k !== "symbol" && k !== "ticker";
    })
    .sort(([a], [b]) => a.localeCompare(b));
  const q = parts.map(([k, v]) => `${k}=${v}`).join("&");
  const endpoint = q ? `${u.pathname}?${q}` : u.pathname;
  return {
    source,
    endpoint,
    key: keyRaw.toUpperCase(),
    latestOnly: latestOnly || /companyfacts/i.test(u.pathname),
  };
}

export type VendorRawDecision =
  | { op: "insert" }
  | { op: "touch"; fromDate: string }
  | { op: "replace" }
  | { op: "noop" };

/** New row only when the payload hash changed; otherwise move fetched_on forward. */
export function decideVendorRawAction(
  latest: { fetchedOn: string; payloadSha: string } | null,
  today: string,
  sha: string,
  _latestOnly = false,
): VendorRawDecision {
  if (!latest) return { op: "insert" };
  if (latest.payloadSha === sha) {
    return latest.fetchedOn === today ? { op: "noop" } : { op: "touch", fromDate: latest.fetchedOn };
  }
  return latest.fetchedOn === today ? { op: "replace" } : { op: "insert" };
}

function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Finnhub metric=all percent fields → decimal. Coverage ratios stay raw. */
function pct(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : n / 100;
}

export function mapFinnhubDropped(metric: Record<string, unknown>): Partial<Record<MappedField, number>> {
  return {
    forwardPe: num(metric.forwardPE),
    pegTtm: num(metric.pegTTM),
    epsGrowth5Y: pct(metric.epsGrowth5Y),
    revenueGrowth5Y: pct(metric.revenueGrowth5Y),
    payoutRatio: pct(metric.payoutRatioTTM),
    interestCoverage: num(metric.netInterestCoverageTTM),
    priceToTbv: num(metric.ptbvAnnual),
  };
}

export function mapFmpDropped(
  ratios: Record<string, unknown>,
  keyMetrics: Record<string, unknown>,
): Partial<Record<MappedField, number>> {
  return {
    payoutRatio: num(ratios.dividendPayoutRatio),
    // FMP returns 0 for net-interest-positive names (AAPL). 0 would beat Finnhub's real coverage.
    interestCoverage: (() => {
      const v = num(ratios.interestCoverageRatio);
      return v != null && v > 0 ? v : undefined;
    })(),
    priceToFcf: num(ratios.priceToFreeCashFlowRatio),
    fcfYield: num(keyMetrics.freeCashFlowYield),
    incomeQuality: num(keyMetrics.incomeQuality),
    sbcToRevenue: num(keyMetrics.stockBasedCompensationToRevenue),
  };
}

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
  annualOperatingCashFlow?: number;
  totalAssets?: number;
  cashAndEquivalents?: number;
  currentRatio?: number;
  debtToEquity?: number;
  revenueGrowthYoY?: number;
  epsGrowth?: number;
  peRatio?: number;
  priceToBook?: number;
  pegRatio?: number;
  forwardPe?: number;
  tangibleBookValuePerShare?: number;
  tier1CapitalRatio?: number;
  totalCapitalRatio?: number;
  rotce?: number;
  netInterestIncome?: number;
  totalDeposits?: number;
}

type FactSetRow = {
  cells?: (string | null)[];
  rowType?: string;
  rowMetadata?: {
    valueType?: { value?: string };
    rowType?: { value?: string };
    metric?: { value?: string };
    scale?: { value?: number | null };
  };
};

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** Fiscal-year end of a FactSet column header like "Dec '25" (last day of that month, UTC). */
export function factsetColumnEnd(label: string | null | undefined): Date | null {
  const m = /^([A-Z][a-z]{2}) '(\d{2})$/.exec((label ?? "").trim());
  if (!m || MONTHS[m[1]!] == null) return null;
  return new Date(Date.UTC(2000 + Number(m[2]), MONTHS[m[1]!]! + 1, 0));
}
/** Days after FY end before a column counts as reported actuals (10-K ≤ 60–90 d, 20-F ≤ 120 d → 100 covers all but late 20-F). */
export const FACTSET_ACTUAL_LAG_DAYS = 100;
/**
 * 11-11 (Jamie: "compare against the same dated data"): column 1 is the fiscal year IN PROGRESS = consensus estimates
 * (JPM "Dec '26" NI 67.3 B vs FY25 actual 56.8 B; NVDA "Jan '27" 225.6 B vs 120.1 B). Pick the newest column whose FY
 * ended ≥ FACTSET_ACTUAL_LAG_DAYS ago. No parseable header → null (caller writes nothing rather than guess).
 */
export function factsetActualColumn(headerCells: (string | null)[] | null, today = new Date()): { idx: number; periodEnd: Date } | null {
  if (!headerCells) return null;
  const cutoff = today.getTime() - FACTSET_ACTUAL_LAG_DAYS * 86_400_000;
  for (let i = 1; i < headerCells.length; i++) {
    const end = factsetColumnEnd(headerCells[i]);
    if (end && end.getTime() <= cutoff) return { idx: i, periodEnd: end };
  }
  return null;
}

/** Parse FactSet overview rows. RATIO stays percent points. PERCENTAGE /100. FIN scale 6 → millions. */
export function mapFactSetHighlightRows(rows: FactSetRow[], today = new Date()): FactSetFundamentalsPartial {
  type RowEntry = { cells: (string | null)[]; scale: number; isPct: boolean };
  const byLabel = new Map<string, RowEntry>();
  const header = rows.find((r) => r.rowType === "Header")?.cells ?? null;
  const actual = factsetActualColumn(header, today);
  // Legacy callers/tests without a header row keep column 1; a header with no reported FY → write nothing.
  const COL = header == null ? 1 : actual?.idx ?? -1;
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

  function val(label: string, colIdx = COL): number | undefined {
    if (colIdx < 0) return undefined;
    const entry = byLabel.get(label);
    if (!entry) return undefined;
    const raw = entry.cells[colIdx] ?? null;
    if (raw == null || raw === "") return undefined;
    const n = Number(raw);
    if (!isFinite(n)) return undefined;
    const scaled = entry.scale === 6 ? n * 1_000_000 : n;
    return entry.isPct ? scaled / 100 : scaled;
  }

  const revenue = val("Revenue");
  const netIncome = val("Net Income");
  const revPrior = val("Revenue", COL < 0 ? -1 : COL + 1);
  const epsPrior = val("EPS (Diluted)", COL < 0 ? -1 : COL + 1);
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
    // 11-11: column 1 = latest fiscal YEAR (AAPL "Sep '26" 151 B) — was stored as quarterly → cashrun ×4 = 4× annual
    annualOperatingCashFlow: val("Net Operating Cash Flow"),
    totalAssets: val("Total Assets"),
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
    tangibleBookValuePerShare: val("Tangible Book Value Per Share"),
    tier1CapitalRatio: val("Tier 1 Ratio"),
    totalCapitalRatio: val("Total Capital Ratio"),
    rotce: val("Return on Tangible Equity (%)"),
    netInterestIncome: val("Net Interest Income"),
    totalDeposits: val("Total Deposits"),
  };
}
