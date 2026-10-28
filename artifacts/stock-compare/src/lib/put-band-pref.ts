/** Sold-put delta band preference — mirrors PUT /api/strategies/put-band body.pref */
export type PutBandPref =
  | { mode: "auto" }
  | { mode: "shift"; steps: number }
  | { mode: "fixed"; band: string };

export type PutBandState = {
  pref: PutBandPref;
  bands: string[];
  computedAt: string | null;
  updatedAt?: string | null;
};

export const PUT_BAND_TOOLTIP =
  "Auto = band engine by market × stock state (S101). Shift moves every pick that many bands. Fixed = same band for all. Panic pause, earnings/credit far rules and the 0.20Δ cap still apply.";

const SHIFT_STEPS = [-2, -1, 1, 2] as const;

export function putBandShiftSteps(): readonly number[] {
  return SHIFT_STEPS;
}

export function putBandPrefLabel(pref: PutBandPref): string {
  if (pref.mode === "auto") return "Auto (engine)";
  if (pref.mode === "shift") {
    const n = pref.steps;
    if (n < 0) return `Farther ${n}`;
    if (n > 0) return `Closer +${n}`;
    return "Shift 0";
  }
  return `Fixed ${pref.band}Δ`;
}

export function putBandSegmentActive(pref: PutBandPref, segment: "auto" | number | "fixed"): boolean {
  if (segment === "auto") return pref.mode === "auto";
  if (segment === "fixed") return pref.mode === "fixed";
  return pref.mode === "shift" && pref.steps === segment;
}

export function parsePutBandError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return "Could not save put band";
}
