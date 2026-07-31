import { cn } from "@/lib/utils";
import type {
  MacroData, ChartPoint, FedFundsCurvePoint, SepData, MacroEvent, COTSummary,
  LiquidityImplications, VolatilityImplications, MacroTab,
} from "./macro-page-types";
import {
  fmt, fmtPct, changeColor, VIX_LEVEL_LABELS,
  LIQUIDITY_LEVEL_LABEL, LIQUIDITY_LEVEL_STYLE, VOLATILITY_LEVEL_LABEL, VOLATILITY_LEVEL_STYLE,
} from "./macro-format";
import { derivePolicySignals } from "./macro-volatility-policy";
import { getCotCrowding } from "./macro-events-cot";

// ── Regime chips ────────────────────────────────────────────────────────────────

const vixTextColor: Record<string, string> = {
  low: "text-green-400", normal: "text-white", elevated: "text-yellow-400", high: "text-red-400", extreme: "text-red-400",
};

export function RegimeChips({ macroData }: { macroData: MacroData }) {
  const pct = macroData.series.corePce.yoy;
  const infl =
    pct == null
      ? { text: "Core PCE —", cls: "text-amber-200/40" }
      : pct > 2.5
      ? { text: `Core PCE ${fmt(pct, 1)}% ↑`, cls: "text-red-400" }
      : pct < 2.0
      ? { text: `Core PCE ${fmt(pct, 1)}% ↓`, cls: "text-green-400" }
      : { text: `Core PCE ${fmt(pct, 1)}% →`, cls: "text-yellow-400" };

  const ch = macroData.series.unemployment.change;
  const labor =
    ch == null
      ? { text: "Labor —", cls: "text-amber-200/40" }
      : ch > 0.1
      ? { text: "UR Rising ↑", cls: "text-yellow-400" }
      : ch < -0.1
      ? { text: "UR Falling ↓", cls: "text-green-400" }
      : { text: "Labor Stable", cls: "text-green-400" };

  const spread = macroData.yieldSpread;
  const curve = spread == null
    ? { text: "Curve —", cls: "text-amber-200/40" }
    : spread < 0
    ? { text: `Inverted ${(spread).toFixed(0)}bps`, cls: "text-red-400" }
    : { text: `Normal +${(spread).toFixed(0)}bps`, cls: "text-green-400" };

  const chips = [
    macroData.vix && {
      key: "vix",
      text: `VIX ${fmt(macroData.vix.value, 1)} · ${VIX_LEVEL_LABELS[macroData.vix.level]}`,
      cls: vixTextColor[macroData.vix.level] ?? "text-white",
    },
    { key: "infl", text: infl.text, cls: infl.cls },
    { key: "labor", text: labor.text, cls: labor.cls },
    { key: "curve", text: curve.text, cls: curve.cls },
    { key: "fed", text: "Fed On Hold", cls: "text-yellow-400" },
  ].filter((c): c is { key: string; text: string; cls: string } => Boolean(c));

  return (
    <span className="block text-[11px] font-mono">
      {chips.map((c, i) => (
        <span key={c.key}>
          {i > 0 && <span className="text-amber-200/40"> · </span>}
          <span className={c.cls}>{c.text}</span>
        </span>
      ))}
    </span>
  );
}

