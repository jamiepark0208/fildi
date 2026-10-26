// Pure P&L / income calculations behind PortfolioAnalysis (moved out of the component; logic unchanged).
import { type PortfolioEntry, entryPortfolio } from "@/hooks/use-portfolio";
import { preferTxnStockRealized } from "./prefer-txn-stock-realized";
export { preferTxnStockRealized };

export interface RealizedEvent {
  account: string; symbol: string; assetType: "stock" | "option" | "dividend"; direction: "long" | "short" | null;
  optionType: "call" | "put" | null; qty: number; pnl: number; fees: number; closedAt: string;
}

export interface TickerEarningsRow {
  account: string; ticker: string;
  totalUnrealized: string | null; totalRealized: string | null; totalEarned: string | null;
  sellPut: string | null; sellCall: string | null; longCall: string | null; longPut: string | null;
  dividends: string | null; stocksRealized: string | null; stocksUnrealized: string | null; totalStocks: string | null;
}

// realizedEvents.account may be a Robinhood account id OR an export nickname (FILDI/IRA)
// depending on whether the event came from orders vs transactions. Canonicalize both.
export const ACCOUNT_TABS = [
  { key: "All", label: "All" },
  { key: "FILDI", label: "FILDI" },
  { key: "IRA", label: "IRA" },
] as const;
export type AccountTabKey = typeof ACCOUNT_TABS[number]["key"];

/** Map RH account id / "Traditional IRA" / "IRA" onto stable tab keys. */
export function canonicalizeAccount(raw: string, nickMap: Map<string, string>): string {
  const nick = nickMap.get(raw) ?? raw;
  const n = nick.trim();
  if (n === "Traditional IRA" || n === "IRA" || /\bIRA\b/i.test(n)) return "IRA";
  if (n === "FILDI") return "FILDI";
  return n;
}

/** Realized events for the page's top-level account filter ("All" = every account). */
export function scopeRealizedEvents(
  realizedEvents: RealizedEvent[], activePortfolio: string, nickMap: Map<string, string>,
): RealizedEvent[] {
  return activePortfolio === "All"
    ? realizedEvents
    : realizedEvents.filter(e =>
        canonicalizeAccount(e.account, nickMap) === canonicalizeAccount(activePortfolio, nickMap));
}

// ── P&L: realized (from transaction history) + unrealized (from open positions) ──
export function computePnlTotals(
  scopedRealizedEvents: RealizedEvent[],
  positions: PortfolioEntry[],
  liveUnrealizedFor: (e: PortfolioEntry) => number,
) {
  const stockRealized = scopedRealizedEvents.filter(e => e.assetType === "stock").reduce((s, e) => s + e.pnl, 0);
  const realizedFor = (direction: "short" | "long", optionType: "call" | "put") =>
    scopedRealizedEvents.filter(e => e.assetType === "option" && e.direction === direction && e.optionType === optionType)
      .reduce((s, e) => s + e.pnl, 0);
  const shortCallRealized = realizedFor("short", "call");
  const shortPutRealized  = realizedFor("short", "put");
  const longCallRealized  = realizedFor("long", "call");
  const longPutRealized   = realizedFor("long", "put");
  // Cash bonuses are migrated as dividend rows (no ticker-specific holding), so this
  // sums both — pure cash income, no unrealized leg.
  const dividendRealized  = scopedRealizedEvents.filter(e => e.assetType === "dividend").reduce((s, e) => s + e.pnl, 0);

  const stockUnrealized = positions.filter(e => e.positionType === "stock").reduce((s, e) => s + liveUnrealizedFor(e), 0);
  const unrealizedFor = (positionType: string) =>
    positions.filter(e => e.positionType === positionType).reduce((s, e) => s + liveUnrealizedFor(e), 0);
  const shortCallUnrealized = unrealizedFor("short_call");
  const shortPutUnrealized  = unrealizedFor("short_put");
  const longCallUnrealized  = unrealizedFor("long_call");
  const longPutUnrealized   = unrealizedFor("long_put");

  const optionShortRealized = shortCallRealized + shortPutRealized;
  const optionLongRealized  = longCallRealized + longPutRealized;
  const optionShortUnrealized = shortCallUnrealized + shortPutUnrealized;
  const optionLongUnrealized  = longCallUnrealized + longPutUnrealized;

  const rows = [
    { label: "Stock",                  realized: stockRealized,     unrealized: stockUnrealized },
    { label: "Options — Short Call",   realized: shortCallRealized, unrealized: shortCallUnrealized },
    { label: "Options — Short Put",    realized: shortPutRealized,  unrealized: shortPutUnrealized },
    { label: "Options — Long Call",    realized: longCallRealized,  unrealized: longCallUnrealized },
    { label: "Options — Long Put",     realized: longPutRealized,   unrealized: longPutUnrealized },
    { label: "Dividends",              realized: dividendRealized,  unrealized: 0 },
  ].map(r => ({ ...r, total: r.realized + r.unrealized }));

  const grandTotal = {
    realized: stockRealized + optionShortRealized + optionLongRealized + dividendRealized,
    unrealized: stockUnrealized + optionShortUnrealized + optionLongUnrealized,
    total: stockRealized + optionShortRealized + optionLongRealized + dividendRealized + stockUnrealized + optionShortUnrealized + optionLongUnrealized,
  };

  return { rows, grandTotal };
}

