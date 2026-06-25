import { useQuery } from "@tanstack/react-query";
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Activity, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface RegimeResult {
  regime: string;
  confidence: number;
  confirmingSignals: string[];
  conflictingSignals: string[];
  indicatorSnapshot: Record<string, unknown>;
  computedAt: string;
  cachedAt: number;
}

const REGIME_META: Record<string, { label: string; color: string; bg: string; border: string; icon: typeof TrendingUp; description: string }> = {
  expansion:          { label: "Expansion",          color: "text-emerald-300", bg: "bg-emerald-950/60", border: "border-emerald-700/50", icon: TrendingUp,   description: "Risk assets favored. Growth above trend, credit loose, VIX subdued." },
  late_cycle:         { label: "Late Cycle",         color: "text-yellow-300",  bg: "bg-yellow-950/60",  border: "border-yellow-700/50",  icon: Activity,     description: "Growth peaking. Fed tightening, CPI elevated, curve flattening." },
  contraction:        { label: "Contraction",        color: "text-orange-300",  bg: "bg-orange-950/60",  border: "border-orange-700/50",  icon: TrendingDown, description: "Growth slowing. Credit spreads widening, VIX rising, PMI below 50." },
  recession:          { label: "Recession",          color: "text-red-300",     bg: "bg-red-950/60",     border: "border-red-700/50",     icon: AlertTriangle, description: "Negative GDP, spreads blown out, VIX spiked. Max defensive posture." },
  recovery:           { label: "Recovery",           color: "text-sky-300",     bg: "bg-sky-950/60",     border: "border-sky-700/50",     icon: TrendingUp,   description: "Vol subsiding, curve steepening, Fed on hold. Early risk-on rotation." },
  stagflation:        { label: "Stagflation",        color: "text-purple-300",  bg: "bg-purple-950/60",  border: "border-purple-700/50",  icon: Zap,          description: "Elevated CPI + weak growth. Fed hands tied. Real assets outperform." },
  insufficient_data:  { label: "Insufficient Data",  color: "text-zinc-400",    bg: "bg-zinc-900/60",    border: "border-zinc-700/50",    icon: Minus,        description: "Not enough live data to classify regime. Check cache/data feeds." },
};

const SIGNAL_LABELS: Record<string, string> = {
  vix_low: "VIX < 18", vix_falling: "VIX falling", vix_mid: "VIX mid-range", vix_stress: "VIX stressed",
  vix_rising: "VIX rising", vix_spike: "VIX spike", pmi_high: "PMI > 52", pmi_border: "PMI 50–53",
  pmi_below50: "PMI < 50", pmi_deep: "PMI < 48", pmi_stag: "PMI weak", pmi_recovering: "PMI recovering",
  curve_pos: "Curve positive", curve_flat: "Curve flat", curve_inv: "Curve inverted", curve_crisis: "Curve deeply inverted",
  curve_steepening: "Curve steepening", hy_tightening: "HY spreads tightening", hy_flat: "HY spreads flat",
  hy_widening: "HY spreads widening", hy_blown: "HY OAS > 500", hy_tightening_from_wide: "HY tightening from wide",
  hy_wide_stag: "HY widening", gdp_strong: "GDP > 2%", gdp_slowing: "GDP 0–2%", gdp_weak: "GDP < 1%",
  gdp_neg: "GDP negative", gdp_stag: "GDP weak", gdp_near_zero_pos: "GDP near zero", fg_high: "Fear/Greed > 60",
  fg_mid: "Fear/Greed 45–65", fg_fear: "Fear/Greed < 45", fg_extreme_fear: "Extreme fear",
  fg_improving: "Fear/Greed rising", cot_positive: "COT net long", cot_negative: "COT net short",
  fed_easy: "Fed neutral/dovish", fed_hawk: "Fed hawkish", fed_hiking: "Fed hiking", fed_dove: "Fed dovish",
  fed_easy2: "Fed cutting/hold", fed_high_hold: "Fed high & hold", bank_on: "Banks risk-on",
  bank_off: "Banks risk-off", bank_off2: "Banks risk-off", cpi_hot: "CPI > 3%", cpi_stagflation: "CPI > 3.5%",
  ur_rising: "Unemployment rising", ur_elev: "Unemployment elevated", vol_subsiding: "Vol subsiding",
  vix_override_gt30: "VIX > 30 override", cpi_dovish_mismatch: "CPI/Fed mismatch",
  high_vol_event_pending: "High-impact event <10d",
};

function fmtSignal(key: string) {
  return SIGNAL_LABELS[key] ?? key.replace(/_/g, " ");
}

function ConfidenceBar({ value }: { value: number }) {
  const color = value >= 60 ? "bg-emerald-500" : value >= 35 ? "bg-yellow-500" : "bg-orange-500";
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="h-1.5 w-24 bg-zinc-800 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${value}%` }} />
      </div>
      <span className="text-[11px] text-muted-foreground">{value}% confidence</span>
    </div>
  );
}

export function RegimeBanner() {
  const { data, isLoading, isError } = useQuery<RegimeResult>({
    queryKey: ["regime-macro"],
    queryFn: () => fetch("/api/regime/macro").then((r) => r.json()),
    staleTime: 1000 * 60 * 60, // 1h client-side freshness
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 animate-pulse h-20" />
    );
  }

  if (isError || !data) return null;

  const meta = REGIME_META[data.regime] ?? REGIME_META.insufficient_data;
  const Icon = meta.icon;
  const confirming = (data.confirmingSignals ?? []).filter((s) => !["vix_override_gt30", "cpi_dovish_mismatch", "high_vol_event_pending"].includes(s));
  const hasVolEvent = data.conflictingSignals?.includes("high_vol_event_pending");

  return (
    <div className={cn("rounded-lg border p-4 space-y-2.5", meta.bg, meta.border)}>
      {/* Header row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Icon className={cn("h-5 w-5 shrink-0", meta.color)} />
          <div>
            <div className="flex items-center gap-2">
              <span className={cn("text-sm font-bold tracking-wide", meta.color)}>{meta.label}</span>
              <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">regime</span>
            </div>
            <ConfidenceBar value={data.confidence} />
          </div>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0 pt-0.5">
          {new Date(data.computedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </span>
      </div>

      {/* AI explanation */}
      <p className="text-[12px] text-muted-foreground leading-relaxed">{meta.description}</p>

      {/* Confirming signals */}
      {confirming.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {confirming.map((s) => (
            <span key={s} className={cn("text-[10px] font-medium px-2 py-0.5 rounded border", meta.bg, meta.color, meta.border)}>
              ✓ {fmtSignal(s)}
            </span>
          ))}
        </div>
      )}

      {/* Conflict / vol event warning */}
      {hasVolEvent && (
        <div className="flex items-center gap-1.5 text-[11px] text-yellow-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          High-impact macro event within 10 days — regime may shift
        </div>
      )}
    </div>
  );
}