// Cross-tab "at a glance" verdict row for the Regime tab — reuses the same
// implication data already computed for the Volatility/Liquidity/Policy tabs
// and the COT cards, so this is pure aggregation, no new fetches or logic.
export function CrossTabReadRow({
  volatilityImplications, liquidityImplications, fedFundsCurve, sepData, events, cotSummaries, onJump,
}: {
  volatilityImplications: VolatilityImplications | undefined;
  liquidityImplications: LiquidityImplications | undefined;
  fedFundsCurve: FedFundsCurvePoint[];
  sepData: SepData | undefined;
  events: MacroEvent[] | undefined;
  cotSummaries: COTSummary[];
  onJump: (tab: MacroTab) => void;
}) {
  const policy = derivePolicySignals(fedFundsCurve, sepData, events, volatilityImplications);
  const mostExtremeCot = cotSummaries.length
    ? [...cotSummaries].sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore))[0]
    : undefined;
  const cot = mostExtremeCot ? getCotCrowding(mostExtremeCot) : undefined;

  const badges: { label: string; readout: string; style: { badge: string; dot: string; text: string }; tab: MacroTab }[] = [
    volatilityImplications && {
      label: "Volatility",
      readout: VOLATILITY_LEVEL_LABEL[volatilityImplications.overall.level],
      style: VOLATILITY_LEVEL_STYLE[volatilityImplications.overall.level], tab: "volatility" as const,
    },
    liquidityImplications && {
      label: "Liquidity",
      readout: LIQUIDITY_LEVEL_LABEL[liquidityImplications.overall.level],
      style: LIQUIDITY_LEVEL_STYLE[liquidityImplications.overall.level], tab: "liquidity" as const,
    },
    {
      label: "Policy", readout: VOLATILITY_LEVEL_LABEL[policy.overall.level],
      style: VOLATILITY_LEVEL_STYLE[policy.overall.level], tab: "policy" as const,
    },
    cot && mostExtremeCot && {
      label: "COT", readout: `${mostExtremeCot.displayName}: ${cot.label}`,
      style: VOLATILITY_LEVEL_STYLE[cot.level], tab: "volatility" as const,
    },
  ].filter((b): b is NonNullable<typeof b> => Boolean(b));

  if (!badges.length) return null;

  return (
    <span className="block text-[11px] font-mono">
      {badges.map((b, i) => (
        <button
          key={b.label}
          onClick={() => onJump(b.tab)}
          className="hover:brightness-125 transition-colors"
          title={`Jump to ${b.tab}`}
        >
          {i > 0 && <span className="text-amber-200/40"> · </span>}
          <span className="text-amber-200/50">{b.label} </span>
          <span className={cn(b.style.text)}>{b.readout}</span>
        </button>
      ))}
    </span>
  );
}

// ── Quick stats ─────────────────────────────────────────────────────────────────

export function StatCell({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div className="border border-[#d4af37]/20 rounded-md px-2 py-1 flex-1 min-w-[90px] bg-zinc-950">
      <p className="text-[10px] text-[#d4af37]/80 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold leading-tight text-white font-mono">
        {value}
        {sub && <span className={cn("text-[10px] ml-1", subColor)}>{sub}</span>}
      </p>
    </div>
  );
}

// Single-row compact stat — same info as StatCell but inline, for banners where
// vertical space is at a premium (e.g. the Regime tab's yield strip).
export function CompactStat({ label, value, sub, subColor, title }: {
  label: string; value: string; sub?: string; subColor?: string; title?: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 px-1.5 font-mono" title={title}>
      <span className="text-[10px] text-amber-200/50 uppercase tracking-wide">{label}</span>
      <span className="text-[11px] font-semibold text-white">{value}</span>
      {sub && <span className={cn("text-[10px]", subColor)}>{sub}</span>}
    </span>
  );
}

// Last value + change vs prior observation from a history series.
const lastPointDelta = (data: ChartPoint[] | undefined): { value: number; change: number | null } | null => {
  if (!data || data.length === 0) return null;
  const last = data[data.length - 1].value;
  const prev = data.length > 1 ? data[data.length - 2].value : null;
  return { value: last, change: prev != null ? last - prev : null };
};

function StatChip({ label, value, change, decimals = 1, invert = false, title }: {
  label: string; value: number | null; change: number | null; decimals?: number; invert?: boolean; title?: string;
}) {
  const color = change == null ? "" : (invert ? -change : change) > 0 ? "text-green-400" : (invert ? -change : change) < 0 ? "text-red-400" : "text-amber-200/50";
  return (
    <span className="inline-flex items-baseline gap-1 px-1.5 font-mono" title={title}>
      <span className="text-[10px] text-amber-200/50 uppercase tracking-wide">{label}</span>
      <span className="text-[11px] font-semibold text-white">{value != null ? value.toFixed(decimals) : "—"}</span>
      {change != null && (
        <span className={cn("text-[10px]", color)}>
          {change > 0 ? "+" : ""}{change.toFixed(decimals)}
        </span>
      )}
    </span>
  );
}

