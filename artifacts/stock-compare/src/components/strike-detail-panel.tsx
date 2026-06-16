import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Brush,
} from "recharts";
import { cn } from "@/lib/utils";
import type { OptionScoreResult } from "@/lib/option-scorer";

// ── Types mirrored from options-scanner (avoid circular import) ───────────────
interface OptionRow {
  strike: number;
  bid: number;
  ask: number;
  lastPrice: number;
  iv: number;
  volume: number | null;
  openInterest: number | null;
  incomePct: number;
  meetsGate: boolean;
  delta: number | null;
  spreadPct: number | null;
}

interface OptionsChainResult {
  ticker: string;
  expiry: string;
  daysToExpiry: number;
  exactDte: number;
  spot: number;
  tier: number;
  puts: OptionRow[];
  fetchedAt: number;
}

// ── Black-Scholes full Greeks ─────────────────────────────────────────────────

function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function normCDF(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422820 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815310 + t * (-0.3565638140 + t * (1.7814779370 + t * (-1.8212559780 + t * 1.3302744290))));
  return x > 0 ? 1 - p : p;
}

function bsGreeksAndPrice(S: number, K: number, T: number, r: number, sigma: number) {
  if (T <= 0 || S <= 0 || sigma <= 0) {
    return { price: Math.max(0, K - S), delta: -1, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = normPDF(d1);
  const price = Math.max(0, K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1));
  const delta = normCDF(d1) - 1;                           // put delta (negative)
  const gamma = nd1 / (S * sigma * sqrtT);
  const thetaAnnual = (-S * nd1 * sigma / (2 * sqrtT)) + r * K * Math.exp(-r * T) * normCDF(-d2);
  const theta = thetaAnnual / 365;                         // per calendar day
  const vega  = S * nd1 * sqrtT / 100;                    // per 1% change in IV
  return { price, delta, gamma, theta, vega };
}

// ── Score bullets ─────────────────────────────────────────────────────────────

function scoreBullets(
  result: OptionScoreResult,
  put: OptionRow,
  chain: OptionsChainResult,
): Array<{ text: string; sentiment: "good" | "warn" | "bad" | "neutral" }> {
  const out: Array<{ text: string; sentiment: "good" | "warn" | "bad" | "neutral" }> = [];
  const cs = result.componentScores;
  const otmPct = ((chain.spot - put.strike) / chain.spot * 100);

  const inc = cs.income?.score;
  if (inc != null) {
    const s = inc >= 0.8 ? "good" : inc >= 0.5 ? "neutral" : "warn";
    const lbl = inc >= 0.8 ? "exceeds weekly target" : inc >= 0.5 ? "meets target" : "below target";
    out.push({ text: `Income ${result.weeklyIncome.toFixed(2)}%/wk — ${lbl}`, sentiment: s });
  }

  const buf = cs.buffer?.score;
  if (buf != null) {
    const s = buf >= 0.75 ? "good" : buf >= 0.45 ? "neutral" : "warn";
    const absDelta = put.delta != null ? Math.abs(put.delta) : null;
    const lbl = buf >= 0.75 ? "comfortable cushion" : buf >= 0.45 ? "moderate buffer" : "tight — elevated assignment risk";
    out.push({ text: `${otmPct.toFixed(1)}% OTM${absDelta != null ? ` · Δ ${absDelta.toFixed(2)}` : ""} — ${lbl}`, sentiment: s });
  }

  const ivRel = cs.ivRelative?.score;
  if (ivRel != null) {
    const s = ivRel >= 0.7 ? "good" : ivRel >= 0.4 ? "neutral" : "warn";
    const lbl = ivRel >= 0.7 ? "elevated IV rank — sell premium" : ivRel >= 0.4 ? "neutral IV environment" : "low IV rank — premium thin";
    out.push({ text: `IV environment: ${lbl}`, sentiment: s });
  }

  const ivAbs = cs.ivAbsolute?.score;
  if (ivAbs != null) {
    const s = ivAbs >= 0.7 ? "good" : ivAbs >= 0.4 ? "neutral" : "warn";
    const lbl = ivAbs >= 0.7 ? "high vs. peers" : ivAbs >= 0.4 ? "avg vs. peers" : "low vs. peers";
    out.push({ text: `Option IV ${(put.iv * 100).toFixed(0)}% — ${lbl}`, sentiment: s });
  }

  const squal = cs.stockQuality?.score;
  if (squal != null) {
    const s = squal >= 0.7 ? "good" : squal >= 0.4 ? "neutral" : "warn";
    const lbl = squal >= 0.7 ? "strong tech + fundamental base" : squal >= 0.4 ? "moderate quality" : "weak quality — higher risk";
    out.push({ text: `Stock quality: ${lbl}`, sentiment: s });
  }

  const sup = cs.support?.score;
  if (sup != null) {
    const s = sup >= 0.7 ? "good" : sup >= 0.4 ? "neutral" : "warn";
    const lbl = sup >= 0.7 ? "above key support levels" : sup >= 0.4 ? "near support — monitor" : "below recent support";
    out.push({ text: `Support: strike ${lbl}`, sentiment: s });
  }

  const dte = cs.dte?.score;
  if (dte != null) {
    const s = dte >= 0.75 ? "good" : dte >= 0.45 ? "neutral" : "warn";
    const lbl = dte >= 0.75 ? "optimal theta zone" : dte >= 0.45 ? "acceptable" : "suboptimal timing";
    out.push({ text: `${chain.daysToExpiry} DTE — ${lbl}`, sentiment: s });
  }

  if (result.liquidity.warn && result.liquidity.reason) {
    out.push({ text: `Liquidity: ${result.liquidity.reason}`, sentiment: "warn" });
  }
  if (result.dataQualityFlags.length > 0) {
    out.push({ text: `Data gaps: ${result.dataQualityFlags.join("; ")}`, sentiment: "neutral" });
  }

  return out;
}

// ── Greeks table ──────────────────────────────────────────────────────────────

const R = 0.05;

function GreeksTable({ put, chain }: { put: OptionRow; chain: OptionsChainResult }) {
  const T = Math.max(chain.exactDte, 0.5) / 365;
  const g = bsGreeksAndPrice(chain.spot, put.strike, T, R, put.iv);

  const mid = put.bid > 0 && put.ask > 0 ? (put.bid + put.ask) / 2 : null;
  const absDelta = Math.abs(g.delta);
  const thetaDay = g.theta * 100;
  const vegaPct  = g.vega  * 100;

  const rows: Array<{ label: string; value: string; color?: string; sub?: string }> = [
    {
      label: "Δ Delta",
      value: g.delta.toFixed(3),
      color: absDelta < 0.15 ? "text-green-400" : absDelta < 0.25 ? "text-white" : "text-orange-400",
      sub: `${((1 - absDelta) * 100).toFixed(0)}% POP`,
    },
    {
      label: "γ Gamma",
      value: g.gamma.toFixed(4),
      color: g.gamma < 0.05 ? "text-white" : "text-orange-400",
      sub: g.gamma < 0.05 ? "stable" : "elevated",
    },
    {
      label: "θ Theta",
      value: `$${thetaDay.toFixed(2)}/d`,
      color: "text-green-400",
      sub: "earned daily",
    },
    {
      label: "ν Vega",
      value: `$${vegaPct.toFixed(2)}/1%`,
      color: "text-purple-400",
      sub: "per IV point",
    },
    {
      label: "IV",
      value: `${(put.iv * 100).toFixed(0)}%`,
      color: "text-amber-400",
      sub: "implied vol",
    },
    {
      label: "Bid / Ask",
      value: `$${put.bid.toFixed(2)} / $${put.ask.toFixed(2)}`,
      color: "text-white",
      sub: mid != null ? `mid $${mid.toFixed(2)}` : undefined,
    },
    {
      label: "Spread",
      value: put.spreadPct != null ? `${(put.spreadPct * 100).toFixed(0)}%` : "—",
      color: put.spreadPct == null ? "text-slate-400" :
             put.spreadPct < 0.20 ? "text-green-400" :
             put.spreadPct < 0.40 ? "text-yellow-400" : "text-red-400",
      sub: put.spreadPct != null
        ? put.spreadPct < 0.20 ? "tight" : put.spreadPct < 0.40 ? "moderate" : "wide ⚠"
        : undefined,
    },
    {
      label: "Vol / OI",
      value: `${put.volume != null ? put.volume.toLocaleString() : "—"} / ${put.openInterest != null ? put.openInterest.toLocaleString() : "—"}`,
      color: "text-white",
      sub: put.openInterest != null && put.openInterest >= 100 ? "liquid" : "thin",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-0">
      {rows.map(({ label, value, color, sub }) => (
        <div key={label} className="flex items-center justify-between py-1.5 border-b border-slate-800/40 last:border-0">
          <span className="text-xs text-slate-300 font-medium shrink-0 mr-1">{label}</span>
          <div className="text-right min-w-0">
            <span className={cn("text-sm font-mono font-semibold", color ?? "text-white")}>{value}</span>
            {sub && <span className="block text-[10px] text-slate-400 leading-tight">{sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Payoff chart ──────────────────────────────────────────────────────────────

const PRICE_STEPS = 80;

function generateCurve(
  K: number, premium: number, sigma: number, T_years: number, priceRange: number[],
): Array<{ price: number; pnl: number }> {
  return priceRange.map(S => ({
    price: S,
    pnl: Math.round((premium - bsGreeksAndPrice(S, K, T_years, R, sigma).price) * 100 * 100) / 100,
  }));
}

function PayoffChart({ put, chain }: { put: OptionRow; chain: OptionsChainResult }) {
  const { strike: K, bid: premium, iv: sigma } = put;
  const { spot, exactDte } = chain;

  const [daysElapsed, setDaysElapsed] = useState(0);
  const [simPrice, setSimPrice] = useState<number>(spot);

  const priceRange = useMemo(() =>
    Array.from({ length: PRICE_STEPS }, (_, i) => spot * (0.65 + (i / (PRICE_STEPS - 1)) * 0.70)),
    [spot],
  );

  const chartData = useMemo(() => {
    const T_entry     = Math.max(exactDte, 0.5) / 365;
    const T_remaining = Math.max(exactDte - daysElapsed, 0) / 365;
    const entry    = generateCurve(K, premium, sigma, T_entry, priceRange);
    const selected = generateCurve(K, premium, sigma, T_remaining, priceRange);
    const expiry   = priceRange.map(S => ({
      price: S,
      pnl: Math.round((premium - Math.max(0, K - S)) * 100 * 100) / 100,
    }));
    return priceRange.map((price, i) => ({
      price,
      "At Entry":  entry[i].pnl,
      "Selected":  selected[i].pnl,
      "At Expiry": expiry[i].pnl,
    }));
  }, [K, premium, sigma, spot, exactDte, priceRange, daysElapsed]);

  const breakEven = K - premium;
  const maxProfit = Math.round(premium * 100 * 100) / 100;
  const maxLoss   = Math.round((K - premium) * 100 * 100) / 100;
  const daysRemaining = Math.max(0, Math.round(exactDte - daysElapsed));

  const T_sim = Math.max(exactDte - daysElapsed, 0) / 365;
  const pnlAtSim = T_sim <= 0
    ? Math.round((premium - Math.max(0, K - simPrice)) * 100 * 100) / 100
    : Math.round((premium - bsGreeksAndPrice(simPrice, K, T_sim, R, sigma).price) * 100 * 100) / 100;

  return (
    <div className="space-y-3">
      {/* Summary stats */}
      <div className="flex items-center gap-6 text-sm">
        <span className="text-white">Max profit: <span className="text-green-400 font-mono font-bold">${maxProfit.toFixed(2)}</span></span>
        <span className="text-white">Break-even: <span className="text-amber-400 font-mono font-bold">${breakEven.toFixed(2)}</span></span>
        <span className="text-white">Max loss: <span className="text-red-400 font-mono font-bold">-${maxLoss.toFixed(2)}</span></span>
        <span className="text-slate-300 ml-auto font-mono text-xs">T−{daysRemaining}d</span>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={210}>
        <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 4, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis
            dataKey="price" type="number" domain={["dataMin", "dataMax"]}
            tickFormatter={v => `$${Number(v).toFixed(0)}`}
            tick={{ fontSize: 10, fill: "#e2e8f0" }} tickCount={8}
          />
          <YAxis
            tickFormatter={v => `$${Number(v).toFixed(0)}`}
            tick={{ fontSize: 10, fill: "#e2e8f0" }} width={48}
            domain={["auto", "auto"]}
          />
          <Tooltip
            formatter={(value: number, name: string) => [`$${value.toFixed(2)}`, name]}
            labelFormatter={v => `Stock @ $${Number(v).toFixed(2)}`}
            contentStyle={{ background: "#0c0f1a", border: "1px solid #1e293b", fontSize: 11, borderRadius: 6 }}
            itemStyle={{ color: "#e2e8f0" }}
          />
          <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
          <ReferenceLine x={spot} stroke="#475569" strokeDasharray="4 2"
            label={{ value: "Spot", position: "top", fontSize: 9, fill: "#e2e8f0" }} />
          <ReferenceLine x={breakEven} stroke="#f59e0b" strokeDasharray="4 2"
            label={{ value: "BE", position: "top", fontSize: 9, fill: "#f59e0b" }} />
          {Math.abs(simPrice - spot) > 0.01 && (
            <ReferenceLine x={simPrice} stroke="#a78bfa" strokeDasharray="3 2"
              label={{ value: "Sim", position: "top", fontSize: 9, fill: "#a78bfa" }} />
          )}
          <Line dataKey="At Entry"  stroke="#22c55e" dot={false} strokeWidth={1.5} strokeDasharray="6 3" />
          <Line dataKey="Selected"  stroke="#60a5fa" dot={false} strokeWidth={2.5} activeDot={{ r: 4 }} />
          <Line dataKey="At Expiry" stroke="#f87171" dot={false} strokeWidth={1.5} strokeDasharray="6 3" />
          <Brush
            dataKey="price" height={18} stroke="#334155"
            fill="#0f172a" travellerWidth={8}
            tickFormatter={v => `$${Number(v).toFixed(0)}`}
          />
        </LineChart>
      </ResponsiveContainer>

      {/* Time slider */}
      <div className="space-y-1.5 px-1">
        <div className="flex justify-between text-xs">
          <span className="text-blue-400 font-semibold">Today</span>
          <span className="text-slate-300 font-mono">
            {daysElapsed === 0 ? "at entry" : daysElapsed >= exactDte ? "at expiry" : `+${Math.round(daysElapsed)}d elapsed`}
          </span>
          <span className="text-red-400 font-semibold">Expiry</span>
        </div>
        <input type="range" min={0} max={Math.ceil(exactDte)} step={0.5} value={daysElapsed}
          onChange={e => setDaysElapsed(Number(e.target.value))}
          className="w-full h-2 accent-blue-400 cursor-pointer" />
      </div>

      {/* Price sim slider */}
      <div className="space-y-1.5 px-1 pb-1">
        <div className="flex justify-between text-xs">
          <span className="text-purple-400 font-semibold">
            Sim price: <span className="font-mono text-purple-200">${simPrice.toFixed(2)}</span>
          </span>
          <span className={cn("font-mono font-bold text-sm", pnlAtSim >= 0 ? "text-green-400" : "text-red-400")}>
            P&L: {pnlAtSim >= 0 ? "+" : ""}${pnlAtSim.toFixed(2)} / contract
          </span>
        </div>
        <input type="range"
          min={Math.round(spot * 0.65 * 100) / 100}
          max={Math.round(spot * 1.35 * 100) / 100}
          step={0.01} value={simPrice}
          onChange={e => setSimPrice(Number(e.target.value))}
          className="w-full h-2 accent-purple-400 cursor-pointer" />
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface StrikeDetailPanelProps {
  put: OptionRow;
  chain: OptionsChainResult;
  scoreResult: OptionScoreResult | null;
  isBest: boolean;
}

const SENTIMENT_ICON: Record<string, string> = {
  good: "▲",
  warn: "▼",
  bad:  "✕",
  neutral: "·",
};
const SENTIMENT_COLOR: Record<string, string> = {
  good:    "text-green-400",
  warn:    "text-amber-400",
  bad:     "text-red-400",
  neutral: "text-slate-500",
};

export function StrikeDetailPanel({ put, chain, scoreResult, isBest }: StrikeDetailPanelProps) {
  const bullets = useMemo(
    () => scoreResult ? scoreBullets(scoreResult, put, chain) : [],
    [scoreResult, put, chain],
  );

  return (
    <div className="bg-slate-950/80 border-t border-slate-800/60">
      {/* Top section: bullets + greeks table side by side */}
      <div className="grid grid-cols-[1fr_340px] divide-x divide-slate-800/60">
        {/* Left: bullet reasoning */}
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center gap-3">
            <p className={cn(
              "text-xs font-bold tracking-widest uppercase",
              isBest ? "text-green-400" : "text-white",
            )}>
              {isBest ? "★ Why this strike is best" : "Strike Analysis"}
            </p>
            {scoreResult && (
              <span className={cn(
                "font-mono text-sm font-bold",
                isBest ? "text-green-300" : "text-white",
              )}>
                {scoreResult.optionScore.toFixed(1)}<span className="text-slate-400 text-xs font-normal">/100</span>
                {scoreResult.dataQuality < 0.8 && (
                  <span className="text-amber-400 text-xs font-normal ml-2">
                    {(scoreResult.dataQuality * 100).toFixed(0)}% data
                  </span>
                )}
              </span>
            )}
          </div>
          {bullets.length > 0 ? (
            <ul className="space-y-2.5">
              {bullets.map(({ text, sentiment }, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className={cn("text-xs mt-0.5 shrink-0 font-bold", SENTIMENT_COLOR[sentiment])}>
                    {SENTIMENT_ICON[sentiment]}
                  </span>
                  <span className="text-sm text-white leading-snug">{text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400 italic">No scorer data — technicals not yet loaded.</p>
          )}
        </div>

        {/* Right: Greeks table */}
        <div className="px-4 py-4">
          <p className="text-[10px] font-bold tracking-widest uppercase text-white mb-2">Greeks & Liquidity</p>
          <GreeksTable put={put} chain={chain} />
        </div>
      </div>

      {/* Bottom: P&L chart */}
      <div className="border-t border-slate-800/60 px-5 py-4 space-y-3">
        <p className="text-xs font-bold tracking-widest uppercase text-white">
          P&L Simulation — Short Put · 1 contract
        </p>
        <PayoffChart put={put} chain={chain} />
      </div>
    </div>
  );
}
