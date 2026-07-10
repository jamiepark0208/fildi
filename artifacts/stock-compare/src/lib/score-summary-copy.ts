export const SCORE_SUMMARY = {
  fundamental: "0–100 peer-relative score across Value, Growth, Quality, and Safety.",
  technical:   "0–100 technical setup score — higher means better timing for selling puts.",
  signal: {
    GO:    "RSI and MFI conditions favor entering a cash-secured put.",
    WATCH: "Near entry conditions — monitor for confirmation.",
    NO:    "Entry conditions not met — wait for better setup.",
  },
  stock:  "Combined score: technical setup + fundamental quality + entry timing.",
  option: "Strike-level score for premium, buffer, IV, and stock quality at this expiry.",
} as const;

export type ScoreType = "fundamental" | "technical" | "signal" | "stock" | "option";

export function staticCopy(scoreType: ScoreType, signal?: string): string {
  if (scoreType === "signal") {
    const key = (signal ?? "").toUpperCase() as keyof typeof SCORE_SUMMARY.signal;
    return SCORE_SUMMARY.signal[key] ?? SCORE_SUMMARY.signal.WATCH;
  }
  return SCORE_SUMMARY[scoreType];
}

export function guideTabFor(scoreType: ScoreType): "fundamental" | "technical" | "options" {
  if (scoreType === "fundamental") return "fundamental";
  if (scoreType === "technical" || scoreType === "signal") return "technical";
  return "options";
}
