// Family-weight presets for the V2 fundamental scorecard (re-exported from rankings.ts).
import type { FamilyName } from "./rankings.js";

export type FamilyPreset = Record<FamilyName, number>;

export const FAMILY_PRESETS: Record<string, FamilyPreset> = {
  // Weights sum to 100 — maxPossible is always 100
  PUT_SELLER: { value: 20, growth: 25, quality: 35, safety: 20 },
  GROWTH:     { value: 15, growth: 45, quality: 25, safety: 15 },
};

// Regime-aware presets — selected at score time based on market_regime DB value.
// Weights sum to 100 per row.
export const REGIME_PRESETS: Record<string, FamilyPreset> = {
  expansion:   { value: 15, growth: 35, quality: 30, safety: 20 },
  late_cycle:  { value: 20, growth: 20, quality: 35, safety: 25 },
  contraction: { value: 20, growth: 15, quality: 35, safety: 30 },
  recession:   { value: 15, growth: 10, quality: 30, safety: 45 },
  recovery:    { value: 15, growth: 35, quality: 30, safety: 20 },
  stagflation: { value: 25, growth: 10, quality: 35, safety: 30 },
};
