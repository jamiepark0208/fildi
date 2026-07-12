import { useMemo, useState } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import {
  type PortfolioEntry, cashCollateral, premiumReceived,
  daysToExpiry, isShortPosition, entryPortfolio,
} from "@/hooks/use-portfolio";
import { type StockMetrics } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AlertTriangle, Activity, Shield, Zap, TrendingDown, Layers, BarChart2, Percent } from "lucide-react";

// ── Palette ───────────────────────────────────────────────────────────────────

// Dense data-grid look matching RobinhoodPortfolio's Equity Positions table.
const TTH = "py-2 px-3 font-medium text-[10px] uppercase tracking-widest text-muted-foreground";
const TTD = "py-2 px-3 text-xs tabular-nums";

// Whole strikes render without decimals; fractional strikes (e.g. 6.5) keep only as many as needed.
function formatStrike(strike: number): string {
  return `$${Number(strike.toFixed(2))}`;
}

const PALETTE = [
  "#38bdf8","#fb923c","#34d399","#a78bfa",
  "#f472b6","#fbbf24","#60a5fa","#f87171",
  "#4ade80","#e879f9","#94a3b8","#2dd4bf",
];

// Yahoo's assetProfile has no GICS sector for these funds — they're option-income/leveraged
// ETFs, not equities, so we label them by strategy instead of falling back to "Unknown".
const SECTOR_OVERRIDES: Record<string, string> = {
  NVDY: "ETF (Option Income)",
  HOOY: "ETF (Option Income)",
  PLTU: "Levered ETF",
};

