/**
 * A215 — cadence max lag (trading days) mirrored from
 * scripts/watchlist_sync/data_freshness.py CHECKS. One home for UI tooltips.
 */
export type CadenceCheck = {
  table: string;
  maxLag: number;
  what: string;
};

/** Same rows as data_freshness.py CHECKS (table → max trading days behind last close). */
export const FRESHNESS_CHECKS: CadenceCheck[] = [
  { table: "lseg_research.daily_history", maxLag: 1, what: "Model List IV/price · daily.py lseg" },
  { table: "public.prices_historical", maxLag: 1, what: "charts, scores · Schwab/Yahoo bars" },
  { table: "public.option_score_snapshots", maxLag: 1, what: "Rankings › Options · option scan" },
  { table: "public.option_chain_history", maxLag: 1, what: "option history · same scan" },
  { table: "public.ticker_atm_iv_snapshots", maxLag: 1, what: "IV columns · option scan" },
  { table: "watchlist_sync.fit_scores", maxLag: 1, what: "Model List fit · daily.py" },
  { table: "watchlist_sync.put_edge_daily", maxLag: 1, what: "Model List put edge · daily.py" },
  { table: "watchlist_sync.house_view", maxLag: 1, what: "house view · daily.py" },
  { table: "watchlist_sync.forecast_ledger", maxLag: 1, what: "grades / drift · daily.py" },
  { table: "public.tech_score_snapshots", maxLag: 1, what: "tech score · maintain" },
  { table: "public.fund_score_snapshots", maxLag: 1, what: "fund score · maintain" },
  { table: "public.source_fundamentals", maxLag: 3, what: "fundamentals · maintain enrichment" },
  { table: "public.earnings_calendar", maxLag: 1, what: "earnings dates · API" },
  { table: "public.street_pt_daily", maxLag: 1, what: "street PT · API" },
  { table: "public.market_breadth_daily", maxLag: 1, what: "breadth · maintain" },
  { table: "optlab.underlying", maxLag: 1, what: "Options history · option_history.py" },
  { table: "optlab.iv30", maxLag: 1, what: "IV rank · option_derive" },
  { table: "public.model_recs", maxLag: 5, what: "model track record (weekly)" },
  { table: "lseg_research.signals_daily", maxLag: 1, what: "StarMine live · daily.py" },
  { table: "lseg_research.starmine_history", maxLag: 20, what: "StarMine history (monthly by design)" },
];

const BY_TABLE = new Map(FRESHNESS_CHECKS.map((c) => [c.table, c]));

/** Map tip surfaces → CHECKS table key. */
export const TIP_CADENCE: Record<string, string> = {
  fund_score: "public.fund_score_snapshots",
  tech_score: "public.tech_score_snapshots",
  option_score: "public.option_score_snapshots",
  fundamentals: "public.source_fundamentals",
  earnings: "public.earnings_calendar",
  street_pt: "public.street_pt_daily",
  prices: "public.prices_historical",
  model_recs: "public.model_recs",
  starmine: "lseg_research.signals_daily",
};

/** Weekday-approx trading-day lag (Mon–Fri). Good enough for tooltip; server --json is exact. */
export function approxTradingDayLag(asOf: string | null | undefined, now = new Date()): number | null {
  if (!asOf) return null;
  const start = new Date(asOf);
  if (Number.isNaN(start.getTime())) return null;
  // Use calendar date in ET-ish: truncate to UTC date of asOf
  let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (d >= end) return 0;
  let n = 0;
  d = new Date(d.getTime() + 864e5);
  while (d <= end) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
    d = new Date(d.getTime() + 864e5);
  }
  return n;
}

export function cadenceClause(
  asOf: string | null | undefined,
  tableOrKey: string | null | undefined,
): string | null {
  if (!tableOrKey) return null;
  const table = TIP_CADENCE[tableOrKey] ?? tableOrKey;
  const check = BY_TABLE.get(table);
  if (!check) return null;
  const lag = approxTradingDayLag(asOf);
  if (lag == null) return `cadence max ${check.maxLag}d · ${check.what}`;
  if (lag <= check.maxLag) return `fresh (${lag}d behind, max ${check.maxLag})`;
  return `${lag} trading days behind (max ${check.maxLag}) · ${check.what}`;
}
