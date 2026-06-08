import { useMemo, useState } from "react";
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

const PALETTE = [
  "#38bdf8","#fb923c","#34d399","#a78bfa",
  "#f472b6","#fbbf24","#60a5fa","#f87171",
  "#4ade80","#e879f9","#94a3b8","#2dd4bf",
];

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
  return (
    <div className="bg-popover border border-border rounded-lg p-2.5 shadow-xl text-xs">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full" style={{ background: d.payload.color }} />
        <span className="text-muted-foreground">{d.name}</span>
      </div>
      <div className="font-mono font-semibold mt-0.5">{formatCurrency(d.value)}</div>
      <div className="text-muted-foreground">{d.payload.pct?.toFixed(1)}%</div>
    </div>
  );
}

// ── Donut chart ───────────────────────────────────────────────────────────────

function DonutChart({ data, total, label }: {
  data: { name: string; value: number; color: string; pct?: number }[];
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

function PieLegend({ data }: { data: { name: string; value: number; color: string; pct?: number }[] }) {
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

interface PortfolioAnalysisProps {
  entries: PortfolioEntry[];
  priceMap: Record<string, number | undefined>;
  stockDataMap: Record<string, StockMetrics>;
  portfolioNames: string[];
}

export function PortfolioAnalysis({ entries, priceMap, stockDataMap, portfolioNames }: PortfolioAnalysisProps) {
  const [activePortfolio, setActivePortfolio] = useState<string>("All");

  const filtered = useMemo(() =>
    (activePortfolio === "All"
      ? entries
      : entries.filter(e => entryPortfolio(e) === activePortfolio)
    ).filter(e => e.positionType !== "crypto"),
  [entries, activePortfolio]);

  // ── Covered call detection ──────────────────────────────────────────────────
  const coveredCalls = useMemo(() => detectCoveredCalls(filtered), [filtered]);

  // ── Allocation ──────────────────────────────────────────────────────────────
  const { allocationData, totalValue } = useMemo(() => {
    let collateral = 0, premium = 0, stockVal = 0;
    filtered.forEach(e => {
      if (e.positionType === "short_put") {
        collateral += cashCollateral(e); premium += premiumReceived(e);
      } else if (e.positionType === "short_call") {
        premium += premiumReceived(e);
      } else if (e.positionType === "stock") {
        stockVal += (priceMap[e.ticker] ?? e.avgPrice) * e.qty;
      }
    });
    const total = collateral + premium + stockVal;
    return {
      totalValue: total,
      allocationData: [
        { name: "Cash Collateral", value: collateral, color: "#fbbf24", pct: total > 0 ? (collateral/total)*100 : 0 },
        { name: "Premium Earned",  value: premium,    color: "#34d399", pct: total > 0 ? (premium/total)*100 : 0 },
        { name: "Stock Equity",    value: stockVal,   color: "#38bdf8", pct: total > 0 ? (stockVal/total)*100 : 0 },
      ].filter(d => d.value > 0),
    };
  }, [filtered, priceMap]);

  // ── Sector ──────────────────────────────────────────────────────────────────
  const sectorData = useMemo(() => {
    const bySector: Record<string, number> = {};
    filtered.forEach(e => {
      const sector = stockDataMap[e.ticker]?.sector || "Unknown";
      const value  = e.positionType === "stock"
        ? (priceMap[e.ticker] ?? e.avgPrice) * e.qty
        : cashCollateral(e) || e.avgPrice * 100 * e.qty;
      bySector[sector] = (bySector[sector] ?? 0) + value;
    });
    const total = Object.values(bySector).reduce((s, v) => s + v, 0);
    return Object.entries(bySector)
      .map(([name, value], i) => ({ name, value, color: PALETTE[i % PALETTE.length], pct: total > 0 ? (value/total)*100 : 0 }))
      .sort((a, b) => b.value - a.value);
  }, [filtered, priceMap, stockDataMap]);

  // ── Beta (covered-call adjusted) ────────────────────────────────────────────
  const betaData = useMemo(() => {
    const byTicker: Record<string, { value: number; beta: number }> = {};
    filtered.forEach(e => {
      const beta  = stockDataMap[e.ticker]?.beta ?? 1;
      const value = e.positionType === "stock"
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

    // At-risk short puts: current price within 8% above strike (in danger zone)
    const atRiskPositions = filtered.filter(e => {
      if (e.positionType !== "short_put" || !e.strike) return false;
      const price = priceMap[e.ticker];
      return price !== undefined && price < e.strike * 1.08;
    });

    // Break-even per short put: strike - (total premium per share)
    const putBreakEvens = filtered
      .filter(e => e.positionType === "short_put" && e.strike)
      .map(e => ({
        ticker: e.ticker,
        strike: e.strike!,
        premium: e.avgPrice, // per contract premium
        breakEven: e.strike! - e.avgPrice,
        currentPrice: priceMap[e.ticker] ?? null,
        moneyness: priceMap[e.ticker] ? ((priceMap[e.ticker]! / e.strike!) - 1) * 100 : null,
      }));

    return {
      weightedBeta, dailyTheta, maxAssign, expiringSoon, avgDTE,
      incomeYield, netDelta, atRiskPositions: atRiskPositions.length,
      putBreakEvens, coveredCallCount: coveredCalls.size,
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

      {/* Row 1: Allocation + Sector + Risk */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Capital Allocation</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <DonutChart data={allocationData} total={totalValue} label="Total" />
            <PieLegend data={allocationData} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Sector Exposure</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <DonutChart data={sectorData} total={totalValue} label="Notional" />
            <PieLegend data={sectorData.slice(0, 6)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-4 pt-4 pb-0">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Risk Metrics</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-2 mt-2">
            <RiskStat label="Portfolio Beta (adj.)"
              value={risk.weightedBeta.toFixed(2)}
              sub={`weighted · ${risk.coveredCallCount > 0 ? `${risk.coveredCallCount} covered (δ×0.70)` : "no covered calls"}`}
              icon={<Activity className="w-4 h-4" />}
              color={risk.weightedBeta > 1.5 ? "text-red-400" : risk.weightedBeta > 1.1 ? "text-yellow-400" : "text-green-400"}
            />
            <RiskStat label="Net Portfolio Delta"
              value={risk.netDelta > 0 ? `+${risk.netDelta.toFixed(0)}` : risk.netDelta.toFixed(0)}
              sub="approx. (stock=1.0 · put=−0.25 · call=+0.30)"
              icon={<BarChart2 className="w-4 h-4" />}
              color={Math.abs(risk.netDelta) > 5000 ? "text-orange-400" : "text-foreground"}
            />
            <RiskStat label="Est. Daily Theta"
              value={`+${formatCurrency(risk.dailyTheta)}`}
              sub={`avg DTE ${risk.avgDTE.toFixed(0)}d · time decay in your favor`}
              icon={<Zap className="w-4 h-4" />}
              color="text-green-400"
            />
            <RiskStat label="Annualized Income Yield"
              value={`${risk.incomeYield.toFixed(1)}%`}
              sub="premium / collateral × (365 / avgDTE)"
              icon={<Percent className="w-4 h-4" />}
              color={risk.incomeYield >= 20 ? "text-green-400" : risk.incomeYield >= 10 ? "text-yellow-400" : "text-muted-foreground"}
            />
            <RiskStat label="Max Assignment Risk"
              value={formatCurrency(risk.maxAssign)}
              sub="total collateral for all short puts"
              icon={<Shield className="w-4 h-4" />}
              color="text-yellow-400"
            />
            {risk.atRiskPositions > 0 && (
              <RiskStat label="At-Risk Positions"
                value={String(risk.atRiskPositions)}
                sub="short puts within 8% of strike — monitor closely"
                icon={<AlertTriangle className="w-4 h-4" />}
                color="text-red-400"
              />
            )}
            {risk.expiringSoon > 0 && (
              <RiskStat label="Expiring ≤ 7 Days"
                value={String(risk.expiringSoon)}
                sub="legs to roll or let expire"
                icon={<TrendingDown className="w-4 h-4" />}
                color="text-orange-400"
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Beta bar + DTE histogram */}
      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Beta Contribution by Ticker
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">
              weighted β · covered calls adjusted to δ×0.70
            </p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            {betaData.length === 0 ? (
              <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">No data</div>
            ) : (
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={betaData} barSize={22} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} opacity={0.4} />
                  <XAxis dataKey="ticker" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} />
                  <Tooltip content={(p) => (
                    <ChartTooltip active={p.active}
                      payload={p.payload?.map(d => ({ ...d, fill: "#38bdf8", name: "β contribution" }))}
                      format={v => v.toFixed(3)} />
                  )} cursor={{ fill: "hsl(var(--secondary))", opacity: 0.5 }} />
                  <Bar dataKey="contribution" radius={[3, 3, 0, 0]}>
                    {betaData.map((d, i) => (
                      <Cell key={i}
                        fill={d.covered ? "#a78bfa" : d.contribution > 0.4 ? "#f97316" : d.contribution > 0.2 ? "#fbbf24" : "#34d399"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
            {betaData.length > 0 && (
              <div className="mt-3 border-t border-border/40 pt-3 grid grid-cols-3 gap-x-4 gap-y-1">
                {betaData.map(d => (
                  <div key={d.ticker} className="flex items-center justify-between text-[10px]">
                    <span className="font-mono font-bold">
                      {d.ticker}
                      {d.covered && <span className="ml-0.5 text-purple-400" title="Covered call">★</span>}
                    </span>
                    <span className="text-muted-foreground">β{d.beta} · {d.weight}%</span>
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

      {/* Row 3: Put position health table */}
      {risk.putBreakEvens.length > 0 && (
        <Card>
          <CardHeader className="px-4 pt-4 pb-2">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
              <Layers className="w-3.5 h-3.5" /> Short Put Position Health
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">break-even, moneyness, and assignment risk per position</p>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/40">
                    {["Ticker", "Strike", "Premium", "Break-Even", "Current", "OTM %", "Status"].map(h => (
                      <th key={h} className="text-left py-2 px-3 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider last:text-right">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {risk.putBreakEvens.map((p, i) => {
                    const otm = p.moneyness;
                    const safe = otm !== null && otm >= 8;
                    const warn = otm !== null && otm >= 0 && otm < 8;
                    const atRisk = otm !== null && otm < 0;
                    return (
                      <tr key={i} className="border-b border-border/20 hover:bg-secondary/10">
                        <td className="py-2 px-3 font-mono font-bold">{p.ticker}</td>
                        <td className="py-2 px-3 font-mono">${p.strike.toFixed(2)}</td>
                        <td className="py-2 px-3 font-mono text-green-400">+${p.premium.toFixed(2)}</td>
                        <td className="py-2 px-3 font-mono">${p.breakEven.toFixed(2)}</td>
                        <td className="py-2 px-3 font-mono">
                          {p.currentPrice !== null ? `$${p.currentPrice.toFixed(2)}` : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className={cn("py-2 px-3 font-mono font-semibold",
                          safe ? "text-green-400" : warn ? "text-yellow-400" : atRisk ? "text-red-400" : "text-muted-foreground")}>
                          {otm !== null ? `${otm > 0 ? "+" : ""}${otm.toFixed(1)}%` : "—"}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold",
                            safe    ? "bg-green-500/15 text-green-400" :
                            warn    ? "bg-yellow-500/15 text-yellow-400" :
                            atRisk  ? "bg-red-500/15 text-red-400" :
                            "bg-secondary text-muted-foreground"
                          )}>
                            {safe ? "Safe" : warn ? "Watch" : atRisk ? "At Risk" : "—"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[10px] text-muted-foreground/50 mt-2">
              OTM% = (current / strike − 1) × 100 · At Risk: within 8% of strike · Break-Even = strike − premium
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
