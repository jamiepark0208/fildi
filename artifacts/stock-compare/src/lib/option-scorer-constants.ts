// All tunable constants for the options scanner scorer.
// Change values here only — nowhere else in the scoring logic.

export type MacroRegime    = "LOW_VOL" | "BASELINE" | "ELEVATED" | "EXTREME";
export type IndexDirection = "RALLY" | "NEUTRAL" | "CRASH";

// ── Income adequacy ───────────────────────────────────────────────────────────
export const INCOME_FLOOR        = 0.5;  // %/wk — below this → score 0
export const INCOME_TARGET       = 1.0;  // %/wk — peaks at 1.0 on the score curve
export const INCOME_DECAY_FLOOR  = 0.70; // min score as yield → ∞ (encodes: 2.5%/wk ≠ better than 1%/wk)

// Regime-shifted income target and floor for the macro overlay
export const REGIME_INCOME_TARGET: Record<MacroRegime, number> = {
  LOW_VOL:  0.5,
  BASELINE: 1.0,
  ELEVATED: 1.25,
  EXTREME:  1.5,
};
export const REGIME_INCOME_FLOOR: Record<MacroRegime, number> = {
  LOW_VOL:  0.5,
  BASELINE: 0.5,
  ELEVATED: 0.5,
  EXTREME:  0.5,
};

// ── Delta / buffer ────────────────────────────────────────────────────────────
// Sweet-spot band per regime — |put delta|, score peaks inside, decays outside
export const DELTA_SWEET_LOW: Record<MacroRegime, number> = {
  LOW_VOL:  0.08,
  BASELINE: 0.10,
  ELEVATED: 0.12,
  EXTREME:  0.15,
};
export const DELTA_SWEET_HIGH: Record<MacroRegime, number> = {
  LOW_VOL:  0.12,
  BASELINE: 0.15,
  ELEVATED: 0.20,
  EXTREME:  0.25,
};
// Above DELTA_MAX → score 0; too much assignment risk
export const DELTA_MAX = 0.35;

// SD-buffer target: OTM distance / expected-move; score peaks at ~1.25 SDs OTM
export const SD_BUFFER_TARGET = 1.25;
export const SD_BUFFER_MAX    = 2.5; // above → mild decay (income catches low yield)

// Blend weights inside the Buffer component (must sum to 1.0)
export const BUFFER_WEIGHT_DELTA    = 0.60; // primary: delta band
export const BUFFER_WEIGHT_SD       = 0.40; // cross-check: SD buffer

// ── VIX / regime thresholds ───────────────────────────────────────────────────
export const VIX_LOW              = 15;
export const VIX_ELEVATED         = 20;
export const VIX_EXTREME          = 30;
export const INDEX_MOVE_THRESHOLD = 0.01; // ±1% → RALLY / CRASH

// ── Liquidity gate ────────────────────────────────────────────────────────────
export const MIN_OI           = 50;
export const MAX_SPREAD_PCT   = 0.30;  // fraction of mid price
export const MIN_VOL          = 5;
export const LIQUIDITY_GATE_HARD = false; // false = soft warn; true = hard exclude

// ── Option Score component weights (must sum to 1.0) ─────────────────────────
export const W_INCOME        = 0.30;
export const W_BUFFER        = 0.32;
export const W_IV_RELATIVE   = 0.10;
export const W_IV_ABSOLUTE   = 0.06;
export const W_STOCK_QUALITY = 0.12;
export const W_SUPPORT       = 0.06;
export const W_DTE           = 0.04;

// ── IV nudge caps (additive bonuses within IV relative component) ─────────────
export const IV_VS_REALIZED_BONUS = 0.05; // bonus if IV > realized vol
export const IV_SKEW_BONUS        = 0.05; // bonus if put skew > 0

// ── Absolute IV cross-watchlist cap ──────────────────────────────────────────
export const IV_ABSOLUTE_CAP = 0.85; // max score — prevents junk-high-IV names from winning on raw IV

// ── Stock Score component weights (must sum to 1.0) ──────────────────────────
export const WS_TECHNICAL      = 0.40;
export const WS_FUNDAMENTAL    = 0.25;
export const WS_RELATIVE_MOVE  = 0.20;
export const WS_BEST_OPTION    = 0.10;
export const WS_TAG            = 0.05;

// ── Tag bonus values ─────────────────────────────────────────────────────────
// Additive [0,1] bonus scaled by WS_TAG. Never large enough to override IV/score.
export const TAG_BONUS: Record<string, number> = {
  green:  1.0,   // long conviction
  blue:   0.8,   // holding / assigned
  yellow: 0.5,   // moderate income
  purple: 0.5,   // market context (e.g. index constituent)
};

// ── Data quality ──────────────────────────────────────────────────────────────
export const MIN_SCORED_COMPONENTS = 3; // fewer available → suppress BEST label
