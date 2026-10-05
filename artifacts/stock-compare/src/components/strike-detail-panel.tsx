import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, Brush,
} from "recharts";
import { cn } from "@/lib/utils";
import type { OptionScoreResult } from "@/lib/option-scorer";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// ── Types mirrored from options-scanner (avoid circular import) ───────────────
export interface OptionRow {
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

export interface OptionsChainResult {
  ticker: string;
  expiry: string;
  daysToExpiry: number;
  exactDte: number;
  settlementDte: number;
  spot: number;
  tier: number;
  puts: OptionRow[];
  calls: OptionRow[];
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

function bsGreeksAndPrice(S: number, K: number, T: number, r: number, sigma: number, isCall: boolean = false) {
  if (T <= 0 || S <= 0 || sigma <= 0) {
    return isCall
      ? { price: Math.max(0, S - K), delta: 1, gamma: 0, theta: 0, vega: 0 }
      : { price: Math.max(0, K - S), delta: -1, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sqrtT * sigma;
  const nd1 = normPDF(d1);
  const gamma = nd1 / (S * sigma * sqrtT);
  const vega  = S * nd1 * sqrtT / 100;                    // per 1% change in IV

  if (isCall) {
    const price = Math.max(0, S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2));
    const delta = normCDF(d1);                             // call delta (positive)
    const thetaAnnual = (-S * nd1 * sigma / (2 * sqrtT)) - r * K * Math.exp(-r * T) * normCDF(d2);
    return { price, delta, gamma, theta: thetaAnnual / 365, vega };
  }
  const price = Math.max(0, K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1));
  const delta = normCDF(d1) - 1;                           // put delta (negative)
  const thetaAnnual = (-S * nd1 * sigma / (2 * sqrtT)) + r * K * Math.exp(-r * T) * normCDF(-d2);
  return { price, delta, gamma, theta: thetaAnnual / 365, vega };
}

// ── Score bullets ─────────────────────────────────────────────────────────────

const COMPONENT_LABEL: Record<string, string> = {
  income: "income",
  buffer: "delta/buffer safety",
  ivRelative: "IV rank",
  ivAbsolute: "IV vs watchlist",
  stockQuality: "stock quality",
  support: "support proximity",
  dte: "days-to-expiry preference",
};

function scoreBullets(
  result: OptionScoreResult,
  put: OptionRow,
  chain: OptionsChainResult,
  runnerUp?: { chain: OptionsChainResult; put: OptionRow; result: OptionScoreResult } | null,
  isCall: boolean = false,
): Array<{ text: string; sentiment: "good" | "warn" | "bad" | "neutral" }> {
  const out: Array<{ text: string; sentiment: "good" | "warn" | "bad" | "neutral" }> = [];
  const cs = result.componentScores;
  const otmPct = isCall
    ? ((put.strike - chain.spot) / chain.spot * 100)
    : ((chain.spot - put.strike) / chain.spot * 100);

  const inc = cs.income?.score;
  if (inc != null) {
    const s = inc >= 0.8 ? "good" : inc >= 0.5 ? "neutral" : "warn";
    const lbl = inc >= 0.8 ? "exceeds weekly target (~1%/wk)" : inc >= 0.5 ? "meets target" : "below target";
    out.push({ text: `Income ${result.weeklyIncome.toFixed(2)}%/wk — ${lbl}`, sentiment: s });
  }

  // Comparison bullet — always shown when there's a runner-up, regardless of score gap
  // (a large gap is exactly when the "why this one" explanation matters most, not least).
  // Names the component(s) that actually drove the gap instead of restating ticker-level
  // facts that are identical across every strike/expiry on this ticker.
  if (runnerUp) {
    const ruExpiry = runnerUp.chain.daysToExpiry;
    const ruIncome = runnerUp.result.weeklyIncome;
    const sameStrike = runnerUp.put.strike === put.strike;

    const drivers = Object.keys(result.componentScores)
      .map((key) => {
        const a = result.componentScores[key];
        const b = runnerUp.result.componentScores[key];
        if (a.score == null || b.score == null) return null;
        return { key, delta: a.score * a.weight - b.score * b.weight };
      })
      .filter((d): d is { key: string; delta: number } => d !== null)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

    const label = drivers[0] ? COMPONENT_LABEL[drivers[0].key] ?? drivers[0].key : null;
    const scoreGap = result.optionScore - runnerUp.result.optionScore;

    if (sameStrike && ruIncome > result.weeklyIncome) {
      out.push({
        text: `Beats ${ruExpiry}d $${runnerUp.put.strike} (${ruIncome.toFixed(2)}%/wk, score ${runnerUp.result.optionScore.toFixed(1)} vs ${result.optionScore.toFixed(1)}) — higher yield there scored as excess assignment risk on ${label ?? "component"}, not extra credit`,
        sentiment: "neutral",
      });
    } else {
      out.push({
        text: `Beats ${ruExpiry}d $${runnerUp.put.strike} (${ruIncome.toFixed(2)}%/wk, score ${runnerUp.result.optionScore.toFixed(1)} vs ${result.optionScore.toFixed(1)}) — driven mainly by ${label ?? "overall score"}${Math.abs(scoreGap) < 5 ? " (close call)" : ""}`,
        sentiment: "neutral",
      });
    }
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
    out.push({ text: `(ticker-level) IV environment: ${lbl}`, sentiment: s });
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
    out.push({ text: `(ticker-level) Stock quality: ${lbl}`, sentiment: s });
  }

  const sup = cs.support?.score;
  if (sup != null) {
    const s = sup >= 0.7 ? "good" : sup >= 0.4 ? "neutral" : "warn";
    const lbl = isCall
      ? (sup >= 0.7 ? "above key resistance levels" : sup >= 0.4 ? "near resistance — monitor" : "below recent resistance")
      : (sup >= 0.7 ? "above key support levels" : sup >= 0.4 ? "near support — monitor" : "below recent support");
    out.push({ text: `${isCall ? "Resistance" : "Support"}: strike ${lbl}`, sentiment: s });
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

function GreeksTable({ put, chain, isCall = false }: { put: OptionRow; chain: OptionsChainResult; isCall?: boolean }) {
  const T = Math.max(chain.exactDte, 0.5) / 365;
  const g = bsGreeksAndPrice(chain.spot, put.strike, T, R, put.iv, isCall);

  const mid = put.bid > 0 && put.ask > 0 ? (put.bid + put.ask) / 2 : null;
  const absDelta = Math.abs(g.delta);
  const thetaDay = g.theta * 100;
  const vegaPct  = g.vega  * 100;

  type Item = { label: string; value: string; color?: string; sub?: string };

  const delta: Item = {
    label: "Delta",
    value: g.delta.toFixed(3),
    color: absDelta < 0.15 ? "text-green-400" : absDelta < 0.25 ? "text-white" : "text-orange-400",
    sub: `${((1 - absDelta) * 100).toFixed(0)}% POP`,
  };
  const gamma: Item = {
    label: "Gamma",
    value: g.gamma.toFixed(4),
    color: g.gamma < 0.05 ? "text-white" : "text-orange-400",
    sub: g.gamma < 0.05 ? "stable" : "elevated",
  };
  const theta: Item = { label: "Theta", value: `$${thetaDay.toFixed(2)}/d`, color: "text-green-400" };
  const vega: Item  = { label: "Vega", value: `$${vegaPct.toFixed(2)}/1%`, color: "text-purple-400" };
  const iv: Item    = { label: "IV", value: `${(put.iv * 100).toFixed(0)}%`, color: "text-amber-400" };
  const bidAsk: Item = {
    label: "Bid/Ask",
    value: `$${put.bid.toFixed(2)}/$${put.ask.toFixed(2)}`,
    color: "text-white",
    sub: mid != null ? `mid $${mid.toFixed(2)}` : undefined,
  };
  const spread: Item = {
    label: "Spread",
    value: put.spreadPct != null ? `${(put.spreadPct * 100).toFixed(0)}%` : "—",
    color: put.spreadPct == null ? "text-white" :
           put.spreadPct < 0.20 ? "text-green-400" :
           put.spreadPct < 0.40 ? "text-yellow-400" : "text-red-400",
    sub: put.spreadPct != null
      ? put.spreadPct < 0.20 ? "tight" : put.spreadPct < 0.40 ? "moderate" : "wide ⚠"
      : undefined,
  };
  const volOi: Item = {
    label: "Vol/OI",
    value: `${put.volume != null ? put.volume.toLocaleString() : "—"} / ${put.openInterest != null ? put.openInterest.toLocaleString() : "—"}`,
    color: "text-white",
    sub: put.openInterest != null && put.openInterest >= 100 ? "liquid" : "thin",
  };

  const lines: Item[][] = [[delta, gamma], [theta, vega, iv], [bidAsk], [spread, volOi]];

  return (
    <div className="space-y-0.5 min-w-0">
      {lines.map((items, li) => (
        <div key={li} className="flex items-center gap-x-3 text-xs">
          {items.map(({ label, value, color, sub }) => (
            <span key={label} className="whitespace-nowrap">
              <span className="text-white">{label} </span>
              <span className={cn("font-mono font-semibold", color ?? "text-white")}>{value}</span>
              {sub && <span className="text-white"> ({sub})</span>}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Payoff chart ──────────────────────────────────────────────────────────────

const PRICE_STEPS = 80;

function generateCurve(
  K: number, premium: number, sigma: number, T_years: number, priceRange: number[], isCall: boolean = false,
): Array<{ price: number; pnl: number }> {
  return priceRange.map(S => ({
    price: S,
    pnl: Math.round((premium - bsGreeksAndPrice(S, K, T_years, R, sigma, isCall).price) * 100 * 100) / 100,
  }));
}

function PayoffChart({ put, chain, isCall = false }: { put: OptionRow; chain: OptionsChainResult; isCall?: boolean }) {
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
    const entry    = generateCurve(K, premium, sigma, T_entry, priceRange, isCall);
    const selected = generateCurve(K, premium, sigma, T_remaining, priceRange, isCall);
    const expiry   = priceRange.map(S => ({
      price: S,
      pnl: Math.round((premium - Math.max(0, isCall ? S - K : K - S)) * 100 * 100) / 100,
    }));
    return priceRange.map((price, i) => ({
      price,
      "At Entry":  entry[i].pnl,
      "Selected":  selected[i].pnl,
      "At Expiry": expiry[i].pnl,
    }));
  }, [K, premium, sigma, spot, exactDte, priceRange, daysElapsed, isCall]);

  const breakEven = isCall ? K + premium : K - premium;
  const maxProfit = Math.round(premium * 100 * 100) / 100;
  const maxLoss   = isCall ? null : Math.round((K - premium) * 100 * 100) / 100;
  const daysRemaining = Math.max(0, Math.round(exactDte - daysElapsed));

  const T_sim = Math.max(exactDte - daysElapsed, 0) / 365;
  const pnlAtSim = T_sim <= 0
    ? Math.round((premium - Math.max(0, isCall ? simPrice - K : K - simPrice)) * 100 * 100) / 100
    : Math.round((premium - bsGreeksAndPrice(simPrice, K, T_sim, R, sigma, isCall).price) * 100 * 100) / 100;

  return (
    <div className="space-y-1.5">
      {/* Summary stats */}
      <div className="flex items-center gap-6 text-xs">
        <span className="text-white">Max profit: <span className="text-green-400 font-mono font-bold">${maxProfit.toFixed(2)}</span></span>
        <span className="text-white">Break-even: <span className="text-amber-400 font-mono font-bold">${breakEven.toFixed(2)}</span></span>
        <span className="text-white">Max loss: <span className="text-red-400 font-mono font-bold">{maxLoss == null ? "Unlimited" : `-$${maxLoss.toFixed(2)}`}</span></span>
        <span className="text-white ml-auto font-mono text-xs">T−{daysRemaining}d</span>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={170}>
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
          <span className="text-white font-mono">
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
  runnerUp?: { chain: OptionsChainResult; put: OptionRow; result: OptionScoreResult } | null;
  isCall?: boolean;
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
  neutral: "text-white",
};

export function CreateSellPutDialog({ open, onClose, put, chain, isCall = false }: { open: boolean; onClose: () => void; put: OptionRow; chain: OptionsChainResult; isCall?: boolean }) {
  const [contracts,  setContracts]  = useState("1");
  const [confidence, setConfidence] = useState(0);
  const [notes,      setNotes]      = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [success,    setSuccess]    = useState(false);

  const premium = put.bid > 0 ? put.bid : 0;

  const reset = () => { setContracts("1"); setConfidence(0); setNotes(""); setError(null); setSuccess(false); };
  const handleClose = () => { reset(); onClose(); };

  async function handleSubmit() {
    if (!(premium > 0)) { setError("No live bid — cannot post without a sellable premium"); return; }
    if (!confidence) { setError("Select a confidence level"); return; }
    setSubmitting(true); setError(null);
    try {
      const r = await fetch("/api/feed/posts", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: chain.ticker,
          tradeType: isCall ? "SELL_CALL" : "SELL_PUT",
          strike: put.strike,
          expiry: chain.expiry,
          contracts: parseInt(contracts),
          premiumPerContract: premium,
          confidence,
          notes: notes || undefined,
          ivRankAtEntry: put.iv != null ? put.iv * 100 : undefined,
        }),
      });
      if (!r.ok) { const d = await r.json(); setError(d.error ?? "Submit failed"); return; }
      setSuccess(true);
      setTimeout(handleClose, 1000);
    } finally { setSubmitting(false); }
  }

  const inputCls = "w-full h-9 px-3 text-sm bg-secondary border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors";
  const labelCls = "block text-xs font-medium text-muted-foreground mb-1";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isCall ? "Sell Call" : "Sell Put"} — {chain.ticker} ${Number.isInteger(put.strike) ? put.strike : put.strike.toFixed(1)} exp {chain.expiry}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Contracts</label>
              <input type="number" min="1" step="1" value={contracts} onChange={e => setContracts(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Premium / contract</label>
              <input disabled value={premium > 0 ? `$${premium.toFixed(2)}` : "— (no live bid)"} className={cn(inputCls, "opacity-60")} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Confidence</label>
            <div className="flex items-center gap-1 h-9">
              {[1, 2, 3, 4, 5].map(n => (
                <button key={n} type="button" onClick={() => setConfidence(n)}
                  className={cn("text-lg leading-none transition-colors", n <= confidence ? "text-yellow-400" : "text-muted-foreground/30 hover:text-yellow-400/60")}>●</button>
              ))}
            </div>
          </div>
          <div>
            <label className={labelCls}>Rationale (optional)</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Your rationale…" className={cn(inputCls, "h-auto py-1.5 resize-none")} />
          </div>
          {error   && <div className="text-xs text-red-400">{error}</div>}
          {success && <div className="text-xs text-green-400">Posted!</div>}
          <button onClick={handleSubmit} disabled={submitting || !(premium > 0)}
            className="w-full bg-primary text-primary-foreground text-sm px-4 py-1.5 rounded hover:bg-primary/90 transition-colors disabled:opacity-50">
            {submitting ? "Posting…" : "Post Trade Idea"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function StrikeDetailPanel({ put, chain, scoreResult, isBest, runnerUp, isCall = false }: StrikeDetailPanelProps) {
  const bullets = useMemo(
    () => scoreResult ? scoreBullets(scoreResult, put, chain, isBest ? runnerUp ?? null : null, isCall) : [],
    [scoreResult, put, chain, isBest, runnerUp, isCall],
  );
  const [showCreateIdea, setShowCreateIdea] = useState(false);

  return (
    <div className="bg-slate-950/80 border-t border-slate-800/60">
      {/* Top section: bullets (narrow) + P&L chart (remaining width) side by side */}
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] divide-y md:divide-y-0 md:divide-x divide-slate-800/60">
        {/* Left: bullet reasoning */}
        <div className="px-3 py-2 space-y-1.5 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 flex-wrap">
            <p className={cn(
              "text-[10px] font-bold tracking-widest uppercase",
              isBest ? "text-green-400" : "text-white",
            )}>
              {isBest ? "★ Why this strike is best" : "Strike Analysis"}
            </p>
            {scoreResult && (
              <span className={cn(
                "font-mono text-xs font-bold",
                isBest ? "text-green-300" : "text-white",
              )}>
                {scoreResult.optionScore.toFixed(1)}<span className="text-white text-[10px] font-normal">/100</span>
                {scoreResult.dataQuality < 0.8 && (
                  <span className="text-amber-400 text-[10px] font-normal ml-2">
                    {(scoreResult.dataQuality * 100).toFixed(0)}% data
                  </span>
                )}
              </span>
            )}
            <button
              onClick={() => setShowCreateIdea(true)}
              className="ml-auto text-[10px] font-semibold uppercase tracking-wide text-primary border border-primary/40 rounded px-2 py-0.5 hover:bg-primary/10 transition-colors shrink-0"
            >
              + Sell {isCall ? "Call" : "Put"} Idea
            </button>
          </div>
          {bullets.length > 0 ? (
            <ul className="space-y-1">
              {bullets.map(({ text, sentiment }, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className={cn("text-[10px] mt-0.5 shrink-0 font-bold", SENTIMENT_COLOR[sentiment])}>
                    {SENTIMENT_ICON[sentiment]}
                  </span>
                  <span className="text-xs text-white leading-snug">{text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-white italic">No scorer data — technicals not yet loaded.</p>
          )}

          {/* Greeks & Liquidity — compact inline line */}
          <div className="pt-1 border-t border-slate-800/60">
            <p className="text-[9px] font-bold tracking-widest uppercase text-white mb-0.5">Greeks & Liquidity</p>
            <GreeksTable put={put} chain={chain} isCall={isCall} />
          </div>
        </div>

        {/* Right: P&L chart */}
        <div className="px-3 py-2 space-y-1.5">
          <p className="text-[10px] font-bold tracking-widest uppercase text-white">
            P&L Simulation — Short {isCall ? "Call" : "Put"} · 1 contract
          </p>
          <PayoffChart put={put} chain={chain} isCall={isCall} />
        </div>
      </div>
      <CreateSellPutDialog open={showCreateIdea} onClose={() => setShowCreateIdea(false)} put={put} chain={chain} isCall={isCall} />
    </div>
  );
}
