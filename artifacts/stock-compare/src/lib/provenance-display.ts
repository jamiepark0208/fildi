/**
 * A99 Phase 1 — display helpers over GET /api/fundamentals/provenance/:ticker.
 * Facts only (source, as-of, divergent/override). No 0–100 quality score.
 */

/** Minimal shape — matches FieldProv from stock-db-types (avoid importing Stock DB tree in tests). */
export interface ProvTipField {
  field: string;
  winningSource: string | null;
  isOverride: boolean;
  divergent: boolean;
  fetchedAt: string | null;
  override: { source: string } | null;
}

/** Vendor estimate / forward fields — show an "E" badge. */
export const ESTIMATE_FIELDS = new Set([
  "forwardPe",
  "forwardPeg",
  "analystTargetPrice",
]);

/** Scoring metric keys (fundamentals-db / FUNDAMENTAL_METRIC_META) → provenance tfCol. */
export const SCORE_KEY_TO_PROV: Record<string, string> = {
  grossMargin: "grossMargin",
  operatingMargin: "operatingMargin",
  netMargin: "netMargin",
  roe: "returnOnEquity",
  roicWacc: "roic",
  revGrowth: "revenueGrowthYoY",
  epsGrowth: "epsGrowth",
  currentRatio: "currentRatio",
  debtToEquity: "debtToEquity",
};

export type FreshnessBand = "fresh" | "ok" | "stale" | "unknown";

function ageLabel(ts: string | null): string {
  if (!ts) return "never";
  const d = new Date(ts);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function freshnessBand(fetchedAt: string | null | undefined): FreshnessBand {
  if (!fetchedAt) return "unknown";
  const days = (Date.now() - new Date(fetchedAt).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return "unknown";
  if (days <= 7) return "fresh";
  if (days <= 30) return "ok";
  return "stale";
}

export function freshnessDotClass(band: FreshnessBand): string {
  switch (band) {
    case "fresh": return "bg-emerald-400";
    case "ok": return "bg-amber-400";
    case "stale": return "bg-orange-500";
    default: return "bg-zinc-500";
  }
}

export function provFieldForScoreKey(scoreKey: string): string | undefined {
  return SCORE_KEY_TO_PROV[scoreKey];
}

/** Strip " p72" percentile suffix from breakdown top-metric labels before lookup. */
export function scoreKeyFromTopMetricLabel(label: string): string {
  return label.replace(/\s+p\d+\s*$/, "").trim();
}

export function formatProvenanceTip(fp: ProvTipField | undefined | null): string | undefined {
  if (!fp) return undefined;
  const parts: string[] = [];
  const src = fp.isOverride && fp.override
    ? `override←${fp.override.source}`
    : (fp.winningSource ?? "unknown source");
  parts.push(src);
  parts.push(`as of ${ageLabel(fp.fetchedAt)}`);
  if (fp.divergent) parts.push("sources disagree");
  if (fp.isOverride) parts.push("manual override");
  if (ESTIMATE_FIELDS.has(fp.field)) parts.push("estimate");
  return parts.join(" · ");
}

export function indexProvenance(fields: ProvTipField[] | undefined): Map<string, ProvTipField> {
  const m = new Map<string, ProvTipField>();
  if (!fields) return m;
  for (const f of fields) m.set(f.field, f);
  return m;
}
