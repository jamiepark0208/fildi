/** Response shaping for GET /api/indicators/scorecard: scorecard rows + registry meta, numerics as numbers. */
import type { IndicatorScorecardRow } from "@workspace/db";
import type { PairStat } from "./indicator-grading.js";

export type IndMeta = { id: string; label: string; version: number; title: string; source: { url: string; author: string }; timeframes: string[] };
export type ScorecardCell = {
  kind: string; tf: string; n: number; days: number | null;
  verdict: string; needMore: number | null;
  pWin: number | null; pWinLo: number | null; pWinHi: number | null; randomWinPct: number | null;
  bestStructure: string | null;
  structures: Record<string, PairStat> | null;
  oldHitPct: number | null; oldPlaceboHitPct: number | null;
  gradedThrough: string | null;
};
export type ScorecardIndicator = IndMeta & { graded: boolean; cells: ScorecardCell[] };

const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function shapeScorecard(rows: IndicatorScorecardRow[], metas: IndMeta[]): ScorecardIndicator[] {
  return metas.map((m) => {
    const cells = rows
      .filter((r) => r.indicatorId === m.id && r.version === m.version)
      .map((r): ScorecardCell => ({
        kind: r.kind, tf: r.tf, n: r.n, days: r.days ?? null,
        verdict: r.verdict, needMore: r.needMore ?? null,
        pWin: num(r.pWin), pWinLo: num(r.pWinLo), pWinHi: num(r.pWinHi), randomWinPct: num(r.randomWinPct),
        bestStructure: r.bestStructure ?? null,
        structures: (r.structures as Record<string, PairStat> | null) ?? null,
        oldHitPct: num(r.hitPct), oldPlaceboHitPct: num(r.placeboHitPct),
        gradedThrough: r.gradedThrough ? new Date(r.gradedThrough).toISOString() : null,
      }))
      .sort((a, b) => (a.kind === "ALL" ? -1 : 0) - (b.kind === "ALL" ? -1 : 0) || a.kind.localeCompare(b.kind) || (a.tf === "ALL" ? -1 : 0) - (b.tf === "ALL" ? -1 : 0) || a.tf.localeCompare(b.tf));
    return { ...m, graded: cells.length > 0, cells };
  });
}