// These pairs share the same underlying (derivative-of-underlying ETFs), so their
// correlation is mechanically ~1 and would wash out the color scale for every other,
// actually-informative pair in the matrix — excluded from scaling, not just from display.
const SAME_UNDERLYING_PAIRS: [string, string][] = [
  ["HOOD", "HOOY"],
  ["NVDA", "NVDY"],
  ["PLTR", "PLTU"],
];
function isSameUnderlyingPair(a: string, b: string): boolean {
  return SAME_UNDERLYING_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

// Beta Contribution bar colors: covered-call positions get their own color regardless of
// contribution size (the delta adjustment already lowers their bar), everything else is
// banded by raw contribution so the biggest single-name risk concentrations stand out.
const BETA_BAR_LEGEND = [
  { color: "#a78bfa", label: "Covered Call" },
  { color: "#f97316", label: "Contribution > 0.4" },
  { color: "#fbbf24", label: "Contribution 0.2–0.4" },
  { color: "#34d399", label: "Contribution < 0.2" },
];

// Blue = low correlation (good diversification), red = high correlation (concentration
// risk) — fully opaque background fill scaled by magnitude, white text on top for
// contrast. Alpha-blending this against the dark card background (previous version)
// desaturated everything into a dim gray-purple; solid fills read as actual blue/red.
const CORR_LOW_RGB  = [59, 130, 246];  // blue-500 (#3b82f6)
const CORR_HIGH_RGB = [239, 68, 68];   // red-500  (#ef4444)
function correlationBg(v: number, scaleMax: number): string {
  const t = Math.min(Math.abs(v) / scaleMax, 1);
  const [r, g, b] = CORR_LOW_RGB.map((low, idx) => Math.round(low + (CORR_HIGH_RGB[idx] - low) * t));
  return `rgb(${r},${g},${b})`;
}

// ── Covered call detection ────────────────────────────────────────────────────

interface CoveredCallPair {
  ticker: string;
  stockShares: number;
  callContracts: number;
  coveredContracts: number;
  strikes: number[];
}

function detectCoveredCalls(entries: PortfolioEntry[]): Map<string, CoveredCallPair> {
  const stockMap: Record<string, number>           = {};
  const callMap:  Record<string, PortfolioEntry[]> = {};

  entries.forEach(e => {
    if (e.positionType === "stock")       stockMap[e.ticker] = (stockMap[e.ticker] ?? 0) + e.qty;
    if (e.positionType === "short_call") {
      if (!callMap[e.ticker]) callMap[e.ticker] = [];
      callMap[e.ticker].push(e);
    }
  });

  const pairs = new Map<string, CoveredCallPair>();
  Object.entries(callMap).forEach(([ticker, calls]) => {
    const stockShares = stockMap[ticker] ?? 0;
    if (stockShares === 0) return;
    const callContracts    = calls.reduce((s, c) => s + c.qty, 0);
    const coveredContracts = Math.min(callContracts, Math.floor(stockShares / 100));
    if (coveredContracts > 0) {
      pairs.set(ticker, {
        ticker, stockShares, callContracts, coveredContracts,
        strikes: calls.map(c => c.strike ?? 0).filter(Boolean),
      });
    }
  });
  return pairs;
}

// ── Tooltips ──────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, format }: {
  active?: boolean; payload?: any[]; format?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1">
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 min-w-[120px]">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: p.fill ?? p.color }} />
          <span className="text-muted-foreground flex-1">{p.name ?? p.dataKey}</span>
          <span className="font-mono font-semibold">{format ? format(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

function PieTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0];
  const displayValue = d.payload.signedValue ?? d.value;
  const breakdown: { name: string; value: number; pct: number }[] | undefined = d.payload.breakdown;
  return (
    <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs max-w-[220px]">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full" style={{ background: d.payload.color }} />
        <span className="text-muted-foreground">{d.name}</span>
      </div>
      <div className="font-mono font-semibold mt-0.5">{formatCurrency(displayValue)}</div>
      <div className="text-muted-foreground">{d.payload.pct?.toFixed(1)}%</div>
      {breakdown && breakdown.length > 0 && (
        <div className="mt-1.5 pt-1.5 border-t border-border/60 space-y-0.5">
          {breakdown.slice(0, 8).map(b => (
            <div key={b.name} className="flex items-center justify-between gap-3 font-mono">
              <span className="text-muted-foreground">{b.name}</span>
              <span>{formatCurrency(b.value)} <span className="text-muted-foreground">({b.pct.toFixed(1)}%)</span></span>
            </div>
          ))}
          {breakdown.length > 8 && (
            <div className="text-muted-foreground">+{breakdown.length - 8} more</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Donut chart ───────────────────────────────────────────────────────────────

function DonutChart({ data, total, label }: {
  data: { name: string; value: number; color: string; pct?: number; signedValue?: number; breakdown?: { name: string; value: number; pct: number }[] }[];
  total: number; label: string;
}) {
  if (!data.length) return (
    <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">No data</div>
  );
  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={52} outerRadius={72}
            dataKey="value" stroke="none" paddingAngle={2}>
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip content={<PieTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-center">
          <div className="text-[10px] text-muted-foreground leading-none">{label}</div>
          <div className="text-sm font-bold font-mono mt-0.5 leading-none">{formatCurrency(total)}</div>
        </div>
      </div>
    </div>
  );
}

function PieLegend({ data }: { data: { name: string; value: number; color: string; pct?: number; signedValue?: number }[] }) {
  return (
    <div className="space-y-1.5 mt-2">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <div className="w-2 h-2 rounded-full shrink-0" style={{ background: d.color }} />
          <span className="text-muted-foreground flex-1 truncate">{d.name}</span>
          <span className="font-mono tabular-nums text-right">{d.pct?.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

// ── Risk stat ─────────────────────────────────────────────────────────────────

function RiskStat({ label, value, sub, icon, color }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; color?: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-secondary/20 border border-border/50">
      <div className={cn("mt-0.5 shrink-0", color ?? "text-muted-foreground")}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{label}</div>
        <div className="text-lg font-bold font-mono tabular-nums leading-tight">{value}</div>
        {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

// ── Portfolio Analysis ────────────────────────────────────────────────────────

interface AccountSummary {
  account: string; nickname: string | null; totalValue: string | null;
  equityValue: string | null; optionsValue: string | null; cryptoValue: string | null; cash: string | null;
  marginUsed: string | null; buyingPower: string | null;
}

interface RealizedEvent {
  account: string; symbol: string; assetType: "stock" | "option" | "dividend"; direction: "long" | "short" | null;
  optionType: "call" | "put" | null; qty: number; pnl: number; fees: number; closedAt: string;
}

interface PortfolioRiskResult {
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
}

export function PortfolioAnalysis({ entries, priceMap, stockDataMap, portfolioNames, accountSummaries = [], realizedEvents = [] }: PortfolioAnalysisProps) {
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
  const marginUsage = useMemo(() => {
    const scopedSummaries = activePortfolio === "All"
      ? accountSummaries
      : accountSummaries.filter(a => (a.nickname ?? a.account) === activePortfolio);
    let marginUsed = 0, buyingPower = 0;
    scopedSummaries.forEach(a => {
      marginUsed  += parseFloat(a.marginUsed ?? "0");
      buyingPower += parseFloat(a.buyingPower ?? "0");
    });
    const capacity = marginUsed + buyingPower;
    return { marginUsed, buyingPower, pctUsed: capacity > 0 ? (marginUsed / capacity) * 100 : 0 };
  }, [accountSummaries, activePortfolio]);

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
  const concentration = useMemo(() => {
    const weights = betaData.map(d => d.weight).sort((a, b) => b - a);
    const hhi = weights.reduce((s, w) => s + w * w, 0);
    const top5Pct = weights.slice(0, 5).reduce((s, w) => s + w, 0);
    const level: "Low" | "Moderate" | "High" = hhi < 1500 ? "Low" : hhi < 2500 ? "Moderate" : "High";
    return { hhi: Math.round(hhi), top5Pct, level, topTicker: betaData[0]?.ticker, topTickerPct: betaData[0]?.weight };
  }, [betaData]);

  // ── Portfolio Greeks (Vega/Gamma exposure) ──────────────────────────────────
  // Position-level sign flips for short options (selling a put/call means you're
  // short that option's gamma/vega, i.e. exposure runs opposite the raw per-contract
  // Greek) — same convention as the Delta/Theta banners elsewhere in this app.
  const greeksExposure = useMemo(() => {
    let netVega = 0, netGamma = 0;
    for (const e of filtered) {
      if (e.positionType === "stock" || e.gamma == null && e.vega == null) continue;
      const sign = isShortPosition(e.positionType) ? -1 : 1;
      if (e.vega != null)  netVega  += e.vega  * 100 * e.qty * sign;
      if (e.gamma != null) netGamma += e.gamma * 100 * e.qty * sign;
    }
    return { netVega, netGamma };
  }, [filtered]);

  // ── Liquidity / spread risk ──────────────────────────────────────────────────
  // CSV bid/ask are a stale snapshot from import time — same problem the options
  // scanner solves by hitting Yahoo live. Reuse its exact per-contract endpoint
  // (/api/options/position-quote → getOptionPositionQuote) instead of the CSV values.
  const openOptionPositions = useMemo(
    () => filtered.filter(e => isShortPosition(e.positionType) || e.positionType === "long_put" || e.positionType === "long_call")
      .filter(e => e.strike != null && e.expiry),
    [filtered],
  );

  const liquidityQueries = useQueries({
    queries: openOptionPositions.map(e => {
      const optionType: "call" | "put" = e.positionType.includes("call") ? "call" : "put";
      return {
        queryKey: ["option-position-quote", e.ticker, e.expiry, e.strike, optionType],
        queryFn: async () => {
          const params = new URLSearchParams({ ticker: e.ticker, expiry: e.expiry!, strike: String(e.strike), type: optionType });
          const res = await fetch(`/api/options/position-quote?${params}`, { credentials: "include" });
          if (!res.ok) throw new Error("Failed to fetch live quote");
          return res.json() as Promise<{ bid: number | null; ask: number | null; midPrice: number | null }>;
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
  const correlationScaleMax = useMemo(() => {
    if (!portfolioRisk) return 1;
    let max = 0;
    portfolioRisk.tickers.forEach((rowTicker, i) => {
      portfolioRisk.correlationMatrix[i].forEach((v, j) => {
        if (i === j) return;
        if (isSameUnderlyingPair(rowTicker, portfolioRisk.tickers[j])) return;
        max = Math.max(max, Math.abs(v));
      });
    });
    return max > 0 ? max : 1;
  }, [portfolioRisk]);

  // ── P&L: realized (from transaction history) + unrealized (from open positions) ──
  const pnlTotals = useMemo(() => {
    const stockRealized = realizedEvents.filter(e => e.assetType === "stock").reduce((s, e) => s + e.pnl, 0);
    const realizedFor = (direction: "short" | "long", optionType: "call" | "put") =>
      realizedEvents.filter(e => e.assetType === "option" && e.direction === direction && e.optionType === optionType)
        .reduce((s, e) => s + e.pnl, 0);
    const shortCallRealized = realizedFor("short", "call");
    const shortPutRealized  = realizedFor("short", "put");
    const longCallRealized  = realizedFor("long", "call");
    const longPutRealized   = realizedFor("long", "put");
    // Cash bonuses are migrated as dividend rows (no ticker-specific holding), so this
    // sums both — pure cash income, no unrealized leg.
    const dividendRealized  = realizedEvents.filter(e => e.assetType === "dividend").reduce((s, e) => s + e.pnl, 0);

    const stockUnrealized = filtered.filter(e => e.positionType === "stock").reduce((s, e) => s + (e.unrealizedPnL ?? 0), 0);
    const unrealizedFor = (positionType: string) =>
      filtered.filter(e => e.positionType === positionType).reduce((s, e) => s + (e.unrealizedPnL ?? 0), 0);
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
  }, [realizedEvents, filtered]);

  // ── Account key/label pairs shared by the Top Tickers + Cumulative Summary cards.
  // realizedEvents.account is the raw Robinhood account id; accountSummaries carries
  // the id→nickname mapping ("FILDI" / "Traditional IRA") already used by the
  // top-level portfolio filter above — reuse the same nickname as the grouping key
  // so both cards agree with the rest of the page, but label the IRA tab "IRA" for brevity.
  const ACCOUNT_TABS = [
    { key: "FILDI", label: "FILDI" },
    { key: "Traditional IRA", label: "IRA" },
  ] as const;
  type AccountTabKey = typeof ACCOUNT_TABS[number]["key"];

  const accountNickMap = useMemo(() => {
    const m = new Map<string, string>();
    accountSummaries.forEach(a => m.set(a.account, a.nickname ?? a.account));
    return m;
  }, [accountSummaries]);

  // ── Top tickers by trade frequency, net realized P&L YTD — split by account ──
  const topTickersByAccount = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const buildFor = (accountKey: string) => {
      const bySymbol = new Map<string, { puts: number; calls: number; stockSales: number; netPnl: number }>();
      realizedEvents.forEach(e => {
        if (e.assetType === "dividend") return;
        if ((accountNickMap.get(e.account) ?? e.account) !== accountKey) return;
        if (new Date(e.closedAt).getFullYear() !== currentYear) return;
        const cur = bySymbol.get(e.symbol) ?? { puts: 0, calls: 0, stockSales: 0, netPnl: 0 };
        if (e.assetType === "option" && e.direction === "short" && e.optionType === "put") cur.puts += 1;
        else if (e.assetType === "option" && e.direction === "short" && e.optionType === "call") cur.calls += 1;
        else if (e.assetType === "stock") cur.stockSales += 1;
        cur.netPnl += e.pnl;
        bySymbol.set(e.symbol, cur);
      });
      return Array.from(bySymbol.entries())
        .map(([symbol, v]) => ({ symbol, ...v, count: v.puts + v.calls + v.stockSales }))
        .sort((a, b) => b.count - a.count || b.netPnl - a.netPnl)
        .slice(0, 10);
    };
    return Object.fromEntries(ACCOUNT_TABS.map(t => [t.key, buildFor(t.key)])) as Record<AccountTabKey, ReturnType<typeof buildFor>>;
  }, [realizedEvents, accountNickMap]);

  // ── Cumulative summary per ticker — mirrors the CSV's per-account SUMMARY table ──
  const cumulativeSummaryByAccount = useMemo(() => {
    const buildFor = (accountKey: string) => {
      const rows = new Map<string, {
        sellPut: number; sellCall: number; longCall: number; longPut: number;
        stocksRealized: number; dividends: number; stocksUnrealized: number; optionsUnrealized: number;
      }>();
      const ensure = (t: string) => {
        if (!rows.has(t)) rows.set(t, { sellPut: 0, sellCall: 0, longCall: 0, longPut: 0, stocksRealized: 0, dividends: 0, stocksUnrealized: 0, optionsUnrealized: 0 });
        return rows.get(t)!;
      };
      realizedEvents.forEach(e => {
        if ((accountNickMap.get(e.account) ?? e.account) !== accountKey) return;
        if (e.assetType === "dividend") { ensure(e.symbol).dividends += e.pnl; return; }
        if (e.assetType === "stock") { ensure(e.symbol).stocksRealized += e.pnl; return; }
        const row = ensure(e.symbol);
        if (e.direction === "short" && e.optionType === "put") row.sellPut += e.pnl;
        else if (e.direction === "short" && e.optionType === "call") row.sellCall += e.pnl;
        else if (e.direction === "long" && e.optionType === "call") row.longCall += e.pnl;
        else if (e.direction === "long" && e.optionType === "put") row.longPut += e.pnl;
      });
      entries.forEach(e => {
        if (entryPortfolio(e) !== accountKey) return;
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
    return Object.fromEntries(ACCOUNT_TABS.map(t => [t.key, buildFor(t.key)])) as Record<AccountTabKey, ReturnType<typeof buildFor>>;
  }, [realizedEvents, entries, accountNickMap]);

  const [tickersTab, setTickersTab] = useState<AccountTabKey>("FILDI");
  const [summaryTab, setSummaryTab] = useState<AccountTabKey>("FILDI");

  // ── DTE histogram ───────────────────────────────────────────────────────────
  const dteData = useMemo(() => {
    const buckets = [
      { label: "Today",  min: 0,  max: 0,        color: "#ef4444", qty: 0, premium: 0 },
      { label: "1-7d",   min: 1,  max: 7,        color: "#f97316", qty: 0, premium: 0 },
      { label: "8-14d",  min: 8,  max: 14,       color: "#eab308", qty: 0, premium: 0 },
      { label: "15-21d", min: 15, max: 21,       color: "#22c55e", qty: 0, premium: 0 },
      { label: "22-30d", min: 22, max: 30,       color: "#3b82f6", qty: 0, premium: 0 },
      { label: "30d+",   min: 31, max: Infinity, color: "#8b5cf6", qty: 0, premium: 0 },
    ];
    filtered.forEach(e => {
      const dte = daysToExpiry(e.expiry);
      if (dte === null || dte < 0) return;
      const bucket = buckets.find(b => dte >= b.min && dte <= b.max);
      if (bucket) { bucket.qty += e.qty; bucket.premium += premiumReceived(e); }
    });
    return buckets.filter(b => b.qty > 0);
  }, [filtered]);

  // ── Risk metrics ─────────────────────────────────────────────────────────────
  const risk = useMemo(() => {
    const weightedBeta = betaData.reduce((s, d) => s + d.contribution, 0);

    let premiumSum = 0, premiumDTE = 0, totalCollateral = 0;
    filtered.forEach(e => {
      if (isShortPosition(e.positionType) && e.expiry) {
        const dte = daysToExpiry(e.expiry);
        if (dte != null && dte > 0) {
          const prem = premiumReceived(e);
          premiumSum += prem;
          premiumDTE += dte * prem;
        }
      }
      if (e.positionType === "short_put") totalCollateral += cashCollateral(e);
    });

    const avgDTE     = premiumSum > 0 ? premiumDTE / premiumSum : 0;
    const dailyTheta = avgDTE > 0 ? premiumSum / avgDTE : 0;
    const maxAssign  = totalCollateral;
    const expiringSoon = filtered.filter(e => {
      const d = daysToExpiry(e.expiry);
      return d !== null && d >= 0 && d <= 7;
    }).length;

    // Annualized income yield on collateral deployed
    const incomeYield = totalCollateral > 0 && avgDTE > 0
      ? (premiumSum / totalCollateral) * (365 / avgDTE) * 100
      : 0;

    // Net portfolio delta (approximations: stock=1.0, short_put=-0.25, short_call=+0.30)
    let netDelta = 0;
    filtered.forEach(e => {
      if (e.positionType === "stock")       netDelta += e.qty * 1.0;
      else if (e.positionType === "short_put")  netDelta -= e.qty * 100 * 0.25;
      else if (e.positionType === "short_call") netDelta += e.qty * 100 * 0.30;
    });

    // At-risk short puts: current price within 8% above strike
    const atRiskPositions = filtered.filter(e => {
      if (e.positionType !== "short_put" || !e.strike) return false;
      const price = priceMap[e.ticker];
      return price !== undefined && price < e.strike * 1.08;
    });

    type OptionRow = {
      ticker: string; positionType: string; strike: number;
      premium: number; breakEven: number; qty: number;
      currentPrice: number | null; moneyness: number | null;
      collateral: number | null;
    };

    const putPositions: OptionRow[] = filtered
      .filter(e => (e.positionType === "short_put" || e.positionType === "long_put") && e.strike)
      .map(e => {
        const price = priceMap[e.ticker] ?? null;
        const breakEven = e.positionType === "short_put"
          ? e.strike! - e.avgPrice
          : e.strike! + e.avgPrice;
        return {
          ticker: e.ticker, positionType: e.positionType,
          strike: e.strike!, premium: e.avgPrice, breakEven, qty: e.qty,
          currentPrice: price,
          moneyness: price ? ((price / e.strike!) - 1) * 100 : null,
          // Cash secured by the broker against assignment: strike × 100 × contracts.
          collateral: e.positionType === "short_put" ? e.strike! * 100 * e.qty : null,
        };
      })
      .sort((a, b) => (b.collateral ?? -1) - (a.collateral ?? -1));

    const callPositions: OptionRow[] = filtered
      .filter(e => (e.positionType === "short_call" || e.positionType === "long_call") && e.strike)
      .map(e => {
        const price = priceMap[e.ticker] ?? null;
        const breakEven = e.positionType === "short_call"
          ? e.strike! + e.avgPrice
          : e.strike! - e.avgPrice;
        return {
          ticker: e.ticker, positionType: e.positionType,
          strike: e.strike!, premium: e.avgPrice, breakEven, qty: e.qty,
          currentPrice: price,
          // for calls: positive = ITM (bad for short, good for long)
          moneyness: price ? ((price / e.strike!) - 1) * 100 : null,
          // Covered-call risk is the underlying shares called away: mkt price × 100 × contracts.
          collateral: e.positionType === "short_call" && price !== null ? price * 100 * e.qty : null,
        };
      })
      .sort((a, b) => (b.collateral ?? -1) - (a.collateral ?? -1));

    return {
      weightedBeta, dailyTheta, maxAssign, expiringSoon, avgDTE,
      incomeYield, netDelta, atRiskPositions: atRiskPositions.length,
      putPositions, callPositions, coveredCallCount: coveredCalls.size,
    };
  }, [betaData, filtered, priceMap, coveredCalls]);

  // ── Tabs ──────────────────────────────────────────────────────────────────────
  const tabs = ["All", ...portfolioNames];

  if (filtered.length === 0) return null;

  return (
    <div className="space-y-4">
      {/* Header + filter */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold tracking-tight">Portfolio Analysis</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Allocation · Sector · Risk · Delta · Income Yield
            {risk.coveredCallCount > 0 && ` · ${risk.coveredCallCount} covered call${risk.coveredCallCount > 1 ? "s" : ""} detected`}
          </p>
        </div>
        <div className="flex items-center gap-1 bg-secondary/40 p-1 rounded-lg">
          {tabs.map(t => (
            <button key={t} onClick={() => setActivePortfolio(t)}
              className={cn("px-3 py-1 text-xs font-medium rounded-md transition-colors",
                activePortfolio === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Row 1: Allocation + Sector + Tickers + Risk */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Capital Allocation</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <DonutChart data={allocationData} total={totalValue} label="Net Value" />
            <PieLegend data={allocationData} />
            {allocationMarginUsed > 0 && (
              <div className="mt-2 pt-2 border-t border-border/40 text-[10px] text-muted-foreground">
                Net of <span className="font-mono font-semibold text-yellow-400">{formatCurrency(allocationMarginUsed)}</span> margin used —
                Sector Exposure/Ticker Holdings show gross stock notional, so their totals run higher on this account.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center justify-between">
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
            <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-3 gap-x-2 text-[10px]">
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
              <div className="mt-2 pt-2 border-t border-border/40 flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground uppercase tracking-wide">Margin Used</span>
                <span className="font-mono font-semibold text-yellow-400">{formatCurrency(marginUsage.marginUsed)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Ticker Holdings</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <DonutChart data={tickerData.items} total={tickerData.total} label="Notional" />
            <PieLegend data={tickerData.items.slice(0, 6)} />
            {marginUsage.marginUsed > 0 && (
              <div className="mt-2 pt-2 border-t border-border/40 flex items-center justify-between text-[10px]">
                <span className="text-muted-foreground uppercase tracking-wide">Margin Used</span>
                <span className="font-mono font-semibold text-yellow-400">{formatCurrency(marginUsage.marginUsed)}</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Risk Metrics</CardTitle>
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

      {/* Row 1.2: Correlation matrix + parametric VaR/CVaR (95%, 1-day) */}
      {portfolioRisk && portfolioRisk.tickers.length > 1 && (
        <Card>
          <CardHeader className="px-4 pt-4 pb-0">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
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
                  <tr className="border-y border-border/40 bg-secondary/20">
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
      <Card>
        <CardHeader className="px-4 pt-4 pb-0">
          <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
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
              <tr className="border-t border-border/40">
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

      {/* Row 1.6: Top tickers by trade frequency, net realized P&L YTD — FILDI/IRA tabs */}
      <Card className="overflow-hidden">
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-center justify-between mb-1.5">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Top Tickers <span className="normal-case font-normal">— by frequency, net realized P&amp;L YTD</span>
            </CardTitle>
            <div className="flex items-center gap-1 bg-secondary/40 p-1 rounded-lg">
              {ACCOUNT_TABS.map(t => (
                <button key={t.key} onClick={() => setTickersTab(t.key)}
                  className={cn("px-2.5 py-0.5 text-[11px] font-medium rounded-md transition-colors",
                    tickersTab === t.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {topTickersByAccount[tickersTab].length === 0 ? (
            <div className="h-[60px] flex items-center justify-center text-xs text-muted-foreground">
              No trades closed this year yet
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-y border-border/40 bg-secondary/20">
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
                {topTickersByAccount[tickersTab].map((t, i) => (
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
      </Card>

      {/* Row 1.7: Cumulative summary per ticker — mirrors the YTD-export SUMMARY tables, FILDI/IRA tabs */}
      <Card className="overflow-hidden">
        <CardHeader className="px-4 pt-4 pb-0">
          <div className="flex items-center justify-between mb-1.5">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Cumulative Summary <span className="normal-case font-normal">— realized + unrealized + dividends, YTD</span>
            </CardTitle>
            <div className="flex items-center gap-1 bg-secondary/40 p-1 rounded-lg">
              {ACCOUNT_TABS.map(t => (
                <button key={t.key} onClick={() => setSummaryTab(t.key)}
                  className={cn("px-2.5 py-0.5 text-[11px] font-medium rounded-md transition-colors",
                    summaryTab === t.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {cumulativeSummaryByAccount[summaryTab].length === 0 ? (
            <div className="h-[60px] flex items-center justify-center text-xs text-muted-foreground">
              No activity for this account yet
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-y border-border/40 bg-secondary/20">
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
                  {cumulativeSummaryByAccount[summaryTab].map((r, i) => {
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
      </Card>

      {/* Row 2: Beta bar + DTE histogram */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Beta Contribution
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">
              weighted β · covered calls adjusted to δ×0.70
            </p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {topBetaData.length === 0 ? (
              <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={topBetaData} barSize={26} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="ticker" interval={0} tick={{ fontSize: 12, fontWeight: 600, fill: "hsl(var(--foreground))" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} width={36} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1 min-w-[140px]">
                        <div className="font-semibold flex items-center gap-1">
                          {d.ticker}
                          {d.covered && <span className="text-purple-400" title="Covered call">★</span>}
                        </div>
                        <div className="flex justify-between gap-4"><span className="text-muted-foreground">β Contribution</span><span className="font-mono font-semibold">{d.contribution.toFixed(3)}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-muted-foreground">Beta</span><span className="font-mono">{d.beta}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-muted-foreground">Weight</span><span className="font-mono">{d.weight}%</span></div>
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
              <div className="mt-3 pt-3 border-t border-border/40 flex flex-wrap gap-x-4 gap-y-1.5">
                {BETA_BAR_LEGEND.map(({ color, label }) => (
                  <div key={label} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    {label}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Options Expiration Timeline
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">contracts by DTE bucket</p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {dteData.length === 0 ? (
              <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">
                No open options with expiration dates
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={dteData} barSize={32} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <Tooltip content={(p) => {
                    const d = p.payload?.[0]?.payload;
                    if (!p.active || !d) return null;
                    return (
                      <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs space-y-1">
                        <div className="font-semibold">{d.label}</div>
                        <div className="flex justify-between gap-4"><span className="text-muted-foreground">Contracts</span><span className="font-mono">{d.qty}</span></div>
                        <div className="flex justify-between gap-4"><span className="text-muted-foreground">Premium</span><span className="font-mono text-green-400">{formatCurrency(d.premium)}</span></div>
                      </div>
                    );
                  }} cursor={{ fill: "hsl(var(--secondary))", opacity: 0.5 }} />
                  <Bar dataKey="qty" radius={[3, 3, 0, 0]}>
                    {dteData.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
            {dteData.length > 0 && (
              <div className="mt-3 border-t border-border/40 pt-3 space-y-1">
                {dteData.map(d => (
                  <div key={d.label} className="flex items-center justify-between text-[10px]">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2 h-2 rounded-full" style={{ background: d.color }} />
                      <span className="text-muted-foreground">{d.label}</span>
                    </div>
                    <div className="flex items-center gap-3 font-mono">
                      <span className="text-muted-foreground">{d.qty} ct</span>
                      <span className="text-green-400">+{formatCurrency(d.premium)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Option position health */}
      {(risk.putPositions.length > 0 || risk.callPositions.length > 0) && (
        <Card>
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <Layers className="w-3.5 h-3.5" /> Option Position Health
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">break-even, moneyness, and assignment/exercise risk per leg</p>
          </CardHeader>
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
                      <tr className="border-y border-border/40 bg-secondary/20">
                        {["Ticker", "Type", "Qty", "Strike", "Premium", "Break-Even", "Current", isPut ? "OTM %" : "ITM %", "Collateral", "Status"].map((h, hi) => (
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
        </Card>
      )}
    </div>
  );
}
