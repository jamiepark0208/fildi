import { useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import {
  Cell, BarChart, Bar, AreaChart, Area, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  type PortfolioEntry, cashCollateral, premiumReceived,
  daysToExpiry, isShortPosition, entryPortfolio,
} from "@/hooks/use-portfolio";
import { type StockMetrics } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatCompactCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Activity, Shield, Zap, TrendingDown, Layers, BarChart2, Percent } from "lucide-react";
import {
  TTH, TTD, formatStrike, PALETTE, SECTOR_OVERRIDES, isSameUnderlyingPair,
  BETA_BAR_LEGEND, REALIZED_UNREALIZED_LEGEND, TICKER_PNL_SEGMENTS, correlationBg,
} from "./portfolio/portfolio-palette";
import { detectCoveredCalls } from "./portfolio/covered-calls-detector";
import { DonutChart, PieLegend } from "./portfolio/portfolio-charts";
import {
  computeMarginUsage, computeConcentration, computeGreeksExposure,
  computeCorrelationScaleMax, computePortfolioRiskMetrics,
} from "./portfolio/portfolio-risk-calc";
import { useSnapshotQuery, EquityTable, OptionsTable } from "./RobinhoodPortfolio";
import { PortfolioUpload } from "./PortfolioUpload";

// ── Portfolio Analysis ────────────────────────────────────────────────────────

export interface AccountSummary {
  account: string; nickname: string | null; totalValue: string | null;
  equityValue: string | null; optionsValue: string | null; cryptoValue: string | null; cash: string | null;
  marginUsed: string | null; buyingPower: string | null;
}

interface RealizedEvent {
  account: string; symbol: string; assetType: "stock" | "option" | "dividend"; direction: "long" | "short" | null;
  optionType: "call" | "put" | null; qty: number; pnl: number; fees: number; closedAt: string;
}

interface TickerEarningsRow {
  account: string; ticker: string;
  totalUnrealized: string | null; totalRealized: string | null; totalEarned: string | null;
  sellPut: string | null; sellCall: string | null; longCall: string | null; longPut: string | null;
  dividends: string | null; stocksRealized: string | null; stocksUnrealized: string | null; totalStocks: string | null;
}

export interface PortfolioRiskResult {
  tickers: string[];
  correlationMatrix: number[][];
  dailyVolatilityPct: number;
  var95Pct: number; cvar95Pct: number; var95Usd: number; cvar95Usd: number;
  skippedTickers: string[];
}

interface PortfolioAnalysisProps {
  entries: PortfolioEntry[];
  priceMap: Record<string, number | undefined>;
  stockDataMap: Record<string, StockMetrics>;
  portfolioNames: string[];
  accountSummaries?: AccountSummary[];
  realizedEvents?: RealizedEvent[];
  tickerEarnings?: TickerEarningsRow[];
  earningsCalendar?: Record<string, string | null>;
  onUploadSuccess?: () => void;
}

/** Map RH account id / "Traditional IRA" / "IRA" onto stable tab keys. */
function canonicalizeAccount(raw: string, nickMap: Map<string, string>): string {
  const nick = nickMap.get(raw) ?? raw;
  const n = nick.trim();
  if (n === "Traditional IRA" || n === "IRA" || /\bIRA\b/i.test(n)) return "IRA";
  if (n === "FILDI") return "FILDI";
  return n;
}