export function VolStrip({ macroData, macroCharts }: {
  macroData: MacroData;
  macroCharts: { putCallHistory?: ChartPoint[]; putCallRatioHistory?: ChartPoint[]; moveHistory?: ChartPoint[]; fearGreedHistory?: ChartPoint[] } | undefined;
}) {
  const vvix = lastPointDelta(macroCharts?.putCallHistory);
  const pc = lastPointDelta(macroCharts?.putCallRatioHistory);
  const move = lastPointDelta(macroCharts?.moveHistory);
  const fg = lastPointDelta(macroCharts?.fearGreedHistory);

  return (
    <div className="border border-[#d4af37]/20 rounded-md flex flex-wrap items-center divide-x divide-[#d4af37]/10 bg-zinc-950 py-0.5">
      <StatChip label="VIX" value={macroData.vix.value} change={macroData.vix.change ?? null}
        title="S&P 500 30-day implied volatility — the market's headline fear gauge" />
      <StatChip label="SKEW" value={macroData.skew.value} change={macroData.skew.change ?? null}
        title="Tail-risk pricing — rising SKEW means options markets are paying up for a sharp downside surprise" />
      <StatChip label="VXN" value={macroData.vxn.value} change={macroData.vxn.change ?? null}
        title="Nasdaq-100 implied volatility — the tech/growth-stock equivalent of VIX" />
      {vvix && <StatChip label="VVIX" value={vvix.value} change={vvix.change} decimals={0}
        title="Volatility of VIX itself — spikes here signal vol-of-vol stress, often preceding VIX blowouts" />}
      {pc && <StatChip label="PUT/CALL" value={pc.value} change={pc.change} decimals={2}
        title="CBOE equity put/call ratio — above ~1.0 is bearish/hedging-heavy positioning, below ~0.7 is bullish complacency" />}
      {move && <StatChip label="MOVE" value={move.value} change={move.change} decimals={0}
        title="Bond-market implied volatility — often leads VIX during rate-shock-driven stress" />}
      {fg && <StatChip label="FEAR/GREED" value={fg.value} change={fg.change} decimals={0}
        title="CNN's composite sentiment gauge (0=extreme fear, 100=extreme greed) across 7 market indicators" />}
    </div>
  );
}

export function QuickStats({ macroData }: { macroData: MacroData }) {
  const debtT = macroData.usDebt != null
    ? `$${(macroData.usDebt / 1_000_000).toFixed(1)}T`
    : "—";

  return (
    <div className="flex flex-wrap gap-1.5">
      <StatCell
        label="VIX"
        value={fmt(macroData.vix.value, 1)}
        sub={macroData.vix.change != null ? `${macroData.vix.change > 0 ? "+" : ""}${fmt(macroData.vix.change, 2)}` : undefined}
        subColor={changeColor(macroData.vix.change ?? null)}
      />
      <StatCell
        label="SKEW"
        value={fmt(macroData.skew.value, 1)}
        sub={macroData.skew.change != null ? `${macroData.skew.change > 0 ? "+" : ""}${fmt(macroData.skew.change, 2)}` : undefined}
        subColor={changeColor(macroData.skew.change ?? null)}
      />
      <StatCell
        label="VXN (NDX)"
        value={fmt(macroData.vxn.value, 1)}
        sub={macroData.vxn.change != null ? `${macroData.vxn.change > 0 ? "+" : ""}${fmt(macroData.vxn.change, 2)}` : undefined}
        subColor={changeColor(macroData.vxn.change ?? null)}
      />
      <StatCell
        label="10Y Yield"
        value={`${fmt(macroData.yield10y.value, 3)}%`}
        sub={macroData.yield10y.change != null ? `${macroData.yield10y.change > 0 ? "+" : ""}${fmt(macroData.yield10y.change, 3)}` : undefined}
        subColor={changeColor(macroData.yield10y.change ?? null)}
      />
      <StatCell
        label="2Y Yield"
        value={`${fmt(macroData.yield2y.value, 3)}%`}
        sub={macroData.yield2y.change != null ? `${macroData.yield2y.change > 0 ? "+" : ""}${fmt(macroData.yield2y.change, 3)}` : undefined}
        subColor={changeColor(macroData.yield2y.change ?? null)}
      />
      <StatCell
        label="2s10s Spread"
        value={macroData.yieldSpread != null ? `${macroData.yieldSpread.toFixed(0)} bps` : "—"}
        sub={macroData.yieldSpread != null ? (macroData.yieldSpread < 0 ? "⚠ Inverted" : "Normal") : undefined}
        subColor={macroData.yieldSpread != null && macroData.yieldSpread < 0 ? "text-red-400" : "text-green-400"}
      />
      <StatCell label="Fed Funds" value={fmtPct(macroData.series.fedFundsRate.value)} />
      <StatCell label="US Debt" value={debtT} />
    </div>
  );
}
