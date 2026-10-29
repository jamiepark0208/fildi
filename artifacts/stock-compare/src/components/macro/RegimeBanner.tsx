import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
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

const REGIME_META: Record<string, { label: string; color: string; description: string }> = {
  expansion:         { label: "Expansion",         color: "text-emerald-400", description: "Risk assets favored. Growth above trend, credit loose, VIX subdued." },
  late_cycle:        { label: "Late Cycle",        color: "text-yellow-400",  description: "Growth peaking. Fed tightening, CPI elevated, curve flattening." },
  contraction:       { label: "Contraction",       color: "text-orange-400",  description: "Growth slowing. Credit spreads widening, VIX rising, PMI below 50." },
  recession:         { label: "Recession",         color: "text-red-400",     description: "Negative GDP, spreads blown out, VIX spiked. Max defensive posture." },
  recovery:          { label: "Recovery",          color: "text-sky-400",     description: "Vol subsiding, curve steepening, Fed on hold. Early risk-on rotation." },
  stagflation:       { label: "Stagflation",       color: "text-purple-400",  description: "Elevated CPI + weak growth. Fed hands tied. Real assets outperform." },
  insufficient_data: { label: "Insufficient Data", color: "text-amber-200/50", description: "Not enough live data to classify regime. Check cache/data feeds." },
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

function confColor(v: number): string {
  if (v >= 60) return "text-emerald-400";
  if (v >= 35) return "text-yellow-400";
  return "text-orange-400";
}

/** Compact mono strip — matches VolStrip / RegimeChips / other macro tab headers. */
export function RegimeBanner() {
  const { data, isLoading, isError } = useQuery<RegimeResult>({
    queryKey: ["regime-macro"],
    queryFn: () => fetch("/api/regime/macro").then((r) => r.json()),
    staleTime: 1000 * 60 * 60,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return <div className="h-4 w-64 bg-zinc-800/60 animate-pulse rounded" />;
  }
  if (isError || !data) return null;

  const meta = REGIME_META[data.regime] ?? REGIME_META.insufficient_data;
  const confirming = (data.confirmingSignals ?? []).filter(
    (s) => !["vix_override_gt30", "cpi_dovish_mismatch", "high_vol_event_pending"].includes(s),
  );
  const hasVolEvent = data.conflictingSignals?.includes("high_vol_event_pending");
  const stamp = new Date(data.computedAt);
  const mdY = `${stamp.getMonth() + 1}/${stamp.getDate()}/${String(stamp.getFullYear()).slice(2)}`;

  return (
    <span className="block text-[11px] font-mono leading-relaxed">
      <span className="text-[#d4af37]/80 uppercase tracking-wide">Regime </span>
      <span className={cn("font-semibold", meta.color)}>{meta.label}</span>
      <span className="text-amber-200/40"> · {mdY} · </span>
      <span className={cn("font-semibold", confColor(data.confidence))}>{data.confidence}% conf</span>
      <span className="text-amber-200/40"> · </span>
      <span className="text-amber-200/50">{meta.description}</span>
      {confirming.length > 0 && (
        <>
          <span className="text-amber-200/40"> · </span>
          {confirming.map((s, i) => (
            <span key={s}>
              {i > 0 && <span className="text-amber-200/40"> · </span>}
              <span className={meta.color}>✓ {fmtSignal(s)}</span>
            </span>
          ))}
        </>
      )}
      {hasVolEvent && (
        <>
          <span className="text-amber-200/40"> · </span>
          <span className="inline-flex items-center gap-0.5 text-yellow-400">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            High-impact event &lt;10d
          </span>
        </>
      )}
    </span>
  );
}
