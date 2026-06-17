import { FAMILY_PRESETS, SCORECARD_METRICS_V2, type FamilyPreset } from "@/lib/rankings";
import { TECHNICAL_SCORECARD_METRICS_V2 } from "@/lib/technical-rankings";
import {
  W_INCOME, W_BUFFER, W_IV_RELATIVE, W_IV_ABSOLUTE, W_STOCK_QUALITY, W_SUPPORT, W_DTE,
  WS_TECHNICAL, WS_FUNDAMENTAL, WS_RELATIVE_MOVE, WS_BEST_OPTION, WS_TAG,
} from "@/lib/option-scorer-constants";

export type ScoringWeightsConfig = {
  familyPreset: FamilyPreset;
  fundamentalMetrics: Record<string, number>;
  technical: Record<string, number>;
  optionStock: Record<string, number>;
  optionStrike: Record<string, number>;
};

export function buildDefaultScoringWeights(): ScoringWeightsConfig {
  return {
    familyPreset: { ...FAMILY_PRESETS.PUT_SELLER },
    fundamentalMetrics: Object.fromEntries(
      SCORECARD_METRICS_V2.map(m => [m.key, m.intraWeight]),
    ),
    technical: Object.fromEntries(
      TECHNICAL_SCORECARD_METRICS_V2.map(m => [m.key, m.weight]),
    ),
    optionStock: {
      technical: WS_TECHNICAL,
      fundamental: WS_FUNDAMENTAL,
      relativeMove: WS_RELATIVE_MOVE,
      bestOption: WS_BEST_OPTION,
      tag: WS_TAG,
    },
    optionStrike: {
      income: W_INCOME,
      buffer: W_BUFFER,
      ivRelative: W_IV_RELATIVE,
      ivAbsolute: W_IV_ABSOLUTE,
      stockQuality: W_STOCK_QUALITY,
      support: W_SUPPORT,
      dte: W_DTE,
    },
  };
}

export function mergeScoringWeights(partial?: Partial<ScoringWeightsConfig> | null): ScoringWeightsConfig {
  const d = buildDefaultScoringWeights();
  if (!partial) return d;
  return {
    familyPreset: { ...d.familyPreset, ...partial.familyPreset },
    fundamentalMetrics: { ...d.fundamentalMetrics, ...partial.fundamentalMetrics },
    technical: { ...d.technical, ...partial.technical },
    optionStock: { ...d.optionStock, ...partial.optionStock },
    optionStrike: { ...d.optionStrike, ...partial.optionStrike },
  };
}

function sumValues(o: Record<string, number>): number {
  return Object.values(o).reduce((a, b) => a + b, 0);
}

/** Returns error message or null if valid */
export function validateScoringWeights(c: ScoringWeightsConfig): string | null {
  const famSum = c.familyPreset.value + c.familyPreset.growth + c.familyPreset.quality + c.familyPreset.safety;
  if (Math.abs(famSum - 100) > 0.01) return `Family weights must sum to 100 (got ${famSum})`;
  const techSum = sumValues(c.technical);
  if (Math.abs(techSum - 1) > 0.01) return `Technical weights must sum to 1.0 (got ${techSum.toFixed(3)})`;
  const osSum = sumValues(c.optionStock);
  if (Math.abs(osSum - 1) > 0.01) return `Option stock weights must sum to 1.0 (got ${osSum.toFixed(3)})`;
  const ostSum = sumValues(c.optionStrike);
  if (Math.abs(ostSum - 1) > 0.01) return `Option strike weights must sum to 1.0 (got ${ostSum.toFixed(3)})`;
  return null;
}

export const SCORING_CONFIG_KEY = "scoring_weights";

/** Map guide row keys → config paths for admin editing */
export type WeightGroup = "familyPreset" | "fundamentalMetrics" | "technical" | "optionStock" | "optionStrike";

export function getWeightFromConfig(c: ScoringWeightsConfig, group: WeightGroup, key: string): number {
  if (group === "familyPreset") return c.familyPreset[key as keyof FamilyPreset];
  return c[group][key] ?? 0;
}

export function setWeightInConfig(c: ScoringWeightsConfig, group: WeightGroup, key: string, val: number): ScoringWeightsConfig {
  const next = { ...c, familyPreset: { ...c.familyPreset } };
  if (group === "familyPreset") {
    next.familyPreset = { ...next.familyPreset, [key]: val };
  } else {
    next[group] = { ...c[group], [key]: val };
  }
  return next;
}
