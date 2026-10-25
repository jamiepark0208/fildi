/**
 * A256 — side-specific IV distributions for ivAbsolute.
 * Puts rank vs put IVs; calls vs call IVs (never mix).
 */

export function collectSideIVsFromChains(
  chains: Iterable<{ puts: { iv: number }[]; calls: { iv: number }[] }>,
  isCall: boolean,
): number[] {
  const out: number[] = [];
  for (const c of chains) {
    for (const row of isCall ? c.calls : c.puts) {
      if (row.iv > 0) out.push(row.iv);
    }
  }
  return out;
}

export function collectSideIVsFromChainMap(
  chainsByTicker: Iterable<Iterable<{ puts: { iv: number }[]; calls: { iv: number }[] }>>,
  isCall: boolean,
): number[] {
  const out: number[] = [];
  for (const chains of chainsByTicker) {
    out.push(...collectSideIVsFromChains(chains, isCall));
  }
  return out;
}

/** Marker stored on option_score_snapshots.component_scores when watchlist second-pass. */
export const RELAXED_COMPONENT = { score: 1, weight: 0 } as const;

export function isRelaxedComponentScores(
  cs: Record<string, unknown> | null | undefined,
): boolean {
  if (!cs || typeof cs !== "object") return false;
  const r = cs.relaxed;
  if (r === true) return true;
  if (r && typeof r === "object" && r !== null && "score" in r) {
    const s = Number((r as { score: unknown }).score);
    return Number.isFinite(s) && s > 0;
  }
  return false;
}
