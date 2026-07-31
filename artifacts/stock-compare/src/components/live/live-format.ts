// Shared formatting helpers for the Live tab components (extracted from live.tsx).

// drizzle numeric columns arrive as strings — parse defensively (mirrors pf() in technical-rankings).
export function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ivCurrent/return5d from IndicatorResult are already plain percent numbers (e.g. 23.09 = 23.09%),
// not decimal fractions — matches the convention in options-scanner.tsx/technical.tsx.
export function pct(v: number | null, digits = 1): string {
  return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function scoreColor(score: number | null): string {
  if (score == null) return "text-amber-200/40";
  if (score >= 65) return "text-green-500";
  if (score >= 45) return "text-yellow-500";
  return "text-red-500";
}

// Maps a %change value to a background color whose intensity scales with magnitude, clamped
// at maxMagnitude so single-digit movers still look visually distinct from the ±5%+ extremes.
export function heatColor(changePercent: number | null, maxMagnitude = 5): string {
  if (changePercent == null) return "hsl(0, 0%, 50%, 0.08)";
  const magnitude = Math.min(Math.abs(changePercent), maxMagnitude) / maxMagnitude;
  const alpha = 0.12 + magnitude * 0.55;
  const hue = changePercent >= 0 ? 142 : 0; // matches text-green-500 / text-red-500 hues
  return `hsl(${hue}, 70%, 45%, ${alpha})`;
}

export function heatBorderColor(changePercent: number | null): string {
  if (changePercent == null) return "hsl(0, 0%, 50%)";
  return changePercent >= 0 ? "hsl(142, 70%, 45%)" : "hsl(0, 70%, 50%)";
}

export function formatVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(v);
}