/** Running realized total by close date (one point per day). */
export function buildRealizedTimeline(scopedRealizedEvents: RealizedEvent[]): { date: string; cumulative: number }[] {
  const sorted = [...scopedRealizedEvents].sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());
  let running = 0;
  const byDay = new Map<string, number>();
  sorted.forEach(e => {
    running += e.pnl;
    byDay.set(e.closedAt.slice(0, 10), running);
  });
  return Array.from(byDay.entries()).map(([date, cumulative]) => ({ date, cumulative }));
}

// ── Top tickers by trade frequency, net realized P&L YTD — split by account ──
export function buildTopTickersByAccount(realizedEvents: RealizedEvent[], nickMap: Map<string, string>) {
  const currentYear = new Date().getFullYear();
  const buildFor = (accountKey: AccountTabKey) => {
    const bySymbol = new Map<string, { puts: number; calls: number; stockSales: number; netPnl: number }>();
    realizedEvents.forEach(e => {
      if (e.assetType === "dividend") return;
      const acct = canonicalizeAccount(e.account, nickMap);
      if (accountKey !== "All" && acct !== accountKey) return;
      if (new Date(e.closedAt).getFullYear() !== currentYear) return;
      const cur = bySymbol.get(e.symbol) ?? { puts: 0, calls: 0, stockSales: 0, netPnl: 0 };
      if (e.assetType === "option" && e.direction === "short" && e.optionType === "put") cur.puts += 1;
      else if (e.assetType === "option" && e.direction === "short" && e.optionType === "call") cur.calls += 1;
      else if (e.assetType === "stock") cur.stockSales += 1;
      cur.netPnl += e.pnl;
      bySymbol.set(e.symbol, cur);
    });
    const all = Array.from(bySymbol.entries())
      .map(([symbol, v]) => ({ symbol, ...v, count: v.puts + v.calls + v.stockSales }))
      .sort((a, b) => b.count - a.count || b.netPnl - a.netPnl);
    return all;
  };
  return Object.fromEntries(ACCOUNT_TABS.map(t => [t.key, buildFor(t.key)])) as Record<AccountTabKey, ReturnType<typeof buildFor>>;
}

// ── Cumulative summary per ticker — mirrors the CSV's per-account SUMMARY table ──
// Prefers the imported ticker-earnings-summary export (authoritative, computed
// upstream from full tax-lot data) over recomputing from realizedEvents, which
// depends on legEffect open/close chaining that the flat transactions export
// doesn't carry. Falls back to the realizedEvents computation only when no
// ticker-earnings CSV has been imported yet.
// Stock capital gains from assignment_buy/sell (now in realizedEvents) are merged
// into stocksRealized when the earnings export under-reports them (missing call-away).
const num = (v: string | null) => (v == null ? 0 : parseFloat(v)) || 0;

