// ── Palette ───────────────────────────────────────────────────────────────────

// Dense data-grid look matching RobinhoodPortfolio's Equity Positions table.
export const TTH = "py-2 px-3 font-medium text-[10px] uppercase tracking-widest text-muted-foreground";
export const TTD = "py-2 px-3 text-xs tabular-nums";

// Whole strikes render without decimals; fractional strikes (e.g. 6.5) keep only as many as needed.
export function formatStrike(strike: number): string {
  return `$${Number(strike.toFixed(2))}`;
}

export const PALETTE = [
  "#38bdf8","#fb923c","#34d399","#a78bfa",
  "#f472b6","#fbbf24","#60a5fa","#f87171",
  "#4ade80","#e879f9","#94a3b8","#2dd4bf",
];

// Yahoo's assetProfile has no GICS sector for these funds — they're option-income/leveraged
// ETFs, not equities, so we label them by strategy instead of falling back to "Unknown".
export const SECTOR_OVERRIDES: Record<string, string> = {
  NVDY: "ETF (Option Income)",
  HOOY: "ETF (Option Income)",
  PLTU: "Levered ETF",
};

// These pairs share the same underlying (derivative-of-underlying ETFs), so their
// correlation is mechanically ~1 and would wash out the color scale for every other,
// actually-informative pair in the matrix — excluded from scaling, not just from display.
export const SAME_UNDERLYING_PAIRS: [string, string][] = [
  ["HOOD", "HOOY"],
  ["NVDA", "NVDY"],
  ["PLTR", "PLTU"],
];
export function isSameUnderlyingPair(a: string, b: string): boolean {
  return SAME_UNDERLYING_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

// Beta Contribution bar colors: covered-call positions get their own color regardless of
// contribution size (the delta adjustment already lowers their bar), everything else is
// banded by raw contribution so the biggest single-name risk concentrations stand out.
export const BETA_BAR_LEGEND = [
  { color: "#a78bfa", label: "Covered Call" },
  { color: "#f97316", label: "Contribution > 0.4" },
  { color: "#fbbf24", label: "Contribution 0.2–0.4" },
  { color: "#34d399", label: "Contribution < 0.2" },
];

export const REALIZED_UNREALIZED_LEGEND = [
  { key: "realized",   color: "#38bdf8", label: "Realized" },
  { key: "unrealized", color: "#a78bfa", label: "Unrealized" },
];

export const TICKER_PNL_SEGMENTS = [
  { key: "stocks",   color: "#38bdf8", label: "Stocks" },
  { key: "dividends", color: "#34d399", label: "Dividends" },
  { key: "sellPut",  color: "#fbbf24", label: "Sell Put" },
  { key: "sellCall", color: "#f97316", label: "Sell Call" },
  { key: "longCall", color: "#60a5fa", label: "Long Call" },
  { key: "longPut",  color: "#f472b6", label: "Long Put" },
] as const;

// Blue = low correlation (good diversification), red = high correlation (concentration
// risk) — fully opaque background fill scaled by magnitude, white text on top for
// contrast. Alpha-blending this against the dark card background (previous version)
// desaturated everything into a dim gray-purple; solid fills read as actual blue/red.
export const CORR_LOW_RGB  = [59, 130, 246];  // blue-500 (#3b82f6)
export const CORR_HIGH_RGB = [239, 68, 68];   // red-500  (#ef4444)
export function correlationBg(v: number, scaleMax: number): string {
  const t = Math.min(Math.abs(v) / scaleMax, 1);
  const [r, g, b] = CORR_LOW_RGB.map((low, idx) => Math.round(low + (CORR_HIGH_RGB[idx] - low) * t));
  return `rgb(${r},${g},${b})`;
}
