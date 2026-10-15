import { useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import {
  Cell, BarChart, Bar, AreaChart, Area, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { type PortfolioEntry, cashCollateral, isShortPosition, entryPortfolio } from "@/hooks/use-portfolio";
import { type StockMetrics } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip as UiTooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCurrency, formatCompactCurrency, formatCompactCurrencyInt, formatMdYy, formatMYy } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  formatStrike, PALETTE, SECTOR_OVERRIDES, BETA_BAR_LEGEND, REALIZED_UNREALIZED_LEGEND, TICKER_PNL_SEGMENTS,
} from "./portfolio/portfolio-palette";
import { detectCoveredCalls } from "./portfolio/covered-calls-detector";
import { DonutChart, PieLegend } from "./portfolio/portfolio-charts";
import { PositionHealthPanel } from "./portfolio/position-health-panel";
import { TopTickersPanel, CumulativeSummaryPanel, CorrelationPanel, OptionsIncomePanel } from "./portfolio/pnl-detail-panels";
import { VolBacktestPanel, type IvRankBacktest } from "./portfolio/vol-backtest-panel";
import {
  type RealizedEvent, type TickerEarningsRow, type AccountTabKey, ACCOUNT_TABS,
  canonicalizeAccount, scopeRealizedEvents, computePnlTotals, buildRealizedTimeline,
  buildTopTickersByAccount, buildCumulativeSummaryByAccount, buildOptionsIncomeTimeline,
} from "./portfolio/portfolio-pnl-calc";
import {
  type AccountSummary, type PortfolioRiskResult,
  computeMarginUsage, computeConcentration, computeGreeksExposure,
  computeCorrelationScaleMax, computePortfolioRiskMetrics,
} from "./portfolio/portfolio-risk-calc";
export type { AccountSummary, PortfolioRiskResult };
import { useSnapshotQuery, EquityTable, OptionsTable } from "./RobinhoodPortfolio";
import { PortfolioUpload } from "./PortfolioUpload";
import { LazyMount } from "@/components/lazy-mount";

/** Cap live option-quote fan-out until Position Health is open. */
const OPTION_QUOTE_PREVIEW = 12;

const DETAIL_TABS = [
  { key: "tickers", label: "Top Tickers" },
  { key: "summary", label: "Cumulative Summary" },
  { key: "income", label: "Options Income" },
  { key: "corr", label: "Correlation" },
  { key: "health", label: "Position Health" },
  { key: "backtest", label: "Vol Backtest" },
  { key: "equity", label: "Equity Holdings" },
  { key: "options", label: "Options Holdings" },
] as const;
type DetailTabKey = (typeof DETAIL_TABS)[number]["key"];

// ── Portfolio Analysis ────────────────────────────────────────────────────────

interface PortfolioAnalysisProps {
  entries: PortfolioEntry[];
  priceMap: Record<string, number | undefined>;
  stockDataMap: Record<string, StockMetrics>;
  portfolioNames: string[];
  accountSummaries?: AccountSummary[];
  realizedEvents?: RealizedEvent[];
  tickerEarnings?: TickerEarningsRow[];
  earningsCalendar?: Record<string, string | null>;
  /** Latest Robinhood CSV ingest (`portfolio_snapshots.imported_at`) — export + import are the same event. */
  lastImportedAt?: string | null;
  onUploadSuccess?: () => void;
}