export function buildCumulativeSummaryByAccount(
  realizedEvents: RealizedEvent[],
  entries: PortfolioEntry[],
  tickerEarnings: TickerEarningsRow[],
  nickMap: Map<string, string>,
) {
  const stockPnlByAccountTicker = new Map<string, number>();
  realizedEvents.forEach(e => {
    if (e.assetType !== "stock") return;
    const acct = canonicalizeAccount(e.account, nickMap);
    const k = `${acct}::${e.symbol}`;
    stockPnlByAccountTicker.set(k, (stockPnlByAccountTicker.get(k) ?? 0) + e.pnl);
  });

  const buildFromImported = (accountKey: AccountTabKey) => {
    const rows = tickerEarnings
      .filter(r => {
        const acct = canonicalizeAccount(r.account, nickMap);
        return accountKey === "All" || acct === accountKey;
      })
      .map(r => {
        const acct = canonicalizeAccount(r.account, nickMap);
        const txnStock = stockPnlByAccountTicker.get(`${acct}::${r.ticker}`) ?? 0;
        const chosen = preferTxnStockRealized(num(r.stocksRealized), txnStock);
        const stocksRealized = chosen.value;
        const stocksRealizedMixed = chosen.mixed;
        const sellPut = num(r.sellPut), sellCall = num(r.sellCall);
        const longCall = num(r.longCall), longPut = num(r.longPut);
        const dividends = num(r.dividends);
        const stocksUnrealized = num(r.stocksUnrealized);
        const optionsUnrealized = num(r.totalUnrealized) - stocksUnrealized;
        const totalRealized = sellPut + sellCall + longCall + longPut + stocksRealized;
        const totalUnrealized = stocksUnrealized + optionsUnrealized;
        const totalStocks = stocksRealized + stocksUnrealized;
        const totalEarned = totalRealized + totalUnrealized + dividends;
        return {
          ticker: r.ticker, sellPut, sellCall, longCall, longPut, stocksRealized, dividends,
          stocksUnrealized, optionsUnrealized, totalRealized, totalUnrealized, totalStocks, totalEarned,
          stocksRealizedMixed,
        };
      });
    // Aggregate across accounts when All is selected (same ticker may appear twice).
    if (accountKey !== "All") return rows.sort((a, b) => b.totalEarned - a.totalEarned);
    const byTicker = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const cur = byTicker.get(r.ticker);
      if (!cur) { byTicker.set(r.ticker, { ...r }); continue; }
      cur.sellPut += r.sellPut; cur.sellCall += r.sellCall;
      cur.longCall += r.longCall; cur.longPut += r.longPut;
      cur.stocksRealized += r.stocksRealized; cur.dividends += r.dividends;
      cur.stocksUnrealized += r.stocksUnrealized; cur.optionsUnrealized += r.optionsUnrealized;
      cur.totalRealized += r.totalRealized; cur.totalUnrealized += r.totalUnrealized;
      cur.totalStocks += r.totalStocks; cur.totalEarned += r.totalEarned;
      cur.stocksRealizedMixed = cur.stocksRealizedMixed || r.stocksRealizedMixed;
    }
    return Array.from(byTicker.values()).sort((a, b) => b.totalEarned - a.totalEarned);
  };
  const buildFromRealizedEvents = (accountKey: AccountTabKey) => {
    const rows = new Map<string, {
      sellPut: number; sellCall: number; longCall: number; longPut: number;
      stocksRealized: number; dividends: number; stocksUnrealized: number; optionsUnrealized: number;
    }>();
    const ensure = (t: string) => {
      if (!rows.has(t)) rows.set(t, { sellPut: 0, sellCall: 0, longCall: 0, longPut: 0, stocksRealized: 0, dividends: 0, stocksUnrealized: 0, optionsUnrealized: 0 });
      return rows.get(t)!;
    };
    realizedEvents.forEach(e => {
      const acct = canonicalizeAccount(e.account, nickMap);
      if (accountKey !== "All" && acct !== accountKey) return;
      if (e.assetType === "dividend") { ensure(e.symbol).dividends += e.pnl; return; }
      if (e.assetType === "stock") { ensure(e.symbol).stocksRealized += e.pnl; return; }
      const row = ensure(e.symbol);
      if (e.direction === "short" && e.optionType === "put") row.sellPut += e.pnl;
      else if (e.direction === "short" && e.optionType === "call") row.sellCall += e.pnl;
      else if (e.direction === "long" && e.optionType === "call") row.longCall += e.pnl;
      else if (e.direction === "long" && e.optionType === "put") row.longPut += e.pnl;
    });
    entries.forEach(e => {
      const acct = canonicalizeAccount(entryPortfolio(e), nickMap);
      if (accountKey !== "All" && acct !== accountKey) return;
      const row = ensure(e.ticker);
      if (e.positionType === "stock") row.stocksUnrealized += e.unrealizedPnL ?? 0;
      else row.optionsUnrealized += e.unrealizedPnL ?? 0;
    });
    return Array.from(rows.entries()).map(([ticker, v]) => {
      const totalRealized = v.sellPut + v.sellCall + v.longCall + v.longPut + v.stocksRealized;
      const totalUnrealized = v.stocksUnrealized + v.optionsUnrealized;
      const totalStocks = v.stocksRealized + v.stocksUnrealized;
      const totalEarned = totalRealized + totalUnrealized + v.dividends;
      return { ticker, ...v, totalRealized, totalUnrealized, totalStocks, totalEarned, stocksRealizedMixed: false };
    }).sort((a, b) => b.totalEarned - a.totalEarned);
  };
  const buildFor = tickerEarnings.length > 0 ? buildFromImported : buildFromRealizedEvents;
  return Object.fromEntries(ACCOUNT_TABS.map(t => [t.key, buildFor(t.key)])) as Record<AccountTabKey, ReturnType<typeof buildFromRealizedEvents>>;
}