export function PortfolioAnalysis({ entries, priceMap, stockDataMap, portfolioNames, accountSummaries = [], realizedEvents = [], tickerEarnings = [], earningsCalendar = {}, onUploadSuccess }: PortfolioAnalysisProps) {
  const [activePortfolio, setActivePortfolio] = useState<string>("All");
  const filtered = useMemo(() =>
    (activePortfolio === "All"
      ? entries
      : entries.filter(e => entryPortfolio(e) === activePortfolio)
    ).filter(e => e.positionType !== "crypto"),
  [entries, activePortfolio]);

  // ── Covered call detection ──────────────────────────────────────────────────
  const coveredCalls = useMemo(() => detectCoveredCalls(filtered), [filtered]);

  const positionValue = (e: PortfolioEntry) => e.currentValue != null
    ? e.currentValue
    : e.positionType === "stock"
      ? (priceMap[e.ticker] ?? e.avgPrice) * e.qty
      : cashCollateral(e) || e.avgPrice * 100 * e.qty;

  // Ticker-level composition of a slice, for the donut hover tooltip — e.g. "what
  // makes up this 83.8% Stock Equity wedge". pct is relative to the slice itself,
  // not the whole-account total, so it always foots to 100% within the tooltip.
  const tickerBreakdown = (positions: PortfolioEntry[]) => {
    const byTicker: Record<string, number> = {};
    positions.forEach(e => { byTicker[e.ticker] = (byTicker[e.ticker] ?? 0) + positionValue(e); });
    const sliceTotal = Object.values(byTicker).reduce((s, v) => s + v, 0);
    return Object.entries(byTicker)
      .map(([name, value]) => ({ name, value, pct: sliceTotal > 0 ? (value / sliceTotal) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  };

  // ── Allocation ──────────────────────────────────────────────────────────────
  // Sourced from Robinhood's own per-account "Account Summary" CSV section (Equity
  // Value / Options Value / Crypto Value / Cash) — these sum exactly to the account's
  // Total Value by construction, so this is the single reconciled source of truth for
  // the donut (previously computed bottom-up from individual positions, which drifted
  // from the Portfolio Value banner by the value of un-modeled short-option liability).
  const { allocationData, totalValue, marginUsed: allocationMarginUsed } = useMemo(() => {
    const scopedSummaries = activePortfolio === "All"
      ? accountSummaries
      : accountSummaries.filter(a => (a.nickname ?? a.account) === activePortfolio);
    let stockVal = 0, cash = 0, crypto = 0, total = 0, marginUsed = 0;
    scopedSummaries.forEach(a => {
      stockVal   += parseFloat(a.equityValue ?? "0");
      cash       += parseFloat(a.cash ?? "0");
      crypto     += parseFloat(a.cryptoValue ?? "0");
      total      += parseFloat(a.totalValue ?? "0");
      marginUsed += parseFloat(a.marginUsed ?? "0");
    });
    const stockPositions = filtered.filter(e => e.positionType === "stock");
    // Covered calls need no separate wedge — their collateral is the underlying
    // shares, already counted in Stock Equity. Cash-secured puts are the one type
    // of option that actually locks up capital outside of Stock Equity, so they get
    // carved out of Cash below instead of lumping all options into one P&L wedge.
    const shortPuts     = filtered.filter(e => e.positionType === "short_put");
    const putCollateral = shortPuts.reduce((s, e) => s + cashCollateral(e), 0);
    const cashFree       = cash - putCollateral;

    // NOTE: Margin can't be its own wedge here — the borrowed dollars are already
    // embedded inside Stock Equity/Put Collateral (that's what buying/securing on
    // margin means), so adding a same-size Margin wedge on top double-counts it
    // (verified: wedges summed to ~150% of gross total on the FILDI test account).
    // `total` stays Robinhood's net account value (assets minus the margin loan);
    // marginUsed is surfaced as a separate stat below, not folded into the pie.
    return {
      totalValue: total,
      marginUsed,
      allocationData: [
        { name: "Stock Equity",   value: stockVal,     color: "#38bdf8", pct: total > 0 ? (stockVal/total)*100 : 0,
          breakdown: tickerBreakdown(stockPositions) },
        { name: "Cash (Free)",    value: cashFree,      color: "#a78bfa", pct: total > 0 ? (cashFree/total)*100 : 0 },
        { name: "Put Collateral", value: putCollateral, color: "#fbbf24", pct: total > 0 ? (putCollateral/total)*100 : 0,
          breakdown: tickerBreakdown(shortPuts) },
        { name: "Crypto",         value: crypto,        color: "#f472b6", pct: total > 0 ? (crypto/total)*100 : 0 },
      ].filter(d => d.value > 0),
    };
  }, [accountSummaries, activePortfolio, filtered]);

  // ── Margin usage ──────────────────────────────────────────────────────────────
  // margin_used/buying_power are N/A (null) for cash-only accounts (e.g. the IRA) —
  // only accounts actually trading on margin (e.g. FILDI) carry a value here.
  const marginUsage = useMemo(
    () => computeMarginUsage(accountSummaries, activePortfolio),
    [accountSummaries, activePortfolio],
  );

  // ── Sector ──────────────────────────────────────────────────────────────────
  const sectorData = useMemo(() => {
    const bySector: Record<string, number> = {};
    const positionsBySector: Record<string, PortfolioEntry[]> = {};
    filtered.forEach(e => {
      const sector = SECTOR_OVERRIDES[e.ticker] || stockDataMap[e.ticker]?.sector || "Unknown";
      bySector[sector] = (bySector[sector] ?? 0) + positionValue(e);
      (positionsBySector[sector] ??= []).push(e);
    });
    const total = Object.values(bySector).reduce((s, v) => s + v, 0);
    return {
      total,
      items: Object.entries(bySector)
        .map(([name, value], i) => ({
          name, value, color: PALETTE[i % PALETTE.length], pct: total > 0 ? (value/total)*100 : 0,
          breakdown: tickerBreakdown(positionsBySector[name]),
        }))
        .sort((a, b) => b.value - a.value),
    };
  }, [filtered, priceMap, stockDataMap]);

  // ── Ticker holdings ──────────────────────────────────────────────────────────
  const tickerData = useMemo(() => {
    const byTicker: Record<string, number> = {};
    filtered.forEach(e => {
      byTicker[e.ticker] = (byTicker[e.ticker] ?? 0) + positionValue(e);
    });
    const total = Object.values(byTicker).reduce((s, v) => s + v, 0);
    return {
      total,
      items: Object.entries(byTicker)
        .map(([name, value], i) => ({ name, value, color: PALETTE[i % PALETTE.length], pct: total > 0 ? (value/total)*100 : 0 }))
        .sort((a, b) => b.value - a.value),
    };
  }, [filtered, priceMap]);

  // ── Beta (covered-call adjusted) ────────────────────────────────────────────
  const betaData = useMemo(() => {
    const byTicker: Record<string, { value: number; beta: number }> = {};
    filtered.forEach(e => {
      const beta  = stockDataMap[e.ticker]?.beta ?? 1;
      const value = e.currentValue != null
        ? e.currentValue
        : e.positionType === "stock"
          ? (priceMap[e.ticker] ?? e.avgPrice) * e.qty
          : cashCollateral(e) || e.avgPrice * 100 * e.qty;
      if (!byTicker[e.ticker]) byTicker[e.ticker] = { value: 0, beta };
      byTicker[e.ticker].value += value;
    });

    const total = Object.values(byTicker).reduce((s, v) => s + v.value, 0);
    if (total === 0) return [];

    return Object.entries(byTicker).map(([ticker, { value, beta }]) => {
      // Covered calls reduce effective delta (stock delta 1.0 - short call delta ~0.30 = ~0.70)
      const deltaAdj = coveredCalls.has(ticker) ? 0.70 : 1.0;
      return {
        ticker,
        beta: parseFloat(beta.toFixed(2)),
        contribution: parseFloat(((value / total) * beta * deltaAdj).toFixed(3)),
        weight: parseFloat(((value / total) * 100).toFixed(1)),
        covered: coveredCalls.has(ticker),
      };
    }).sort((a, b) => b.contribution - a.contribution);
  }, [filtered, priceMap, stockDataMap, coveredCalls]);
  const topBetaData = useMemo(() => betaData.slice(0, 10), [betaData]);

  // ── Concentration risk (HHI + top-5 tickers) ────────────────────────────────
  // HHI on a standard 0-10,000 scale (sum of squared % weights, e.g. two tickers at
  // 50% each = 5,000; fully diversified across many small positions → near 0).
  const concentration = useMemo(() => computeConcentration(betaData), [betaData]);

  // ── Portfolio Greeks (Vega/Gamma exposure) ──────────────────────────────────
  // Position-level sign flips for short options (selling a put/call means you're
  // short that option's gamma/vega, i.e. exposure runs opposite the raw per-contract
  // Greek) — same convention as the Delta/Theta banners elsewhere in this app.
  const greeksExposure = useMemo(() => computeGreeksExposure(filtered), [filtered]);

  // ── Liquidity / spread risk ──────────────────────────────────────────────────
  // CSV bid/ask are a stale snapshot from import time — same problem the options
  // scanner solves by hitting Yahoo live. Reuse its exact per-contract endpoint
  // (/api/options/position-quote → getOptionPositionQuote) instead of the CSV values.
  const openOptionPositions = useMemo(
    () => filtered.filter(e => isShortPosition(e.positionType) || e.positionType === "long_put" || e.positionType === "long_call")
      .filter(e => e.strike != null && e.expiry),
    [filtered],
  );

  // ── Earnings-date risk ───────────────────────────────────────────────────────
  // Flags any open contract whose expiration spans the underlying's next
  // scheduled earnings report — IV crush risk, worst on exactly the high-IV
  // small/mid-caps this account sells premium on. earningsCalendar is the
  // next FUTURE report date per ticker (server-side, from earnings_calendar);
  // a position flags when today <= reportDate <= expiry.
  const earningsRiskPositions = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return openOptionPositions
      .map(e => ({ entry: e, reportDate: earningsCalendar[e.ticker.toUpperCase()] ?? null }))
      .filter(({ reportDate }) => reportDate != null && reportDate >= today)
      .filter(({ entry, reportDate }) => reportDate! <= entry.expiry!)
      .map(({ entry, reportDate }) => ({ entry, reportDate: reportDate! }));
  }, [openOptionPositions, earningsCalendar]);

  const liquidityQueries = useQueries({
    queries: openOptionPositions.map(e => {
      const optionType: "call" | "put" = e.positionType.includes("call") ? "call" : "put";
      return {
        queryKey: ["option-position-quote", e.ticker, e.expiry, e.strike, optionType],
        queryFn: async () => {
          const params = new URLSearchParams({ ticker: e.ticker, expiry: e.expiry!, strike: String(e.strike), type: optionType });
          const res = await fetch(`/api/options/position-quote?${params}`, { credentials: "include" });
          if (!res.ok) throw new Error("Failed to fetch live quote");
          return res.json() as Promise<{ bid: number | null; ask: number | null; midPrice: number | null; delta: number | null }>;
        },
        staleTime: 5 * 60 * 1000,
      };
    }),
  });

  const liquidityRisk = useMemo(() => {
    let wide = 0, moderate = 0, checked = 0;
    liquidityQueries.forEach(q => {
      const d = q.data;
      if (!d || d.bid == null || d.ask == null || d.midPrice == null || d.midPrice <= 0) return;
      checked++;
      const spreadPct = (d.ask - d.bid) / d.midPrice;
      if (spreadPct >= 0.40) wide++;
      else if (spreadPct >= 0.20) moderate++;
    });
    return { wide, moderate, checked };
  }, [liquidityQueries]);

  // ── Correlation matrix + parametric VaR/CVaR ────────────────────────────────
  // betaData already carries per-ticker notional weight — reuse it as the risk
  // endpoint's input instead of re-deriving position sizing server-side.
  const riskPositions = useMemo(
    () => betaData.map(d => ({ ticker: d.ticker, weight: d.weight })),
    [betaData],
  );
  const riskKey = useMemo(() => riskPositions.map(p => `${p.ticker}:${p.weight}`).sort().join(","), [riskPositions]);

  const { data: portfolioRisk } = useQuery<PortfolioRiskResult>({
    queryKey: ["portfolio-risk", riskKey],
    queryFn: async () => {
      const res = await fetch("/api/portfolio/risk", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ positions: riskPositions, portfolioValueUsd: totalValue }),
      });
      if (!res.ok) throw new Error("Failed to compute portfolio risk");
      return res.json();
    },
    enabled: riskPositions.length > 0,
    staleTime: 15 * 60 * 1000,
  });

  // Scale bound for the correlation heatmap — excludes the diagonal (always 1.00) and
  // same-underlying pairs (mechanically ~1, would otherwise wash out real variation).
  const correlationScaleMax = useMemo(
    () => computeCorrelationScaleMax(portfolioRisk),
    [portfolioRisk],
  );

  // ── Account nicknames (id → FILDI / Traditional IRA) — needed to scope
  // realizedEvents (which key off raw account ids OR export nicknames
  // depending on source) by the SAME top-level activePortfolio tab that
  // already scopes `filtered`/unrealized below. Moved above pnlTotals —
  // previously pnlTotals summed realizedEvents across BOTH accounts
  // unconditionally while its unrealized side correctly respected
  // activePortfolio, so switching the top tab to IRA left "Realized"
  // showing combined FILDI+IRA while "Unrealized" showed IRA-only —
  // an inconsistent, wrong "Total" whenever a single account was selected.
  const accountNickMap = useMemo(() => {
    const m = new Map<string, string>();
    accountSummaries.forEach(a => m.set(a.account, a.nickname ?? a.account));
    return m;
  }, [accountSummaries]);

  // ── Live unrealized P&L — CSV-stored unrealizedPnL is only as fresh as the
  // last import (can be a day+ stale); recompute live from the same quote
  // sources already fetched elsewhere in this component (priceMap for stock,
  // liquidityQueries' per-contract midPrice for options) instead. Falls back
  // to the stale stored value only while a live quote hasn't loaded yet, so
  // numbers don't flash to $0 during the initial fetch.
  const liveOptionMidByEntryId = useMemo(() => {
    const m = new Map<string, number>();
    openOptionPositions.forEach((e, i) => {
      const mid = liquidityQueries[i]?.data?.midPrice;
      if (mid != null) m.set(e.id, mid);
    });
    return m;
  }, [openOptionPositions, liquidityQueries]);

  // Live delta per open option position — same quote call as above, used for
  // the assignment-risk alert (see Position Health table): delta is a much
  // more standard risk measure than raw moneyness %, and the live quote
  // endpoint already computes it via Black-Scholes from live IV/spot.
  const liveOptionDeltaByEntryId = useMemo(() => {
    const m = new Map<string, number>();
    openOptionPositions.forEach((e, i) => {
      const delta = liquidityQueries[i]?.data?.delta;
      if (delta != null) m.set(e.id, delta);
    });
    return m;
  }, [openOptionPositions, liquidityQueries]);

  const liveUnrealizedFor = (e: PortfolioEntry): number => {
    if (e.positionType === "stock") {
      const live = priceMap[e.ticker];
      return live != null ? (live - e.avgPrice) * e.qty : (e.unrealizedPnL ?? 0);
    }
    const mid = liveOptionMidByEntryId.get(e.id);
    if (mid == null) return e.unrealizedPnL ?? 0;
    const perContract = isShortPosition(e.positionType) ? (e.avgPrice - mid) : (mid - e.avgPrice);
    return perContract * 100 * e.qty;
  };

  // ── P&L: realized (from transaction history) + unrealized (from open positions) ──
  const pnlTotals = useMemo(() => {
    const scopedRealizedEvents = activePortfolio === "All"
      ? realizedEvents
      : realizedEvents.filter(e =>
          canonicalizeAccount(e.account, accountNickMap) === canonicalizeAccount(activePortfolio, accountNickMap));

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

    const stockUnrealized = filtered.filter(e => e.positionType === "stock").reduce((s, e) => s + liveUnrealizedFor(e), 0);
    const unrealizedFor = (positionType: string) =>
      filtered.filter(e => e.positionType === positionType).reduce((s, e) => s + liveUnrealizedFor(e), 0);
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
  }, [realizedEvents, filtered, activePortfolio, accountNickMap, priceMap, liveOptionMidByEntryId]);

  // ── Cumulative P&L over time ─────────────────────────────────────────────────
  // Scoped by the page's own top-level activePortfolio filter (previously had
  // its own separate All/FILDI/IRA picker, duplicating — and using different
  // label text than — the parent filter for no reason; removed).
  // "Realized" = running total across all realized events (stock + options +
  // dividends), sorted by close date. Same realizedEvents source as pnlTotals
  // above, so no double-counting of premium-open vs close rows.
  // "Unrealized" has no real history to plot (we don't keep daily snapshots of
  // open-position mark-to-market) — shown as a flat line at today's LIVE total
  // (liveUnrealizedFor, same source pnlTotals' Unrealized column now uses)
  // across the same date range, honestly labeled as a current value, not a
  // reconstructed history.
  // "Total" = the realized line, with one additional point appended for today
  // that adds the live unrealized total — i.e. "what you'd have if you closed
  // everything right now," without fabricating what unrealized looked like on
  // past days.
  const [cumPnlView, setCumPnlView] = useState<"realized" | "unrealized" | "total">("realized");
  const scopedRealizedForTimeline = useMemo(() => activePortfolio === "All"
    ? realizedEvents
    : realizedEvents.filter(e =>
        canonicalizeAccount(e.account, accountNickMap) === canonicalizeAccount(activePortfolio, accountNickMap)),
  [realizedEvents, activePortfolio, accountNickMap]);

  const liveUnrealizedTotal = useMemo(
    () => filtered.reduce((s, e) => s + liveUnrealizedFor(e), 0),
    [filtered, priceMap, liveOptionMidByEntryId],
  );

  const realizedTimeline = useMemo(() => {
    const sorted = [...scopedRealizedForTimeline].sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime());
    let running = 0;
    const byDay = new Map<string, number>();
    sorted.forEach(e => {
      running += e.pnl;
      byDay.set(e.closedAt.slice(0, 10), running);
    });
    return Array.from(byDay.entries()).map(([date, cumulative]) => ({ date, cumulative }));
  }, [scopedRealizedForTimeline]);

  const cumulativePnlTimeline = useMemo(() => {
    if (cumPnlView === "realized") return realizedTimeline;
    if (cumPnlView === "unrealized") {
      if (realizedTimeline.length === 0) return [];
      return realizedTimeline.map(p => ({ date: p.date, cumulative: liveUnrealizedTotal }));
    }
    // total
    const today = new Date().toISOString().slice(0, 10);
    const lastRealized = realizedTimeline.at(-1)?.cumulative ?? 0;
    const todayPoint = { date: today, cumulative: lastRealized + liveUnrealizedTotal };
    if (realizedTimeline.length === 0) return [todayPoint];
    const last = realizedTimeline.at(-1)!;
    return last.date === today
      ? [...realizedTimeline.slice(0, -1), todayPoint]
      : [...realizedTimeline, todayPoint];
  }, [cumPnlView, realizedTimeline, liveUnrealizedTotal]);

  // ── Cumulative P&L per trade type — stacked bar (realized + unrealized = total) ──
  const TRADE_TYPE_LABELS: Record<string, string> = {
    "Stock": "Stock", "Options — Short Call": "Sell Call", "Options — Short Put": "Sell Put",
    "Options — Long Call": "Long Call", "Options — Long Put": "Long Put", "Dividends": "Dividends",
  };
  const tradeTypeChartData = useMemo(() =>
    pnlTotals.rows.map(r => ({
      category: TRADE_TYPE_LABELS[r.label] ?? r.label,
      realized: r.realized, unrealized: r.unrealized, total: r.total,
    })).filter(d => d.total !== 0 || d.realized !== 0 || d.unrealized !== 0)
      .sort((a, b) => b.total - a.total),
    [pnlTotals]);

  // ── Account key/label pairs shared by the Top Tickers + Cumulative Summary cards.
  // realizedEvents.account may be a Robinhood account id OR an export nickname (FILDI/IRA)
  // depending on whether the event came from orders vs transactions. Canonicalize both.
  const ACCOUNT_TABS = [
    { key: "All", label: "All" },
    { key: "FILDI", label: "FILDI" },
    { key: "IRA", label: "IRA" },
  ] as const;
  type AccountTabKey = typeof ACCOUNT_TABS[number]["key"];

  const [tickersTab, setTickersTab] = useState<AccountTabKey>("All");
  const [summaryTab, setSummaryTab] = useState<AccountTabKey>("All");
  const [tickersScope, setTickersScope] = useState<"top" | "all">("top");
  const [summaryScope, setSummaryScope] = useState<"top" | "all">("top");
  const [tickerChartScope, setTickerChartScope] = useState<"top" | "all">("top");
  const TOP_N = 10;

  // ── Top tickers by trade frequency, net realized P&L YTD — split by account ──
  const topTickersByAccount = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const buildFor = (accountKey: AccountTabKey) => {
      const bySymbol = new Map<string, { puts: number; calls: number; stockSales: number; netPnl: number }>();
      realizedEvents.forEach(e => {
        if (e.assetType === "dividend") return;
        const acct = canonicalizeAccount(e.account, accountNickMap);
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
  }, [realizedEvents, accountNickMap]);

  // ── Cumulative summary per ticker — mirrors the CSV's per-account SUMMARY table ──
  // Prefers the imported ticker-earnings-summary export (authoritative, computed
  // upstream from full tax-lot data) over recomputing from realizedEvents, which
  // depends on legEffect open/close chaining that the flat transactions export
  // doesn't carry. Falls back to the realizedEvents computation only when no
  // ticker-earnings CSV has been imported yet.
  // Stock capital gains from assignment_buy/sell (now in realizedEvents) are merged
  // into stocksRealized when the earnings export under-reports them (missing call-away).
  const num = (v: string | null) => (v == null ? 0 : parseFloat(v)) || 0;
  const cumulativeSummaryByAccount = useMemo(() => {
    const stockPnlByAccountTicker = new Map<string, number>();
    realizedEvents.forEach(e => {
      if (e.assetType !== "stock") return;
      const acct = canonicalizeAccount(e.account, accountNickMap);
      const k = `${acct}::${e.symbol}`;
      stockPnlByAccountTicker.set(k, (stockPnlByAccountTicker.get(k) ?? 0) + e.pnl);
    });

    const buildFromImported = (accountKey: AccountTabKey) => {
      const rows = tickerEarnings
        .filter(r => {
          const acct = canonicalizeAccount(r.account, accountNickMap);
          return accountKey === "All" || acct === accountKey;
        })
        .map(r => {
          const acct = canonicalizeAccount(r.account, accountNickMap);
          const txnStock = stockPnlByAccountTicker.get(`${acct}::${r.ticker}`) ?? 0;
          let stocksRealized = num(r.stocksRealized);
          // Prefer the larger of export vs txn-FIFO — export misses some call-aways.
          if (Math.abs(txnStock) > Math.abs(stocksRealized) + 0.01) {
            stocksRealized = txnStock;
          }
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
        const acct = canonicalizeAccount(e.account, accountNickMap);
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
        const acct = canonicalizeAccount(entryPortfolio(e), accountNickMap);
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
        return { ticker, ...v, totalRealized, totalUnrealized, totalStocks, totalEarned };
      }).sort((a, b) => b.totalEarned - a.totalEarned);
    };
    const buildFor = tickerEarnings.length > 0 ? buildFromImported : buildFromRealizedEvents;
    return Object.fromEntries(ACCOUNT_TABS.map(t => [t.key, buildFor(t.key)])) as Record<AccountTabKey, ReturnType<typeof buildFromRealizedEvents>>;
  }, [realizedEvents, entries, accountNickMap, tickerEarnings]);

  // ── Cumulative P&L — tickers chart (all accounts or scoped) ──
  const topTickersPnlChartData = useMemo(() => {
    const rows = cumulativeSummaryByAccount.All;
    const sorted = [...rows].sort((a, b) => b.totalEarned - a.totalEarned);
    const sliced = tickerChartScope === "top" ? sorted.slice(0, 8) : sorted;
    return sliced.map(r => ({
      ticker: r.ticker,
      stocks: r.totalStocks, dividends: r.dividends,
      sellPut: r.sellPut, sellCall: r.sellCall,
      longCall: r.longCall, longPut: r.longPut,
      totalEarned: r.totalEarned,
    }));
  }, [cumulativeSummaryByAccount, tickerChartScope]);

  // When the page's top-level account filter is already scoped to one account,
  // these cards' OWN All/FILDI/IRA picker becomes a second, redundant filter —
  // same class of issue as the Cumulative P&L chart's duplicate picker (fixed
  // 2026-10-03). Fix: the global filter wins whenever it's not "All"; the
  // local picker only matters (and is only shown) when viewing "All".
  const effectiveAccountTab = (local: AccountTabKey): AccountTabKey => {
    if (activePortfolio === "All") return local;
    const canon = canonicalizeAccount(activePortfolio, accountNickMap);
    return canon === "FILDI" || canon === "IRA" ? canon : local;
  };

  const displayedTopTickers = useMemo(() => {
    const all = topTickersByAccount[effectiveAccountTab(tickersTab)] ?? [];
    return tickersScope === "top" ? all.slice(0, TOP_N) : all;
  }, [topTickersByAccount, tickersTab, tickersScope, activePortfolio, accountNickMap]);

  const displayedSummary = useMemo(() => {
    const all = cumulativeSummaryByAccount[effectiveAccountTab(summaryTab)] ?? [];
    return summaryScope === "top" ? all.slice(0, TOP_N) : all;
  }, [cumulativeSummaryByAccount, summaryTab, summaryScope, activePortfolio, accountNickMap]);

  // ── Detail panel — Top Tickers / Summary / Income / Health / Equity / Options,
  // shown as one sub-tabbed card (live tab's SubTabToggle styling) instead of stacked rows.
  const DETAIL_TABS = [
    { key: "tickers", label: "Top Tickers" },
    { key: "summary", label: "Cumulative Summary" },
    { key: "income", label: "Options Income" },
    { key: "health", label: "Position Health" },
    { key: "backtest", label: "Vol Backtest" },
    { key: "equity", label: "Equity Holdings" },
    { key: "options", label: "Options Holdings" },
  ] as const;
  type DetailTabKey = typeof DETAIL_TABS[number]["key"];
  const [detailTab, setDetailTab] = useState<DetailTabKey>("tickers");

  // ── IV/vol-rank backtest — does selling premium in a higher-vol regime
  // actually pay off for this account's own trades? Computed server-side
  // (one Yahoo Finance call per distinct ticker, cached 6h) since it needs
  // historical price series, not something to derive client-side.
  const { data: ivRankBacktest, isLoading: ivRankLoading } = useQuery<{
    buckets: Array<{ bucket: "Low" | "Mid" | "High"; count: number; keptFullPremiumPct: number; avgPremiumPerContract: number; avgTrailingVol20dAnnualizedPct: number }>;
    totalEligible: number; graded: number; tickersWithNoPriceHistory: string[];
    assignmentRiskCheckpoint: { checkedCount: number; flaggedCount: number; flaggedWentItmPct: number; unflaggedCount: number; unflaggedWentItmPct: number };
    earningsRiskCheck: { inWindowCount: number; inWindowKeptFullPremiumPct: number; outsideWindowCount: number; outsideWindowKeptFullPremiumPct: number };
    moneynessBandSweep: Array<{ bandPct: number; flaggedCount: number; flaggedWentItmPct: number; unflaggedWentItmPct: number; separation: number }>;
    coveredCallCheck: { totalCallTrades: number; itmCallTrades: number; coveredItmCount: number; nakedOrUnknownItmCount: number };
  }>({
    queryKey: ["portfolio-iv-rank-backtest"],
    queryFn: async () => {
      const res = await fetch("/api/portfolio/iv-rank-backtest", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load vol backtest");
      return res.json();
    },
    enabled: detailTab === "backtest",
    staleTime: 60 * 60 * 1000,
  });

  // Same queryKey as the page-level snapshot query — react-query dedupes, no extra request.
  const { data: snapshotData, isLoading: snapshotLoading, error: snapshotError } = useSnapshotQuery();
  const holdingsPositions = snapshotData?.positions ?? [];
  const holdingsOptions = snapshotData?.options ?? [];
  const holdingsAccountMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of holdingsPositions) { if (p.accountNickname) m.set(p.account, p.accountNickname); }
    return m;
  }, [holdingsPositions]);

  // ── Options income timeline — YTD bi-weekly realized P&L (sold calls + sold puts,
  // expired worthless or closed early) plus a projection to year-end off the YTD run rate ──
  const optionsIncomeTimeline = useMemo(() => {
    const year = new Date().getFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const now = new Date();

    // Scoped by the page's top-level account filter — previously always
    // combined both accounts regardless of the selected tab, inconsistent
    // with pnlTotals/the cumulative chart (both fixed 2026-10-03).
    const scopedRealizedEvents = activePortfolio === "All"
      ? realizedEvents
      : realizedEvents.filter(e =>
          canonicalizeAccount(e.account, accountNickMap) === canonicalizeAccount(activePortfolio, accountNickMap));

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
  }, [realizedEvents, activePortfolio, accountNickMap]);


  // ── Risk metrics ─────────────────────────────────────────────────────────────
  const risk = useMemo(
    () => computePortfolioRiskMetrics(betaData, filtered, priceMap, coveredCalls),
    [betaData, filtered, priceMap, coveredCalls],
  );

  // ── Tabs ──────────────────────────────────────────────────────────────────────
  const tabs = ["All", ...portfolioNames];

  if (filtered.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* Header + filter */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">Portfolio Analysis</h2>
          <p className="text-[10px] text-amber-200/40 mt-0.5">
            Allocation · Sector · Risk · Delta · Income
            {risk.coveredCallCount > 0 && ` · ${risk.coveredCallCount} covered call${risk.coveredCallCount > 1 ? "s" : ""}`}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {onUploadSuccess && <PortfolioUpload onSuccess={onUploadSuccess} />}
          <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
            {tabs.map(t => (
              <button key={t} onClick={() => setActivePortfolio(t)}
                className={cn("px-2.5 py-1 transition-colors",
                  activePortfolio === t ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]")}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Earnings-date risk — open contracts whose expiration spans the underlying's
          next earnings report (IV crush risk). Only renders when something's flagged. */}
      {earningsRiskPositions.length > 0 && (
        <div className="rounded border border-red-500/30 bg-red-950/30 px-3 py-2">
          <div className="text-[10px] font-semibold text-red-400 uppercase tracking-wide mb-1">
            ⚠ Earnings Risk — {earningsRiskPositions.length} open position{earningsRiskPositions.length > 1 ? "s" : ""} expire after an earnings report
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/80">
            {earningsRiskPositions.map(({ entry, reportDate }) => (
              <span key={entry.id}>
                <span className="font-bold">{entry.ticker}</span>{" "}
                {entry.positionType.replace("_", " ")} {formatStrike(entry.strike ?? 0)} exp {entry.expiry}
                {" "}<span className="text-red-400">(earnings {reportDate})</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Row 1: Allocation + Sector + Tickers + Risk */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">Capital Allocation</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <DonutChart data={allocationData} total={totalValue} label="Net Value" />
            <PieLegend data={allocationData} />
            {allocationMarginUsed > 0 && (
              <div className="mt-2 pt-2 border-t border-[#d4af37]/15 text-[10px] text-muted-foreground">
                Net of <span className="font-mono font-semibold text-yellow-400">{formatCurrency(allocationMarginUsed)}</span> margin used —
                Sector Exposure/Ticker Holdings show gross stock notional, so their totals run higher on this account.
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide flex items-center justify-between">
              <span>Sector Exposure</span>
              <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded normal-case tracking-normal",
                concentration.level === "High" ? "bg-red-500/15 text-red-400"
                  : concentration.level === "Moderate" ? "bg-yellow-500/15 text-yellow-400"
                  : "bg-green-500/15 text-green-400")}>
                {concentration.level} concentration
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <DonutChart data={sectorData.items} total={sectorData.total} label="Notional" />
            <PieLegend data={sectorData.items.slice(0, 6)} />
            <div className="mt-2 pt-2 border-t border-[#d4af37]/15 grid grid-cols-3 gap-x-2 text-[10px]">
              <div>
                <div className="text-muted-foreground uppercase tracking-wide">HHI</div>
                <div className="font-mono font-semibold">{concentration.hhi}</div>
              </div>
              <div>
                <div className="text-muted-foreground uppercase tracking-wide">Top-5 %</div>
                <div className="font-mono font-semibold">{concentration.top5Pct.toFixed(1)}%</div>
              </div>
              <div className="truncate">
                <div className="text-muted-foreground uppercase tracking-wide">Largest</div>
                <div className="font-mono font-semibold truncate">
                  {concentration.topTicker ?? "—"} {concentration.topTickerPct != null ? `${concentration.topTickerPct.toFixed(1)}%` : ""}
                </div>
              </div>
            </div>
            {marginUsage.marginUsed > 0 && (
              <div className="mt-2 pt-2 border-t border-[#d4af37]/15 flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground uppercase tracking-wide">Margin Used</span>
                <span className="font-mono font-semibold text-yellow-400">{formatCurrency(marginUsage.marginUsed)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">Ticker Holdings</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <DonutChart data={tickerData.items} total={tickerData.total} label="Notional" />
            <PieLegend data={tickerData.items.slice(0, 6)} />
            {marginUsage.marginUsed > 0 && (
              <div className="mt-2 pt-2 border-t border-[#d4af37]/15 flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground uppercase tracking-wide">Margin Used</span>
                <span className="font-mono font-semibold text-yellow-400">{formatCurrency(marginUsage.marginUsed)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">Risk Metrics</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 mt-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {[
                { label: "Beta (adj.)", value: risk.weightedBeta.toFixed(2), color: risk.weightedBeta > 1.5 ? "text-red-400" : risk.weightedBeta > 1.1 ? "text-yellow-400" : "text-green-400" },
                { label: "Net Delta", value: risk.netDelta > 0 ? `+${risk.netDelta.toFixed(0)}` : risk.netDelta.toFixed(0), color: Math.abs(risk.netDelta) > 5000 ? "text-orange-400" : "text-foreground" },
                { label: "Daily Theta", value: `+${formatCurrency(risk.dailyTheta)}`, color: "text-green-400" },
                { label: "Net Gamma", value: greeksExposure.netGamma >= 0 ? `+${greeksExposure.netGamma.toFixed(1)}` : greeksExposure.netGamma.toFixed(1), color: Math.abs(greeksExposure.netGamma) > 50 ? "text-orange-400" : "text-foreground" },
                { label: "Net Vega", value: greeksExposure.netVega >= 0 ? `+${greeksExposure.netVega.toFixed(0)}` : greeksExposure.netVega.toFixed(0), color: Math.abs(greeksExposure.netVega) > 500 ? "text-orange-400" : "text-foreground" },
                { label: "Income Yield", value: `${risk.incomeYield.toFixed(1)}%`, color: risk.incomeYield >= 20 ? "text-green-400" : risk.incomeYield >= 10 ? "text-yellow-400" : "text-muted-foreground" },
                { label: "Max Assign Risk", value: formatCurrency(risk.maxAssign), color: "text-yellow-400" },
                { label: "Avg DTE", value: `${risk.avgDTE.toFixed(0)}d`, color: "text-foreground" },
                ...(marginUsage.marginUsed > 0 ? [{ label: "Margin Usage", value: `${formatCurrency(marginUsage.marginUsed)} (${marginUsage.pctUsed.toFixed(0)}%)`, color: marginUsage.pctUsed >= 75 ? "text-red-400" : marginUsage.pctUsed >= 50 ? "text-yellow-400" : "text-foreground" }] : []),
                ...(risk.atRiskPositions > 0 ? [{ label: "At-Risk Puts", value: String(risk.atRiskPositions), color: "text-red-400" }] : []),
                ...(risk.expiringSoon > 0 ? [{ label: "Expiring ≤7d", value: String(risk.expiringSoon), color: "text-orange-400" }] : []),
                ...(risk.coveredCallCount > 0 ? [{ label: "Covered Calls", value: String(risk.coveredCallCount), color: "text-blue-400" }] : []),
                ...(liquidityRisk.wide > 0 ? [{ label: "Wide Spreads", value: String(liquidityRisk.wide), color: "text-red-400" }] : []),
                ...(liquidityRisk.moderate > 0 ? [{ label: "Moderate Spreads", value: String(liquidityRisk.moderate), color: "text-yellow-400" }] : []),
              ].map(({ label, value, color }) => (
                <div key={label} className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wide leading-none">{label}</span>
                  <span className={cn("text-sm font-bold font-mono tabular-nums leading-tight", color)}>{value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Row 1.1a: Beta contribution + Cumulative P&L by trade type */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
              Beta Contribution
            </CardTitle>
            <p className="text-[10px] text-white/70">
              weighted β · covered calls adjusted to δ×0.70
            </p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {topBetaData.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-xs text-white/70">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={topBetaData} barSize={32} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="ticker" interval={0} tick={{ fontSize: 13, fontWeight: 600, fill: "#ffffff" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "#ffffff" }} axisLine={false} tickLine={false} width={40} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 min-w-[140px] text-white">
                        <div className="font-semibold flex items-center gap-1">
                          {d.ticker}
                          {d.covered && <span className="text-purple-400" title="Covered call">★</span>}
                        </div>
                        <div className="flex justify-between gap-4"><span className="text-white/70">β Contribution</span><span className="font-mono font-semibold">{d.contribution.toFixed(3)}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-white/70">Beta</span><span className="font-mono">{d.beta}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-white/70">Weight</span><span className="font-mono">{d.weight}%</span></div>
                      </div>
                    );
                  }} cursor={{ fill: "hsl(var(--secondary))", opacity: 0.5 }} />
                  <Bar dataKey="contribution" radius={[3, 3, 0, 0]}>
                    {topBetaData.map((d, i) => (
                      <Cell key={i}
                        fill={d.covered ? "#a78bfa" : d.contribution > 0.4 ? "#f97316" : d.contribution > 0.2 ? "#fbbf24" : "#34d399"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
            {topBetaData.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[#d4af37]/15 flex flex-wrap gap-x-4 gap-y-1.5">
                {BETA_BAR_LEGEND.map(({ color, label }) => (
                  <div key={label} className="flex items-center gap-1.5 text-[10px] text-white">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    {label}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
              Cumulative P&amp;L by Trade Type
            </CardTitle>
            <p className="text-[10px] text-white/70">realized + unrealized, YTD</p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {tradeTypeChartData.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-xs text-white/70">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={tradeTypeChartData} barSize={32} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="category" interval={0} tick={{ fontSize: 11, fontWeight: 600, fill: "#ffffff" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "#ffffff" }} axisLine={false} tickLine={false} width={36} tickFormatter={(v) => formatCompactCurrency(v)} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 min-w-[150px] text-white">
                        <div className="font-semibold">{d.category}</div>
                        <div className="flex justify-between gap-4"><span className="text-white/70">Realized</span><span className="font-mono font-semibold">{formatCurrency(d.realized)}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-white/70">Unrealized</span><span className="font-mono font-semibold">{formatCurrency(d.unrealized)}</span></div>
                        <div className="flex justify-between gap-4 pt-1 border-t border-[#d4af37]/20"><span className="text-white/70">Total</span><span className="font-mono font-bold">{formatCurrency(d.total)}</span></div>
                      </div>
                    );
                  }} cursor={{ fill: "hsl(var(--secondary))", opacity: 0.5 }} />
                  <Bar dataKey="realized" stackId="pnl" fill={REALIZED_UNREALIZED_LEGEND[0].color} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="unrealized" stackId="pnl" fill={REALIZED_UNREALIZED_LEGEND[1].color} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
            {tradeTypeChartData.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[#d4af37]/15 flex flex-wrap gap-x-4 gap-y-1.5">
                {REALIZED_UNREALIZED_LEGEND.map(({ key, color, label }) => (
                  <div key={key} className="flex items-center gap-1.5 text-[10px] text-white">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    {label}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 1.1b: Cumulative P&L top tickers + (reserved) */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
                  Cumulative P&amp;L — Tickers
                </CardTitle>
                <p className="text-[10px] text-white/70">all accounts · realized + unrealized</p>
              </div>
              <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
                {([{ key: "top", label: "Top 8" }, { key: "all", label: "All" }] as const).map(t => (
                  <button key={t.key} onClick={() => setTickerChartScope(t.key)}
                    className={cn("px-2 py-0.5 transition-colors",
                      tickerChartScope === t.key ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]")}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {topTickersPnlChartData.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-xs text-white/70">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={topTickersPnlChartData} barSize={32} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="ticker" interval={0} tick={{ fontSize: 12, fontWeight: 600, fill: "#ffffff" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "#ffffff" }} axisLine={false} tickLine={false} width={36} tickFormatter={(v) => formatCompactCurrency(v)} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 min-w-[150px] text-white">
                        <div className="font-semibold">{d.ticker}</div>
                        {TICKER_PNL_SEGMENTS.map(({ key, label }) => (
                          <div key={key} className="flex justify-between gap-4"><span className="text-white/70">{label}</span><span className="font-mono">{formatCurrency(d[key])}</span></div>
                        ))}
                        <div className="flex justify-between gap-4 pt-1 border-t border-[#d4af37]/20"><span className="text-white/70">Total Earned</span><span className="font-mono font-bold">{formatCurrency(d.totalEarned)}</span></div>
                      </div>
                    );
                  }} cursor={{ fill: "hsl(var(--secondary))", opacity: 0.5 }} />
                  {TICKER_PNL_SEGMENTS.map(({ key, color }, i) => (
                    <Bar key={key} dataKey={key} stackId="pnl" fill={color} radius={i === TICKER_PNL_SEGMENTS.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
            {topTickersPnlChartData.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[#d4af37]/15 flex flex-wrap gap-x-4 gap-y-1.5">
                {TICKER_PNL_SEGMENTS.map(({ key, color, label }) => (
                  <div key={key} className="flex items-center gap-1.5 text-[10px] text-white">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    {label}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
                  Cumulative P&amp;L
                </CardTitle>
                <p className="text-[10px] text-white/70">
                  {cumPnlView === "realized" && "stock + options + dividends · includes assignment lots · scoped to " + activePortfolio}
                  {cumPnlView === "unrealized" && "live mark-to-market on open positions, today · flat line (no daily history kept) · scoped to " + activePortfolio}
                  {cumPnlView === "total" && "realized history + live unrealized added at today · scoped to " + activePortfolio}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
                  {([{ key: "realized", label: "Realized" }, { key: "unrealized", label: "Unrealized" }, { key: "total", label: "Total" }] as const).map(t => (
                    <button key={t.key} onClick={() => setCumPnlView(t.key)}
                      className={cn("px-2 py-0.5 transition-colors",
                        cumPnlView === t.key ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]")}>
                      {t.label}
                    </button>
                  ))}
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-white/70 uppercase tracking-wide">
                    {cumPnlView === "realized" && "Total Realized"}
                    {cumPnlView === "unrealized" && "Live Unrealized"}
                    {cumPnlView === "total" && "Total (incl. live)"}
                  </div>
                  <div className={cn("text-sm font-bold font-mono tabular-nums", (cumulativePnlTimeline.at(-1)?.cumulative ?? 0) >= 0 ? "text-green-400" : "text-red-400")}>
                    {(cumulativePnlTimeline.at(-1)?.cumulative ?? 0) >= 0 ? "+" : ""}{formatCurrency(cumulativePnlTimeline.at(-1)?.cumulative ?? 0)}
                  </div>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {cumulativePnlTimeline.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-xs text-white/70">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={cumulativePnlTimeline} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cumPnlFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#ffffff" }}
                    axisLine={false} tickLine={false}
                    tickFormatter={(d: string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })} />
                  <YAxis tick={{ fontSize: 11, fill: "#ffffff" }} axisLine={false} tickLine={false}
                    width={44} tickFormatter={(v) => formatCompactCurrency(v)} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 text-white">
                        <div className="font-semibold">{new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                        <div className="flex justify-between gap-4">
                          <span className="text-white/70">Cumulative</span>
                          <span className={cn("font-mono font-semibold", d.cumulative >= 0 ? "text-green-400" : "text-red-400")}>
                            {formatCurrency(d.cumulative)}
                          </span>
                        </div>
                      </div>
                    );
                  }} />
                  <Area type="monotone" dataKey="cumulative" stroke="#34d399" strokeWidth={2} fill="url(#cumPnlFill)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 1.2: Correlation matrix + P&L, two boxes in line */}
      <div className="grid grid-cols-2 gap-4">
      {portfolioRisk && portfolioRisk.tickers.length > 1 && (
        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-0">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
                Correlation &amp; Value-at-Risk
              </CardTitle>
              <div className="flex items-center gap-5">
                <div className="text-right">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">VaR 95% (1d)</div>
                  <div className="text-sm font-bold font-mono tabular-nums text-yellow-400">
                    {formatCurrency(portfolioRisk.var95Usd)} <span className="text-muted-foreground font-normal">({portfolioRisk.var95Pct.toFixed(2)}%)</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">CVaR 95% (1d)</div>
                  <div className="text-sm font-bold font-mono tabular-nums text-red-400">
                    {formatCurrency(portfolioRisk.cvar95Usd)} <span className="text-muted-foreground font-normal">({portfolioRisk.cvar95Pct.toFixed(2)}%)</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Daily Vol</div>
                  <div className="text-sm font-bold font-mono tabular-nums">{portfolioRisk.dailyVolatilityPct.toFixed(2)}%</div>
                </div>
              </div>
            </div>
            {portfolioRisk.skippedTickers.length > 0 && (
              <div className="text-[10px] text-muted-foreground pt-2">
                No price history: {portfolioRisk.skippedTickers.join(", ")}
              </div>
            )}
          </CardHeader>
          <CardContent className="px-0 pb-4 pt-3">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                    <th className={TTD}></th>
                    {portfolioRisk.tickers.map(t => (
                      <th key={t} className={cn(TTD, "text-center font-bold")}>{t}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {portfolioRisk.tickers.map((rowTicker, i) => (
                    <tr key={rowTicker} className={cn("border-b border-border/20", i % 2 === 0 ? "" : "bg-secondary/5")}>
                      <td className={cn(TTD, "text-left font-bold")}>{rowTicker}</td>
                      {portfolioRisk.correlationMatrix[i].map((v, j) => {
                        const colTicker = portfolioRisk.tickers[j];
                        const isDiagonal = i === j;
                        const isExcluded = isSameUnderlyingPair(rowTicker, colTicker);
                        if (isDiagonal || isExcluded) {
                          return (
                            <td key={j} className={cn(TTD, "text-center text-muted-foreground/50")}
                              title={isExcluded ? "Same underlying — excluded from color scale" : undefined}>
                              {v.toFixed(2)}
                            </td>
                          );
                        }
                        return (
                          <td key={j} className={cn(TTD, "text-center font-semibold text-white")}
                            style={{ backgroundColor: correlationBg(v, correlationScaleMax) }}>
                            {v.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-[10px] text-muted-foreground px-4 pt-2">3mo daily returns, 95% 1-day</div>
          </CardContent>
        </Card>
      )}

      {/* Row 1.5: P&L — realized + unrealized, stock vs. short/long options */}
      <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
        <CardHeader className="px-4 pt-4 pb-0">
          <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
            P&amp;L
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <table className="w-full text-[11px] mt-2">
            <thead>
              <tr>
                <th className="text-left py-1 px-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider"></th>
                {["Realized", "Unrealized", "Total"].map(h => (
                  <th key={h} className="text-right py-1 px-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pnlTotals.rows.map(row => (
                <tr key={row.label} className="border-t border-border/20">
                  <td className="py-1.5 px-2 font-medium">{row.label}</td>
                  {[row.realized, row.unrealized, row.total].map((v, i) => (
                    <td key={i} className={cn("py-1.5 px-2 text-right font-mono tabular-nums font-semibold",
                      v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground")}>
                      {v >= 0 ? "+" : ""}{formatCurrency(v)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-[#d4af37]/15">
                <td className="py-1.5 px-2 font-bold">Total</td>
                {[pnlTotals.grandTotal.realized, pnlTotals.grandTotal.unrealized, pnlTotals.grandTotal.total].map((v, i) => (
                  <td key={i} className={cn("py-1.5 px-2 text-right font-mono tabular-nums font-bold text-base",
                    v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground")}>
                    {v >= 0 ? "+" : ""}{formatCurrency(v)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
      </div>

      {/* Row 1.6+: Top Tickers / Cumulative Summary / Options Income / Position Health /
          Equity Holdings / Options Holdings — one sub-tabbed card, live tab's toggle styling */}
      <Card className="overflow-hidden bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-1.5">
            <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold shrink-0">
              {DETAIL_TABS.map(t => (
                <button key={t.key} onClick={() => setDetailTab(t.key)}
                  className={cn("px-2.5 py-1 transition-colors whitespace-nowrap",
                    detailTab === t.key ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]")}>
                  {t.label}
                </button>
              ))}
            </div>
            {(detailTab === "tickers" || detailTab === "summary") && (
              <div className="flex items-center gap-2 flex-wrap">
                {activePortfolio === "All" ? (
                  <div className="flex items-center gap-1 bg-secondary/40 p-1 rounded-lg">
                    {ACCOUNT_TABS.map(t => (
                      <button key={t.key} onClick={() => detailTab === "tickers" ? setTickersTab(t.key) : setSummaryTab(t.key)}
                        className={cn("px-2.5 py-0.5 text-[11px] font-medium rounded-md transition-colors",
                          (detailTab === "tickers" ? tickersTab : summaryTab) === t.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="text-[10px] text-muted-foreground/60 italic">
                    scoped to {activePortfolio} (top filter)
                  </span>
                )}
                <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
                  {([{ key: "top", label: `Top ${TOP_N}` }, { key: "all", label: "All" }] as const).map(t => (
                    <button key={t.key}
                      onClick={() => detailTab === "tickers" ? setTickersScope(t.key) : setSummaryScope(t.key)}
                      className={cn("px-2 py-0.5 transition-colors",
                        (detailTab === "tickers" ? tickersScope : summaryScope) === t.key
                          ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]")}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground normal-case pt-1.5">
            {detailTab === "tickers" && "Top Tickers — by frequency, net realized P&L YTD (stock sales include assignment exits when exported)"}
            {detailTab === "summary" && "Cumulative Summary — realized + unrealized + dividends (not calendar-YTD clipped)"}
            {detailTab === "income" && `Options Income Timeline — sold calls + sold puts · net gain/loss · bi-weekly since 1/1 · scoped to ${activePortfolio}`}
            {detailTab === "health" && "Option Position Health — break-even, moneyness, and assignment/exercise risk per leg"}
            {detailTab === "backtest" && "Vol-Rank Backtest — does selling premium in a higher-volatility regime actually pay off for YOUR trades? (realized-vol proxy, not true IV history)"}
            {detailTab === "equity" && "Equity Holdings — grouped by account"}
            {detailTab === "options" && "Options Holdings — grouped by account, active contracts"}
          </p>
          {detailTab === "income" && (
            <div className="flex items-center gap-5 pt-2 pb-1">
              <div>
                <div className="text-[10px] text-white/70 uppercase tracking-wide">YTD Earned</div>
                <div className={cn("text-sm font-bold font-mono tabular-nums", optionsIncomeTimeline.ytdActual >= 0 ? "text-green-400" : "text-red-400")}>
                  {optionsIncomeTimeline.ytdActual >= 0 ? "+" : ""}{formatCurrency(optionsIncomeTimeline.ytdActual)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-white/70 uppercase tracking-wide">Avg Monthly</div>
                <div className="text-sm font-bold font-mono tabular-nums text-white">
                  {formatCurrency(optionsIncomeTimeline.avgMonthlyEarned)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-white/70 uppercase tracking-wide">Projected Annual</div>
                <div className={cn("text-sm font-bold font-mono tabular-nums", optionsIncomeTimeline.projectedAnnualTotal >= 0 ? "text-green-400" : "text-red-400")}>
                  {optionsIncomeTimeline.projectedAnnualTotal >= 0 ? "+" : ""}{formatCurrency(optionsIncomeTimeline.projectedAnnualTotal)}
                </div>
              </div>
            </div>
          )}
        </CardHeader>
        {detailTab === "tickers" && (
        <CardContent className="px-0 pb-0">
          {displayedTopTickers.length === 0 ? (
            <div className="h-[60px] flex items-center justify-center text-xs text-muted-foreground">
              No trades closed this year yet
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                  <th className={TTH}>#</th>
                  <th className={cn(TTH, "text-left")}>Ticker</th>
                  <th className={cn(TTH, "text-right")}>Puts Sold</th>
                  <th className={cn(TTH, "text-right")}>Calls Sold</th>
                  <th className={cn(TTH, "text-right")}>Stock Sales</th>
                  <th className={cn(TTH, "text-right")}>Times Traded</th>
                  <th className={cn(TTH, "text-right")}>Net Realized P&amp;L YTD</th>
                </tr>
              </thead>
              <tbody>
                {displayedTopTickers.map((t, i) => (
                  <tr key={t.symbol} className={cn("border-b border-border/20 hover:bg-secondary/10 transition-colors", i % 2 === 0 ? "" : "bg-secondary/5")}>
                    <td className={cn(TTD, "text-muted-foreground")}>{i + 1}</td>
                    <td className={cn(TTD, "text-left font-bold")}>{t.symbol}</td>
                    <td className={cn(TTD, "text-right text-muted-foreground")}>{t.puts || "—"}</td>
                    <td className={cn(TTD, "text-right text-muted-foreground")}>{t.calls || "—"}</td>
                    <td className={cn(TTD, "text-right text-muted-foreground")}>{t.stockSales || "—"}</td>
                    <td className={cn(TTD, "text-right text-muted-foreground")}>{t.count}</td>
                    <td className={cn(TTD, "text-right font-semibold",
                      t.netPnl > 0 ? "text-green-400" : t.netPnl < 0 ? "text-red-400" : "text-muted-foreground")}>
                      {t.netPnl >= 0 ? "+" : ""}{formatCurrency(t.netPnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
        )}

        {detailTab === "summary" && (
        <CardContent className="px-0 pb-0">
          {displayedSummary.length === 0 ? (
            <div className="h-[60px] flex items-center justify-center text-xs text-muted-foreground">
              No activity for this account yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                    <th className={cn(TTH, "text-left")}>Ticker</th>
                    <th className={cn(TTH, "text-right")}>Unrealized</th>
                    <th className={cn(TTH, "text-right")}>Realized</th>
                    <th className={cn(TTH, "text-right")}>Earned</th>
                    <th className={cn(TTH, "text-right")}>Sell Put</th>
                    <th className={cn(TTH, "text-right")}>Sell Call</th>
                    <th className={cn(TTH, "text-right")}>Long Call</th>
                    <th className={cn(TTH, "text-right")}>Long Put</th>
                    <th className={cn(TTH, "text-right")}>Dividends</th>
                    <th className={cn(TTH, "text-right")}>Stocks Realized</th>
                    <th className={cn(TTH, "text-right")}>Stocks Unrealized</th>
                    <th className={cn(TTH, "text-right")}>Total Stocks</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedSummary.map((r, i) => {
                    const cell = (v: number) => (
                      <td className={cn(TTD, "text-right", v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground")}>
                        {v !== 0 ? `${v >= 0 ? "+" : ""}${formatCurrency(v)}` : "—"}
                      </td>
                    );
                    return (
                      <tr key={r.ticker} className={cn("border-b border-border/20 hover:bg-secondary/10 transition-colors", i % 2 === 0 ? "" : "bg-secondary/5")}>
                        <td className={cn(TTD, "text-left font-bold")}>{r.ticker}</td>
                        {cell(r.totalUnrealized)}
                        {cell(r.totalRealized)}
                        <td className={cn(TTD, "text-right font-bold", r.totalEarned > 0 ? "text-green-400" : r.totalEarned < 0 ? "text-red-400" : "text-muted-foreground")}>
                          {r.totalEarned >= 0 ? "+" : ""}{formatCurrency(r.totalEarned)}
                        </td>
                        {cell(r.sellPut)}
                        {cell(r.sellCall)}
                        {cell(r.longCall)}
                        {cell(r.longPut)}
                        {cell(r.dividends)}
                        {cell(r.stocksRealized)}
                        {cell(r.stocksUnrealized)}
                        {cell(r.totalStocks)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
        )}

        {detailTab === "income" && (
        <CardContent className="px-4 pb-4">
          {optionsIncomeTimeline.chartData.length === 0 ? (
            <div className="h-[220px] flex items-center justify-center text-xs text-white/70">No data</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={optionsIncomeTimeline.chartData} barSize={12} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                <XAxis dataKey="label" interval={2} tick={{ fontSize: 10, fill: "#ffffff" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#ffffff" }} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => formatCompactCurrency(v)} />
                <Tooltip content={(p) => {
                  const d = p.payload?.[0]?.payload;
                  if (!p.active || !d) return null;
                  return (
                    <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 text-white">
                      <div className="font-semibold">{d.label}{d.isFuture ? " (projected)" : ""}</div>
                      {d.isFuture ? (
                        <div className="flex justify-between gap-4"><span className="text-white/70">Projected</span><span className="font-mono font-semibold">{formatCurrency(d.projected)}</span></div>
                      ) : (
                        <div className="flex justify-between gap-4"><span className="text-white/70">Earned</span><span className="font-mono font-semibold">{formatCurrency(d.actual)}</span></div>
                      )}
                    </div>
                  );
                }} cursor={{ fill: "hsl(var(--secondary))", opacity: 0.5 }} />
                <Bar dataKey="actual" stackId="income" radius={[2, 2, 0, 0]}>
                  {optionsIncomeTimeline.chartData.map((d, i) => (
                    <Cell key={i} fill={d.actual >= 0 ? "#34d399" : "#f87171"} />
                  ))}
                </Bar>
                <Bar dataKey="projected" stackId="income" radius={[2, 2, 0, 0]} fill="#38bdf8" fillOpacity={0.35} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <div className="mt-3 pt-3 border-t border-[#d4af37]/15 flex flex-wrap gap-x-4 gap-y-1.5">
            {[
              { color: "#34d399", label: "Earned (actual)" },
              { color: "#f87171", label: "Loss (actual)" },
              { color: "rgba(56,189,248,0.35)", label: "Projected (run-rate)" },
            ].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-1.5 text-[10px] text-white">
                <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                {label}
              </div>
            ))}
          </div>
        </CardContent>
        )}

        {detailTab === "health" && risk.putPositions.length === 0 && risk.callPositions.length === 0 && (
        <CardContent className="px-4 pb-4">
          <div className="h-[60px] flex items-center justify-center text-xs text-muted-foreground">No open option positions</div>
        </CardContent>
        )}

        {detailTab === "health" && (risk.putPositions.length > 0 || risk.callPositions.length > 0) && (
        <CardContent className="px-4 pb-4 space-y-4">
            {[
              { label: "Puts", rows: risk.putPositions, isPut: true },
              { label: "Calls", rows: risk.callPositions, isPut: false },
            ].filter(g => g.rows.length > 0).map(({ label, rows, isPut }) => (
              <div key={label}>
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                  <span className={cn("w-1.5 h-1.5 rounded-full", isPut ? "bg-yellow-400" : "bg-blue-400")} />
                  {label}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                        {["Ticker", "Type", "Qty", "Strike", "Premium", "Break-Even", "Current", isPut ? "OTM %" : "ITM %", "Collateral", "Status", "Delta", "Action"].map((h, hi) => (
                          <th key={h} className={cn(TTH, hi === 0 || hi === 1 ? "text-left" : "text-right")}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p, i) => {
                        const isShort = p.positionType === "short_put" || p.positionType === "short_call";
                        // For short puts: positive moneyness = OTM = safe; negative = ITM = at risk
                        // For short calls: negative moneyness = OTM = safe; positive = ITM = at risk
                        const mness = p.moneyness;
                        let safe = false, warn = false, atRisk = false;
                        if (isShort && isPut) {
                          safe   = mness !== null && mness >= 8;
                          warn   = mness !== null && mness >= 0 && mness < 8;
                          atRisk = mness !== null && mness < 0;
                        } else if (isShort && !isPut) {
                          safe   = mness !== null && mness <= -8;
                          warn   = mness !== null && mness > -8 && mness <= 0;
                          atRisk = mness !== null && mness > 0;
                        } else {
                          // long options: just show ITM/OTM
                          safe   = isPut ? (mness !== null && mness < 0) : (mness !== null && mness > 0);
                        }
                        const displayMness = isPut ? mness : (mness !== null ? -mness : null);
                        // Assignment-risk alert: delta is the standard risk measure
                        // (vs. raw moneyness above) — live, via Black-Scholes off
                        // live IV/spot (same endpoint the liquidity-risk card uses).
                        // Verified 2026-10-03 against this account's own 1,347 past
                        // trades. Threshold tuned 2026-10-04: a moneyness-band sweep
                        // (Vol Backtest tab) found 2% separates outcomes better than
                        // the 3% originally guessed, so the delta bar moved from 0.70
                        // to 0.75 in the same direction (tighter = cleaner signal) —
                        // the two scales aren't identical, so this is a directionally-
                        // informed adjustment, not an exact derived value.
                        const ASSIGNMENT_RISK_DELTA = 0.75;
                        const liveDelta = liveOptionDeltaByEntryId.get(p.id);
                        const dte = daysToExpiry(p.expiry);
                        const highDelta = isShort && liveDelta != null && Math.abs(liveDelta) > ASSIGNMENT_RISK_DELTA;
                        const action: "roll" | "assign" | null = !highDelta ? null
                          : (dte != null && dte > 14) ? "roll" : "assign";
                        return (
                          <tr key={i} className={cn("border-b border-border/20 hover:bg-secondary/10 transition-colors", i % 2 === 0 ? "" : "bg-secondary/5")}>
                            <td className={cn(TTD, "text-left font-bold")}>{p.ticker}</td>
                            <td className={cn(TTD, "text-left")}>
                              <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded",
                                isShort ? "bg-green-500/15 text-green-400" : "bg-blue-500/15 text-blue-400")}>
                                {isShort ? "Short" : "Long"}
                              </span>
                            </td>
                            <td className={cn(TTD, "text-right text-muted-foreground")}>{p.qty}</td>
                            <td className={cn(TTD, "text-right")}>{formatStrike(p.strike)}</td>
                            <td className={cn(TTD, "text-right text-green-400")}>{isShort ? "+" : "−"}${p.premium.toFixed(2)}</td>
                            <td className={cn(TTD, "text-right")}>${p.breakEven.toFixed(2)}</td>
                            <td className={cn(TTD, "text-right")}>
                              {p.currentPrice !== null ? `$${p.currentPrice.toFixed(2)}` : <span className="text-muted-foreground">—</span>}
                            </td>
                            <td className={cn(TTD, "text-right font-semibold",
                              safe ? "text-green-400" : warn ? "text-yellow-400" : atRisk ? "text-red-400" : "text-muted-foreground")}>
                              {displayMness !== null ? `${displayMness > 0 ? "+" : ""}${displayMness.toFixed(1)}%` : "—"}
                            </td>
                            <td className={cn(TTD, "text-right", p.collateral !== null ? "text-yellow-400 font-semibold" : "text-muted-foreground")}>
                              {p.collateral !== null ? formatCurrency(p.collateral) : "—"}
                            </td>
                            <td className={cn(TTD, "text-right")}>
                              {isShort ? (
                                <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold",
                                  safe   ? "bg-green-500/15 text-green-400" :
                                  warn   ? "bg-yellow-500/15 text-yellow-400" :
                                  atRisk ? "bg-red-500/15 text-red-400" :
                                  "bg-secondary text-muted-foreground")}>
                                  {safe ? "Safe" : warn ? "Watch" : atRisk ? "At Risk" : "—"}
                                </span>
                              ) : (
                                <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold",
                                  safe ? "bg-blue-500/15 text-blue-400" : "bg-secondary text-muted-foreground")}>
                                  {safe ? "ITM" : "OTM"}
                                </span>
                              )}
                            </td>
                            <td className={cn(TTD, "text-right", liveDelta != null && Math.abs(liveDelta) > ASSIGNMENT_RISK_DELTA ? "text-orange-400 font-semibold" : "text-muted-foreground")}>
                              {liveDelta != null ? liveDelta.toFixed(2) : "—"}
                            </td>
                            <td className={cn(TTD, "text-right")}>
                              {action === "assign" ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/15 text-red-400" title={`Delta > ${ASSIGNMENT_RISK_DELTA} with ≤14 DTE — little time left to roll`}>
                                  Assignment Risk
                                </span>
                              ) : action === "roll" ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-orange-500/15 text-orange-400" title={`Delta > ${ASSIGNMENT_RISK_DELTA} with >14 DTE — consider rolling for credit`}>
                                  Consider Roll
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground/50">
              Puts OTM% = (price/strike−1)×100 · Calls ITM% = (price/strike−1)×100 · At Risk: short within 8% of strike
            </p>
        </CardContent>
        )}

        {detailTab === "backtest" && (
        <CardContent className="px-4 pb-4">
          {ivRankLoading && (
            <div className="h-[120px] flex items-center justify-center text-xs text-muted-foreground">Running backtest (fetching price history)...</div>
          )}
          {!ivRankLoading && ivRankBacktest && ivRankBacktest.graded === 0 && (
            <div className="h-[120px] flex items-center justify-center text-xs text-muted-foreground">No expired, graded short-option trades yet</div>
          )}
          {!ivRankLoading && ivRankBacktest && ivRankBacktest.graded > 0 && (
            <div className="space-y-3">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-y border-[#d4af37]/15 bg-secondary/20">
                      {["Vol Regime", "Trades", "Kept Full Premium", "Avg Trailing Vol (ann.)", "Avg Premium/Contract"].map((h, i) => (
                        <th key={h} className={cn(TTH, i === 0 ? "text-left" : "text-right")}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ivRankBacktest.buckets.map((b, i) => (
                      <tr key={b.bucket} className={cn("border-b border-border/20", i % 2 === 0 ? "" : "bg-secondary/5")}>
                        <td className={cn(TTD, "text-left font-bold")}>{b.bucket}</td>
                        <td className={cn(TTD, "text-right text-muted-foreground")}>{b.count}</td>
                        <td className={cn(TTD, "text-right font-semibold",
                          b.keptFullPremiumPct >= 80 ? "text-green-400" : b.keptFullPremiumPct >= 70 ? "text-yellow-400" : "text-red-400")}>
                          {b.keptFullPremiumPct.toFixed(1)}%
                        </td>
                        <td className={cn(TTD, "text-right")}>{b.avgTrailingVol20dAnnualizedPct.toFixed(1)}%</td>
                        <td className={cn(TTD, "text-right")}>${b.avgPremiumPerContract.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                {ivRankBacktest.graded} expired short-option trades graded since 2026-01-01 ({ivRankBacktest.totalEligible - ivRankBacktest.graded} skipped — no price history). Vol regime = trailing 20-day realized volatility of the underlying as of each trade's open date (a proxy — true historical IV isn't available for these tickers). "Kept Full Premium" = underlying closed OTM at expiration (put: price ≥ strike; call: price ≤ strike). Covered calls assigned ITM aren't necessarily losses — this measures assignment-risk frequency by vol regime, not P&L (see the covered-call breakout below for how much of the call-side rate this actually affects).
                {ivRankBacktest.tickersWithNoPriceHistory.length > 0 && ` No price history: ${ivRankBacktest.tickersWithNoPriceHistory.join(", ")}.`}
              </p>

              {ivRankBacktest.coveredCallCheck.itmCallTrades > 0 && (
                <div className="rounded border border-[#d4af37]/15 bg-secondary/10 px-3 py-2.5 space-y-1.5">
                  <div className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-wide">
                    Covered-Call Correction
                  </div>
                  <p className="text-[11px]">
                    Of {ivRankBacktest.coveredCallCheck.itmCallTrades} short-call trades that finished ITM (counted as "didn't keep full premium" in the table above),{" "}
                    <span className="font-mono font-semibold text-blue-400">{ivRankBacktest.coveredCallCheck.coveredItmCount}</span>{" "}
                    ({((ivRankBacktest.coveredCallCheck.coveredItmCount / ivRankBacktest.coveredCallCheck.itmCallTrades) * 100).toFixed(0)}%) were covered — shares were already held when the call was sold — vs.{" "}
                    <span className="font-mono font-semibold text-red-400">{ivRankBacktest.coveredCallCheck.nakedOrUnknownItmCount}</span>{" "}
                    naked or unknown-coverage.
                  </p>
                  <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                    A covered call assigned ITM is very often a planned, profitable exit (premium kept + stock sold at the strike) — not comparable to a naked assignment or an ITM short put. Of {ivRankBacktest.coveredCallCheck.totalCallTrades} total call trades, nearly all ITM ones were covered, so the call-side "risk" in the bucket table above is mostly normal wheel behavior, not a warning sign.
                  </p>
                </div>
              )}

              {ivRankBacktest.assignmentRiskCheckpoint.checkedCount > 0 && (
                <div className="rounded border border-[#d4af37]/15 bg-secondary/10 px-3 py-2.5 space-y-1.5">
                  <div className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-wide">
                    Assignment-Risk Alert — Verified Against Your Own History
                  </div>
                  <div className="flex gap-6 text-[11px]">
                    <div>
                      <span className="text-muted-foreground">Flagged at risk</span>{" "}
                      <span className="font-mono font-semibold text-red-400">{ivRankBacktest.assignmentRiskCheckpoint.flaggedWentItmPct.toFixed(1)}%</span>{" "}
                      <span className="text-muted-foreground">went ITM</span>{" "}
                      <span className="text-muted-foreground/60">(n={ivRankBacktest.assignmentRiskCheckpoint.flaggedCount})</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Not flagged</span>{" "}
                      <span className="font-mono font-semibold text-green-400">{ivRankBacktest.assignmentRiskCheckpoint.unflaggedWentItmPct.toFixed(1)}%</span>{" "}
                      <span className="text-muted-foreground">went ITM</span>{" "}
                      <span className="text-muted-foreground/60">(n={ivRankBacktest.assignmentRiskCheckpoint.unflaggedCount})</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                    The live "Consider Roll" / "Assignment Risk" tags on the Position Health tab use delta &gt; 0.75 — this checks that same rule's moneyness proxy (2% band, tuned below) at the midpoint of each trade's own holding period (scaled to the trade's own DTE, since most of this account's trades are 2-9 day weeklies, shorter than a fixed days-out window) against what actually happened by expiration. Flagged trades going ITM {ivRankBacktest.assignmentRiskCheckpoint.flaggedWentItmPct.toFixed(0)}% of the time vs. {ivRankBacktest.assignmentRiskCheckpoint.unflaggedWentItmPct.toFixed(0)}% for unflagged ones means the alert is picking up a real signal, not noise.
                  </p>
                  {ivRankBacktest.moneynessBandSweep.length > 0 && (
                    <div className="pt-1.5 border-t border-[#d4af37]/10">
                      <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Threshold Sweep — Is 2% The Best Band?</div>
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-[#d4af37]/10">
                              {["Band", "n", "Flagged ITM%", "Unflagged ITM%", "Separation"].map((h, i) => (
                                <th key={h} className={cn(TTH, i === 0 ? "text-left" : "text-right")}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {ivRankBacktest.moneynessBandSweep.map(r => (
                              <tr key={r.bandPct} className={cn("border-b border-border/10", r.bandPct === 2 && "bg-[#d4af37]/10")}>
                                <td className={cn(TTD, "text-left font-semibold")}>{r.bandPct}%{r.bandPct === 2 ? " (current)" : ""}</td>
                                <td className={cn(TTD, "text-right text-muted-foreground")}>{r.flaggedCount}</td>
                                <td className={cn(TTD, "text-right")}>{r.flaggedWentItmPct.toFixed(1)}%</td>
                                <td className={cn(TTD, "text-right")}>{r.unflaggedWentItmPct.toFixed(1)}%</td>
                                <td className={cn(TTD, "text-right font-semibold", r.separation >= 40 ? "text-green-400" : "text-muted-foreground")}>{r.separation.toFixed(1)}pp</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="text-[10px] text-muted-foreground/50 mt-1">
                        Separation = flagged ITM% − unflagged ITM% (bigger = cleaner signal). Narrower bands (1-2%) separate better than wider ones, but flag fewer positions — 2% is the sample-size/signal tradeoff point used live. This band and the live delta threshold measure different things (moneyness snapshot vs. live Black-Scholes delta) and aren't numerically equivalent — the live threshold was moved in the same direction, not derived from this exact number.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {(ivRankBacktest.earningsRiskCheck.inWindowCount + ivRankBacktest.earningsRiskCheck.outsideWindowCount) > 0 && (
                <div className="rounded border border-[#d4af37]/15 bg-secondary/10 px-3 py-2.5 space-y-1.5">
                  <div className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-wide">
                    Earnings-Risk Flag — Verified Against Your Own History
                  </div>
                  <div className="flex gap-6 text-[11px]">
                    <div>
                      <span className="text-muted-foreground">Earnings in window</span>{" "}
                      <span className="font-mono font-semibold">{ivRankBacktest.earningsRiskCheck.inWindowKeptFullPremiumPct.toFixed(1)}%</span>{" "}
                      <span className="text-muted-foreground">kept full premium</span>{" "}
                      <span className="text-muted-foreground/60">(n={ivRankBacktest.earningsRiskCheck.inWindowCount})</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">No earnings in window</span>{" "}
                      <span className="font-mono font-semibold">{ivRankBacktest.earningsRiskCheck.outsideWindowKeptFullPremiumPct.toFixed(1)}%</span>{" "}
                      <span className="text-muted-foreground">kept full premium</span>{" "}
                      <span className="text-muted-foreground/60">(n={ivRankBacktest.earningsRiskCheck.outsideWindowCount})</span>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                    {Math.abs(ivRankBacktest.earningsRiskCheck.inWindowKeptFullPremiumPct - ivRankBacktest.earningsRiskCheck.outsideWindowKeptFullPremiumPct) < 5
                      ? "Honest finding: these two rates are close — for this account's actual trades (mostly 2-9 DTE weeklies), spanning an earnings date hasn't meaningfully predicted a worse outcome. Only a small fraction of contracts are even long enough to span an earnings date, so this flag matters far more if/when longer-dated positions are opened, less so for the weekly wheel that dominates current volume."
                      : "These rates differ meaningfully — earnings-window exposure does appear to correlate with outcome for this account's trades, worth continuing to watch."}
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
        )}

        {(detailTab === "equity" || detailTab === "options") && (
        <CardContent className="px-0 pb-0">
          {snapshotLoading && (
            <p className="text-xs text-amber-200/40 animate-pulse px-3 py-3">Loading portfolio…</p>
          )}
          {!!snapshotError && (
            <p className="text-xs text-red-400 px-3 py-3">Failed to load portfolio data.</p>
          )}
          {!snapshotLoading && !snapshotError && !snapshotData?.snapshot && (
            <p className="text-xs text-amber-200/40 px-3 py-3">No snapshot yet — upload a Robinhood CSV above.</p>
          )}
          {!snapshotLoading && !snapshotError && snapshotData?.snapshot && (
            detailTab === "equity"
              ? <EquityTable positions={holdingsPositions} />
              : <OptionsTable options={holdingsOptions} accountMap={holdingsAccountMap} />
          )}
        </CardContent>
        )}
      </Card>
    </div>
  );
}