export function PortfolioAnalysis({ entries, priceMap, stockDataMap, portfolioNames, accountSummaries = [], realizedEvents = [], tickerEarnings = [], earningsCalendar = {}, lastImportedAt = null, onUploadSuccess }: PortfolioAnalysisProps) {
  const [activePortfolio, setActivePortfolio] = useState<string>("All");
  const [detailTab, setDetailTab] = useState<DetailTabKey>("tickers");
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

  // Preview quotes for risk metrics / P&L; full fan-out only on Position Health.
  const quotePreviewIds = useMemo(() => {
    const ranked = [...openOptionPositions]
      .sort((a, b) => Math.abs(positionValue(b)) - Math.abs(positionValue(a)))
      .slice(0, OPTION_QUOTE_PREVIEW)
      .map((e) => e.id);
    return new Set(ranked);
  }, [openOptionPositions, priceMap]);

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
        enabled: detailTab === "health" || quotePreviewIds.has(e.id),
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
    // Fetch with the Risk Metrics card (above the fold) — not only after charts scroll in.
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
  const scopedRealizedEvents = useMemo(
    () => scopeRealizedEvents(realizedEvents, activePortfolio, accountNickMap),
    [realizedEvents, activePortfolio, accountNickMap],
  );
  const pnlTotals = useMemo(
    () => computePnlTotals(scopedRealizedEvents, filtered, liveUnrealizedFor),
    [scopedRealizedEvents, filtered, priceMap, liveOptionMidByEntryId],
  );

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
  const [cumPnlView, setCumPnlView] = useState<"realized" | "unrealized" | "total" | "table">("realized");
  const liveUnrealizedTotal = useMemo(
    () => filtered.reduce((s, e) => s + liveUnrealizedFor(e), 0),
    [filtered, priceMap, liveOptionMidByEntryId],
  );

  const realizedTimeline = useMemo(() => buildRealizedTimeline(scopedRealizedEvents), [scopedRealizedEvents]);

  const cumulativePnlTimeline = useMemo(() => {
    if (cumPnlView === "table" || cumPnlView === "realized") return realizedTimeline;
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

  const [tickersTab, setTickersTab] = useState<AccountTabKey>("All");
  const [summaryTab, setSummaryTab] = useState<AccountTabKey>("All");
  const [tickersScope, setTickersScope] = useState<"top" | "all">("top");
  const [summaryScope, setSummaryScope] = useState<"top" | "all">("top");
  const [tickerChartScope, setTickerChartScope] = useState<"top" | "all">("top");
  const TOP_N = 10;

  // ── Top tickers by trade frequency, net realized P&L YTD — split by account ──
  const topTickersByAccount = useMemo(
    () => buildTopTickersByAccount(realizedEvents, accountNickMap),
    [realizedEvents, accountNickMap],
  );

  const cumulativeSummaryByAccount = useMemo(
    () => buildCumulativeSummaryByAccount(realizedEvents, entries, tickerEarnings, accountNickMap),
    [realizedEvents, entries, accountNickMap, tickerEarnings],
  );

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
  // ── IV/vol-rank backtest — does selling premium in a higher-vol regime
  // actually pay off for this account's own trades? Computed server-side
  // (one Yahoo Finance call per distinct ticker, cached 6h) since it needs
  // historical price series, not something to derive client-side.
  const { data: ivRankBacktest, isLoading: ivRankLoading } = useQuery<IvRankBacktest>({
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

  // Scoped by the page's top-level account filter (fixed 2026-10-03, same as pnlTotals).
  const optionsIncomeTimeline = useMemo(() => buildOptionsIncomeTimeline(scopedRealizedEvents), [scopedRealizedEvents]);


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
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">Portfolio Analysis</h2>
            {lastImportedAt && (
              <span
                className="text-[10px] text-white tabular-nums normal-case tracking-normal font-normal"
                title={lastImportedAt}
              >
                last imported {formatMdYy(lastImportedAt)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {onUploadSuccess && <PortfolioUpload onSuccess={onUploadSuccess} />}
          <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
            {tabs.map(t => (
              <button key={t} onClick={() => setActivePortfolio(t)}
                className={cn("px-2.5 py-1 transition-colors",
                  activePortfolio === t ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/80 hover:text-[#d4af37]")}>
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
      <div className="grid grid-cols-4 gap-4 items-stretch">
        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">Capital Allocation</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <DonutChart data={allocationData} total={totalValue} label="Net Value" />
            <PieLegend data={allocationData} />
            {allocationMarginUsed > 0 && (
              <div className="mt-2 pt-2 border-t border-[#d4af37]/15 text-[10px] text-white">
                Margin: <span className="font-mono font-semibold text-yellow-400">${Math.round(allocationMarginUsed).toLocaleString("en-US")}</span>
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
                <div className="text-white uppercase tracking-wide">HHI</div>
                <div className="font-mono font-semibold">{concentration.hhi}</div>
              </div>
              <div>
                <div className="text-white uppercase tracking-wide">Top-5 %</div>
                <div className="font-mono font-semibold">{concentration.top5Pct.toFixed(1)}%</div>
              </div>
              <div className="truncate">
                <div className="text-white uppercase tracking-wide">Largest</div>
                <div className="font-mono font-semibold truncate">
                  {concentration.topTicker ?? "—"} {concentration.topTickerPct != null ? `${concentration.topTickerPct.toFixed(1)}%` : ""}
                </div>
              </div>
            </div>
            {marginUsage.marginUsed > 0 && (
              <div className="mt-2 pt-2 border-t border-[#d4af37]/15 flex items-center justify-between text-[10px]">
                <span className="text-white uppercase tracking-wide">Margin Used</span>
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
                <span className="text-white uppercase tracking-wide">Margin Used</span>
                <span className="font-mono font-semibold text-yellow-400">{formatCurrency(marginUsage.marginUsed)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60 min-w-0 flex flex-col">
          <CardHeader className="px-2 pt-2 pb-0 shrink-0">
            <CardTitle className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-wide leading-none">
              Risk Metrics
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0 pb-0 pt-1 flex-1 min-h-0 flex flex-col">
            {(() => {
              const shortPuts = filtered.filter((e) => e.positionType === "short_put").length;
              const shortCalls = filtered.filter((e) => e.positionType === "short_call").length;
              const openOpts = openOptionPositions.length;
              type Metric = { key: string; lines: string[]; value: string; color: string; hint: string };
              const metrics: Metric[] = [
                {
                  key: "beta",
                  lines: ["Beta", "(adj.)"],
                  value: risk.weightedBeta.toFixed(2),
                  color: risk.weightedBeta > 1.5 ? "text-red-400" : risk.weightedBeta > 1.1 ? "text-yellow-400" : "text-green-400",
                  hint: "How much your book tends to move vs the market. 1.0 ≈ moves with the market; above 1 swings harder. Covered calls lower this a bit.",
                },
                {
                  key: "delta",
                  lines: ["Net", "Delta"],
                  value: risk.netDelta > 0 ? `+${risk.netDelta.toFixed(0)}` : risk.netDelta.toFixed(0),
                  color: Math.abs(risk.netDelta) > 5000 ? "text-orange-400" : "text-zinc-100",
                  hint: "Rough share-equivalent exposure. Positive = you profit if stocks rise; negative = you lean bearish / short-put heavy.",
                },
                {
                  key: "theta",
                  lines: ["Daily", "Θ"],
                  value: `+${formatCompactCurrency(risk.dailyTheta)}`,
                  color: "text-green-400",
                  hint: "Estimated premium you keep per day if nothing moves — from short options decaying toward expiry.",
                },
                {
                  key: "gamma",
                  lines: ["Net", "Γ"],
                  value: greeksExposure.netGamma >= 0 ? `+${greeksExposure.netGamma.toFixed(1)}` : greeksExposure.netGamma.toFixed(1),
                  color: Math.abs(greeksExposure.netGamma) > 50 ? "text-orange-400" : "text-zinc-100",
                  hint: "How fast your delta changes when price jumps. Short options are usually negative gamma — big moves hurt more than small ones help.",
                },
                {
                  key: "vega",
                  lines: ["Net", "Vega"],
                  value: greeksExposure.netVega >= 0 ? `+${greeksExposure.netVega.toFixed(0)}` : greeksExposure.netVega.toFixed(0),
                  color: Math.abs(greeksExposure.netVega) > 500 ? "text-orange-400" : "text-zinc-100",
                  hint: "Sensitivity to implied volatility. Negative (typical for short premium) means IV crush helps you; IV spikes hurt.",
                },
                {
                  key: "yield",
                  lines: ["Inc.", "Yield"],
                  value: `${risk.incomeYield.toFixed(1)}%`,
                  color: risk.incomeYield >= 20 ? "text-green-400" : risk.incomeYield >= 10 ? "text-yellow-400" : "text-white",
                  hint: "Annualized premium income vs cash locked in short puts — rough run-rate if you keep rolling similar trades.",
                },
                {
                  key: "collat",
                  lines: ["Put", "Collat."],
                  value: formatCompactCurrency(risk.maxAssign),
                  color: "text-yellow-400",
                  hint: "Cash reserved to buy shares if your short puts are assigned. That's the capital at risk if every put goes ITM.",
                },
                {
                  key: "dte",
                  lines: ["Avg", "DTE"],
                  value: risk.avgDTE > 0 ? `${risk.avgDTE.toFixed(0)}d` : "—",
                  color: "text-zinc-100",
                  hint: "Premium-weighted average days left on short options. Shorter = faster theta, more rollover work.",
                },
                {
                  key: "names",
                  lines: ["Names"],
                  value: String(betaData.length),
                  color: "text-zinc-100",
                  hint: "Distinct tickers with weight in this view. More names usually means less single-stock blow-up risk.",
                },
                {
                  key: "hhi",
                  lines: ["HHI"],
                  value: String(concentration.hhi),
                  color: concentration.level === "High" ? "text-red-400" : concentration.level === "Moderate" ? "text-yellow-400" : "text-green-400",
                  hint: "Concentration score (0–10,000). Low ≈ diversified; High ≈ a few names dominate. Same idea as antitrust HHI.",
                },
                {
                  key: "top5",
                  lines: ["Top-5", "%"],
                  value: `${concentration.top5Pct.toFixed(0)}%`,
                  color: concentration.top5Pct >= 80 ? "text-red-400" : concentration.top5Pct >= 60 ? "text-yellow-400" : "text-zinc-100",
                  hint: "Share of notional in your five largest tickers. High % means diversification is mostly cosmetic.",
                },
                {
                  key: "largest",
                  lines: ["Largest"],
                  value: concentration.topTicker
                    ? `${concentration.topTicker} ${concentration.topTickerPct?.toFixed(0) ?? "—"}%`
                    : "—",
                  color: (concentration.topTickerPct ?? 0) >= 25 ? "text-orange-400" : "text-zinc-100",
                  hint: "Your biggest single-name weight. If this one gaps, it moves the whole book.",
                },
                {
                  key: "opts",
                  lines: ["Open", "opts"],
                  value: String(openOpts),
                  color: "text-zinc-100",
                  hint: "Live option contracts in this view (short + long). More contracts = more legs to manage and more assignment surface.",
                },
                {
                  key: "pc",
                  lines: ["Short", "P/C"],
                  value: `${shortPuts}/${shortCalls}`,
                  color: "text-zinc-100",
                  hint: "Count of short puts vs short calls. Puts lock cash; calls usually sit on stock (covered) or add upside risk if naked.",
                },
                {
                  key: "atrisk",
                  lines: ["At-risk", "puts"],
                  value: String(risk.atRiskPositions),
                  color: risk.atRiskPositions > 0 ? "text-red-400" : "text-white",
                  hint: "Short puts where the stock is within ~8% above the strike — close enough that a bad day can force assignment.",
                },
                {
                  key: "exp",
                  lines: ["Exp", "≤7d"],
                  value: String(risk.expiringSoon),
                  color: risk.expiringSoon > 0 ? "text-orange-400" : "text-white",
                  hint: "Positions that expire within a week. Decide now: close, roll, or let assign/expire.",
                },
                {
                  key: "earn",
                  lines: ["Earn.", "risk"],
                  value: String(earningsRiskPositions.length),
                  color: earningsRiskPositions.length > 0 ? "text-red-400" : "text-white",
                  hint: "Open options that still expire after the next earnings date — gap and IV crush risk around the print.",
                },
                {
                  key: "cc",
                  lines: ["Covered", "CC"],
                  value: String(risk.coveredCallCount),
                  color: risk.coveredCallCount > 0 ? "text-blue-400" : "text-white",
                  hint: "Tickers where you own stock and also sold calls against it. Caps upside; stock is the collateral.",
                },
                {
                  key: "wide",
                  lines: ["Wide", "spr."],
                  value: liquidityRisk.checked > 0 ? `${liquidityRisk.wide}/${liquidityRisk.checked}` : "—",
                  color: liquidityRisk.wide > 0 ? "text-red-400" : "text-white",
                  hint: "Option contracts with a very wide bid/ask (≥40% of mid). Hard to exit without giving up a lot of premium.",
                },
                {
                  key: "mod",
                  lines: ["Mod", "spr."],
                  value: liquidityRisk.checked > 0 ? `${liquidityRisk.moderate}/${liquidityRisk.checked}` : "—",
                  color: liquidityRisk.moderate > 0 ? "text-yellow-400" : "text-white",
                  hint: "Contracts with a middling spread (20–40% of mid). Tradeable, but expect slippage vs mid.",
                },
                ...(marginUsage.marginUsed > 0 || marginUsage.buyingPower > 0
                  ? ([
                      {
                        key: "margin",
                        lines: ["Margin", "used"],
                        value: `${formatCompactCurrency(marginUsage.marginUsed)} · ${marginUsage.pctUsed.toFixed(0)}%`,
                        color: marginUsage.pctUsed >= 75 ? "text-red-400" : marginUsage.pctUsed >= 50 ? "text-yellow-400" : "text-zinc-100",
                        hint: "Broker margin already drawn vs capacity (used + buying power). High % leaves less room for new trades or a drawdown.",
                      },
                      {
                        key: "bp",
                        lines: ["Buy", "power"],
                        value: formatCompactCurrency(marginUsage.buyingPower),
                        color: "text-zinc-100",
                        hint: "Buying power still available for new equity or option collateral. Cash/IRA accounts often show $0 here.",
                      },
                    ] as Metric[])
                  : []),
                ...(portfolioRisk
                  ? ([
                      {
                        key: "var",
                        lines: ["VaR", "95%"],
                        value: formatCompactCurrency(portfolioRisk.var95Usd),
                        color: "text-yellow-400",
                        hint: "Rough 1-day loss you shouldn't exceed 95% of the time (normal-returns model from recent prices). Not a guarantee.",
                      },
                      {
                        key: "cvar",
                        lines: ["CVaR", "95%"],
                        value: formatCompactCurrency(portfolioRisk.cvar95Usd),
                        color: "text-red-400",
                        hint: "Average loss on the bad 5% of days — how ugly the tail looks if VaR is breached.",
                      },
                      {
                        key: "vol",
                        lines: ["Daily", "vol"],
                        value: `${portfolioRisk.dailyVolatilityPct.toFixed(2)}%`,
                        color: "text-zinc-100",
                        hint: "Estimated day-to-day % swing of the portfolio from recent returns and weights.",
                      },
                    ] as Metric[])
                  : []),
              ];
              const rows: Metric[][] = [];
              for (let i = 0; i < metrics.length; i += 2) rows.push(metrics.slice(i, i + 2));
              return (
                <div className="flex flex-col h-full min-h-0 border-t border-zinc-800/50">
                  {rows.map((pair, ri) => (
                    <div
                      key={ri}
                      className={cn(
                        "flex flex-1 min-h-[28px] border-b border-zinc-800/40 hover:bg-amber-500/[0.04]",
                        ri % 2 === 0 ? "bg-zinc-950" : "bg-zinc-900/50",
                      )}
                    >
                      {([0, 1] as const).map((ci) => {
                        const m = pair[ci];
                        if (!m) {
                          return <div key={ci} className="flex-1 border-r border-zinc-800/40 last:border-r-0" />;
                        }
                        return (
                          <div
                            key={m.key}
                            className={cn(
                              "flex flex-1 items-center min-w-0 gap-1 px-1.5",
                              ci === 0 && "border-r border-zinc-800/60",
                            )}
                          >
                            <UiTooltip delayDuration={200}>
                              <TooltipTrigger asChild>
                                <span className="w-[2.75rem] shrink-0 cursor-help text-[8px] uppercase tracking-wide text-white leading-[1.05] border-b border-dotted border-white/40">
                                  {m.lines.map((ln) => (
                                    <span key={ln} className="block">{ln}</span>
                                  ))}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent
                                side="top"
                                className="max-w-[240px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug font-normal normal-case tracking-normal"
                              >
                                {m.hint}
                              </TooltipContent>
                            </UiTooltip>
                            <span className={cn("flex-1 min-w-0 text-right font-mono tabular-nums text-[10px] font-semibold truncate leading-none", m.color)}>
                              {m.value}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              );
            })()}
          </CardContent>
        </Card>
      </div>

      {/* Charts below the fold — defer mount until near viewport */}
      <LazyMount
        minHeight={280}
        fallback={
          <div className="rounded-md border border-[#d4af37]/20 bg-zinc-950 px-3 py-8 text-[10px] text-white text-center">
            Charts · scroll to load
          </div>
        }
      >
      <div className="space-y-4">
      {/* Row 1.1a: Beta + trade-type — same box sizing/styling as Tickers / Cum P&L row */}
      <div className="grid grid-cols-2 gap-4 min-w-0">
        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
                  Beta Contribution
                </CardTitle>
                <p className="text-[10px] text-white">weighted β · covered calls adjusted to δ×0.70</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {topBetaData.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-xs text-white">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={topBetaData} barSize={32} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="ticker" interval={0} tick={{ fontSize: 12, fontWeight: 600, fill: "#ffffff" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "#ffffff" }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 min-w-[140px] text-white">
                        <div className="font-semibold flex items-center gap-1">
                          {d.ticker}
                          {d.covered && <span className="text-purple-400" title="Covered call">★</span>}
                        </div>
                        <div className="flex justify-between gap-4"><span className="text-white">β Contribution</span><span className="font-mono font-semibold">{d.contribution.toFixed(3)}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-white">Beta</span><span className="font-mono">{d.beta}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-white">Weight</span><span className="font-mono">{d.weight}%</span></div>
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
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
                  Cumulative P&amp;L by Trade Type
                </CardTitle>
                <p className="text-[10px] text-white">realized + unrealized · scoped to {activePortfolio}</p>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {tradeTypeChartData.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-xs text-white">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={tradeTypeChartData} barSize={32} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="category" interval={0} tick={{ fontSize: 11, fontWeight: 600, fill: "#ffffff" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: "#ffffff" }} axisLine={false} tickLine={false} width={36} tickFormatter={(v) => formatCompactCurrencyInt(v)} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 min-w-[150px] text-white">
                        <div className="font-semibold">{d.category}</div>
                        <div className="flex justify-between gap-4"><span className="text-white/80">Realized</span><span className="font-mono font-semibold">{formatCurrency(d.realized)}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-white/80">Unrealized</span><span className="font-mono font-semibold">{formatCurrency(d.unrealized)}</span></div>
                        <div className="flex justify-between gap-4 pt-1 border-t border-[#d4af37]/20"><span className="text-white/80">Total</span><span className="font-mono font-bold">{formatCurrency(d.total)}</span></div>
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

      {/* Row 1.1b: Cumulative P&L tickers + line chart (P&L table is a sub-tab) */}
      <div className="grid grid-cols-2 gap-4 min-w-0">
        <Card className="bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
          <CardHeader className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
                  Cumulative P&amp;L — Tickers
                </CardTitle>
                <p className="text-[10px] text-white">all accounts · realized + unrealized</p>
              </div>
              <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
                {([{ key: "top", label: "Top 8" }, { key: "all", label: "All" }] as const).map(t => (
                  <button key={t.key} onClick={() => setTickerChartScope(t.key)}
                    className={cn("px-2 py-0.5 transition-colors",
                      tickerChartScope === t.key ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/80 hover:text-[#d4af37]")}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {topTickersPnlChartData.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-xs text-white">No data</div>
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
                          <div key={key} className="flex justify-between gap-4"><span className="text-white">{label}</span><span className="font-mono">{formatCurrency(d[key])}</span></div>
                        ))}
                        <div className="flex justify-between gap-4 pt-1 border-t border-[#d4af37]/20"><span className="text-white">Total Earned</span><span className="font-mono font-bold">{formatCurrency(d.totalEarned)}</span></div>
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
                <p className="text-[10px] text-white">
                  {cumPnlView === "realized" && "stock + options + dividends · includes assignment lots · scoped to " + activePortfolio}
                  {cumPnlView === "unrealized" && "live mark-to-market on open positions, today · flat line (no daily history kept) · scoped to " + activePortfolio}
                  {cumPnlView === "total" && "realized history + live unrealized added at today · scoped to " + activePortfolio}
                  {cumPnlView === "table" && "same scope as chart · realized + live unrealized by trade type · " + activePortfolio}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
                  {([
                    { key: "realized", label: "Realized" },
                    { key: "unrealized", label: "Unrealized" },
                    { key: "total", label: "Total" },
                    { key: "table", label: "Table" },
                  ] as const).map(t => (
                    <button key={t.key} onClick={() => setCumPnlView(t.key)}
                      className={cn("px-2 py-0.5 transition-colors",
                        cumPnlView === t.key ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/80 hover:text-[#d4af37]")}>
                      {t.label}
                    </button>
                  ))}
                </div>
                {cumPnlView !== "table" && (
                  <div className="text-right">
                    <div className="text-[10px] text-white uppercase tracking-wide">
                      {cumPnlView === "realized" && "Total Realized"}
                      {cumPnlView === "unrealized" && "Live Unrealized"}
                      {cumPnlView === "total" && "Total (incl. live)"}
                    </div>
                    <div className={cn("text-sm font-bold font-mono tabular-nums", (cumulativePnlTimeline.at(-1)?.cumulative ?? 0) >= 0 ? "text-green-400" : "text-red-400")}>
                      {(cumulativePnlTimeline.at(-1)?.cumulative ?? 0) >= 0 ? "+" : ""}{formatCurrency(cumulativePnlTimeline.at(-1)?.cumulative ?? 0)}
                    </div>
                  </div>
                )}
                {cumPnlView === "table" && (
                  <div className="text-right">
                    <div className="text-[10px] text-white uppercase tracking-wide">Grand Total</div>
                    <div className={cn("text-sm font-bold font-mono tabular-nums", pnlTotals.grandTotal.total >= 0 ? "text-green-400" : "text-red-400")}>
                      {pnlTotals.grandTotal.total >= 0 ? "+" : ""}{formatCurrency(pnlTotals.grandTotal.total)}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {cumPnlView === "table" ? (
              <div className="h-[240px] overflow-y-auto">
                <table className="w-full table-fixed text-[11px]">
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[20%]" />
                    <col className="w-[20%]" />
                    <col className="w-[20%]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b border-[#d4af37]/15">
                      <th className="text-left py-1 px-1 text-[9px] font-semibold text-white uppercase tracking-wider" />
                      {["Realized", "Unreal.", "Total"].map(h => (
                        <th key={h} className="text-right py-1 px-1 text-[9px] font-semibold text-white uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pnlTotals.rows.map(row => (
                      <tr key={row.label} className="border-t border-border/20">
                        <td className="py-1.5 px-1 font-medium truncate" title={row.label}>{row.label}</td>
                        {[row.realized, row.unrealized, row.total].map((v, i) => (
                          <td key={i} className={cn("py-1.5 px-1 text-right font-mono tabular-nums font-semibold",
                            v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-white")}>
                            {v >= 0 ? "+" : ""}{formatCompactCurrency(v)}
                          </td>
                        ))}
                      </tr>
                    ))}
                    <tr className="border-t border-[#d4af37]/20">
                      <td className="py-1.5 px-1 font-bold">Total</td>
                      {[pnlTotals.grandTotal.realized, pnlTotals.grandTotal.unrealized, pnlTotals.grandTotal.total].map((v, i) => (
                        <td key={i} className={cn("py-1.5 px-1 text-right font-mono tabular-nums font-bold",
                          v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-white")}>
                          {v >= 0 ? "+" : ""}{formatCompactCurrency(v)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : cumulativePnlTimeline.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-xs text-white">No data</div>
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
                    tickFormatter={(d: string) => formatMYy(d)} />
                  <YAxis tick={{ fontSize: 11, fill: "#ffffff" }} axisLine={false} tickLine={false}
                    width={44} tickFormatter={(v) => formatCompactCurrencyInt(v)} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 text-white">
                        <div className="font-semibold">{formatMdYy(d.date)}</div>
                        <div className="flex justify-between gap-4">
                          <span className="text-white/80">Cumulative</span>
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

      </div>
      </LazyMount>

      {/* Detail sub-tabs: Top Tickers / Summary / Income / Correlation / Health / … */}
      <LazyMount
        minHeight={200}
        fallback={
          <div className="rounded-md border border-[#d4af37]/20 bg-zinc-950 px-3 py-6 text-[10px] text-white text-center">
            Holdings detail · scroll to load
          </div>
        }
      >
      <Card className="overflow-hidden min-w-0 bg-zinc-950 border-[#d4af37]/25 shadow-lg shadow-black/60">
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-1.5">
            <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold shrink-0">
              {DETAIL_TABS.map(t => (
                <button key={t.key} onClick={() => setDetailTab(t.key)}
                  className={cn("px-2.5 py-1 transition-colors whitespace-nowrap",
                    detailTab === t.key ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/80 hover:text-[#d4af37]")}>
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
                          (detailTab === "tickers" ? tickersTab : summaryTab) === t.key ? "bg-background text-foreground shadow-sm" : "text-white hover:text-foreground")}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="text-[10px] text-white/80 italic">
                    scoped to {activePortfolio} (top filter)
                  </span>
                )}
                <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
                  {([{ key: "top", label: `Top ${TOP_N}` }, { key: "all", label: "All" }] as const).map(t => (
                    <button key={t.key}
                      onClick={() => detailTab === "tickers" ? setTickersScope(t.key) : setSummaryScope(t.key)}
                      className={cn("px-2 py-0.5 transition-colors",
                        (detailTab === "tickers" ? tickersScope : summaryScope) === t.key
                          ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/80 hover:text-[#d4af37]")}>
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <p className="text-[10px] text-white normal-case pt-1.5">
            {detailTab === "tickers" && "Top Tickers — by frequency, net realized P&L YTD (stock sales include assignment exits when exported)"}
            {detailTab === "summary" && "Cumulative Summary — realized + unrealized + dividends (not calendar-YTD clipped)"}
            {detailTab === "income" && `Options Income Timeline — sold calls + sold puts · net gain/loss · bi-weekly since 1/1 · scoped to ${activePortfolio}`}
            {detailTab === "corr" && "Correlation & VaR — 3mo daily returns, weight-ranked names · hover a cell for the pair"}
            {detailTab === "health" && "Option Position Health — break-even, moneyness, and assignment/exercise risk per leg"}
            {detailTab === "backtest" && "Vol-Rank Backtest — does selling premium in a higher-volatility regime actually pay off for YOUR trades? (realized-vol proxy, not true IV history)"}
            {detailTab === "equity" && "Equity Holdings — grouped by account"}
            {detailTab === "options" && "Options Holdings — grouped by account, active contracts"}
          </p>
          {detailTab === "corr" && portfolioRisk && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] font-mono tabular-nums pt-1.5 pb-0.5">
              <span className="text-yellow-400">VaR 95% {formatCompactCurrency(portfolioRisk.var95Usd)} ({portfolioRisk.var95Pct.toFixed(1)}%)</span>
              <span className="text-red-400">CVaR {formatCompactCurrency(portfolioRisk.cvar95Usd)} ({portfolioRisk.cvar95Pct.toFixed(1)}%)</span>
              <span className="text-white">Vol {portfolioRisk.dailyVolatilityPct.toFixed(2)}%</span>
              <span className="text-white">{portfolioRisk.tickers.length} names</span>
              {portfolioRisk.skippedTickers.length > 0 && (
                <span className="text-white/80 truncate max-w-[220px]" title={portfolioRisk.skippedTickers.join(", ")}>
                  no hx: {portfolioRisk.skippedTickers.slice(0, 6).join(", ")}
                  {portfolioRisk.skippedTickers.length > 6 ? ` +${portfolioRisk.skippedTickers.length - 6}` : ""}
                </span>
              )}
            </div>
          )}
          {detailTab === "income" && (
            <div className="flex items-center gap-5 pt-2 pb-1">
              <div>
                <div className="text-[10px] text-white uppercase tracking-wide">YTD Earned</div>
                <div className={cn("text-sm font-bold font-mono tabular-nums", optionsIncomeTimeline.ytdActual >= 0 ? "text-green-400" : "text-red-400")}>
                  {optionsIncomeTimeline.ytdActual >= 0 ? "+" : ""}{formatCurrency(optionsIncomeTimeline.ytdActual)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-white uppercase tracking-wide">Avg Monthly</div>
                <div className="text-sm font-bold font-mono tabular-nums text-white">
                  {formatCurrency(optionsIncomeTimeline.avgMonthlyEarned)}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-white uppercase tracking-wide">Projected Annual</div>
                <div className={cn("text-sm font-bold font-mono tabular-nums", optionsIncomeTimeline.projectedAnnualTotal >= 0 ? "text-green-400" : "text-red-400")}>
                  {optionsIncomeTimeline.projectedAnnualTotal >= 0 ? "+" : ""}{formatCurrency(optionsIncomeTimeline.projectedAnnualTotal)}
                </div>
              </div>
            </div>
          )}
        </CardHeader>
        {detailTab === "tickers" && <TopTickersPanel rows={displayedTopTickers} />}
        {detailTab === "summary" && <CumulativeSummaryPanel rows={displayedSummary} />}
        {detailTab === "corr" && <CorrelationPanel risk={portfolioRisk} scaleMax={correlationScaleMax} />}
        {detailTab === "income" && <OptionsIncomePanel timeline={optionsIncomeTimeline} />}

        {detailTab === "health" && (
          <PositionHealthPanel putPositions={risk.putPositions} callPositions={risk.callPositions} liveDeltaById={liveOptionDeltaByEntryId} />
        )}

        {detailTab === "backtest" && <VolBacktestPanel data={ivRankBacktest} loading={ivRankLoading} />}

        {(detailTab === "equity" || detailTab === "options") && (
        <CardContent className="px-0 pb-0">
          {snapshotLoading && (
            <p className="text-xs text-white/80 animate-pulse px-3 py-3">Loading portfolio…</p>
          )}
          {!!snapshotError && (
            <p className="text-xs text-red-400 px-3 py-3">Failed to load portfolio data.</p>
          )}
          {!snapshotLoading && !snapshotError && !snapshotData?.snapshot && (
            <p className="text-xs text-white/80 px-3 py-3">No snapshot yet — upload a Robinhood CSV above.</p>
          )}
          {!snapshotLoading && !snapshotError && snapshotData?.snapshot && (
            detailTab === "equity"
              ? <EquityTable positions={holdingsPositions} />
              : <OptionsTable options={holdingsOptions} accountMap={holdingsAccountMap} />
          )}
        </CardContent>
        )}
      </Card>
      </LazyMount>
    </div>
  );
}