// ── Options income timeline — YTD bi-weekly realized P&L (sold calls + sold puts,
// expired worthless or closed early) plus a projection to year-end off the YTD run rate ──
export function buildOptionsIncomeTimeline(scopedRealizedEvents: RealizedEvent[], now = new Date()) {
  const year = now.getFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));

  const shortOptionEvents = scopedRealizedEvents.filter(e =>
    e.assetType === "option" && e.direction === "short" &&
    (e.optionType === "call" || e.optionType === "put") &&
    new Date(e.closedAt).getFullYear() === year);

  // 14-day periods spanning the full year; the last period is clamped short.
  const periods: { start: Date; end: Date; label: string }[] = [];
  for (let cursor = yearStart.getTime(); cursor <= yearEnd.getTime(); cursor += 14 * 86400000) {
    const start = new Date(cursor);
    const end = new Date(Math.min(cursor + 13 * 86400000, yearEnd.getTime()));
    periods.push({ start, end, label: start.toLocaleDateString("en-US", { month: "short", day: "numeric" }) });
  }

  let ytdActual = 0;
  const actualByPeriod = periods.map(p => {
    if (p.start > now) return 0;
    const sum = shortOptionEvents
      .filter(e => { const d = new Date(e.closedAt); return d >= p.start && d <= p.end; })
      .reduce((s, e) => s + e.pnl, 0);
    ytdActual += sum;
    return sum;
  });

  // Run rate: YTD earned divided by months elapsed (fractional), projected across the
  // months left in the year — this is a simple linear extrapolation, not a forecast model.
  const daysElapsed = Math.max(1, (now.getTime() - yearStart.getTime()) / 86400000);
  const monthsElapsed = daysElapsed / (365 / 12);
  const avgMonthlyEarned = ytdActual / monthsElapsed;
  const monthsRemaining = Math.max(0, 12 - monthsElapsed);
  const projectedRemaining = avgMonthlyEarned * monthsRemaining;
  const remainingPeriods = periods.filter(p => p.start > now);
  const projectedPerPeriod = remainingPeriods.length > 0 ? projectedRemaining / remainingPeriods.length : 0;

  const chartData = periods.map((p, i) => ({
    label: p.label,
    isFuture: p.start > now,
    actual: p.start > now ? 0 : actualByPeriod[i],
    projected: p.start > now ? projectedPerPeriod : 0,
  }));

  return {
    chartData, ytdActual, avgMonthlyEarned,
    projectedAnnualTotal: ytdActual + projectedRemaining,
  };
}
