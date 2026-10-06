/**
 * Shared peer-relative formatting for WRDS/LSEG research cards + report Peer tab.
 */

export type RelMetric = {
  value: number | null;
  peerMedian: number | null;
  peerPct: number | null;
  n: number;
  deltaVsMedian: number | null;
};

export type PeerLeader = { ticker: string; value: number };

export type PeerRelativeBlock = {
  groupId: string | null;
  groupName: string | null;
  sector: string | null;
  peerCount: number;
  sampleN: number;
  metrics: Record<string, RelMetric>;
  leaders: PeerLeader[];
  note: string;
};

export type RelChip = {
  label: string;
  value: string;
  /** Plain-language relative context under the value. */
  hint?: string;
  tone?: "good" | "bad" | "neutral" | "warn";
};

function pctLabel(pct: number | null): string | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  return `p${Math.round(pct)}`;
}

function deltaLabel(d: number | null, dDigits = 2, asPct = false): string | null {
  if (d == null || !Number.isFinite(d)) return null;
  if (asPct) return `${d > 0 ? "+" : ""}${d.toFixed(1)}pp vs med`;
  return `${d > 0 ? "+" : ""}${d.toFixed(dDigits)} vs med`;
}

/** Higher-is-better relative tone (breadth, SUE, ranks, pred surprise). */
export function relTone(pct: number | null, invert = false): "good" | "bad" | "neutral" {
  if (pct == null) return "neutral";
  const p = invert ? 100 - pct : pct;
  if (p >= 65) return "good";
  if (p <= 35) return "bad";
  return "neutral";
}

export function fmtRelHint(m: RelMetric | undefined, opts?: { asPctPoints?: boolean; digits?: number }): string | undefined {
  if (!m || m.peerPct == null) return undefined;
  const bits = [pctLabel(m.peerPct)];
  const d = deltaLabel(m.deltaVsMedian, opts?.digits ?? 2, opts?.asPctPoints);
  if (d) bits.push(d);
  if (m.n > 0) bits.push(`n=${m.n}`);
  return bits.join(" · ");
}

export function peerGroupLabel(peers: PeerRelativeBlock | null | undefined): string | null {
  if (!peers?.groupName && !peers?.groupId) return null;
  const name = peers.groupName ?? peers.groupId ?? "peers";
  return `${name} · ${peers.sampleN}/${peers.peerCount} with data`;
}

/** Compact how-to line for absolute + relative read. */
export function peerHowToUse(peers: PeerRelativeBlock | null | undefined, lane: "wrds" | "lseg"): string {
  if (!peers?.peerCount) {
    return lane === "wrds"
      ? "Abs only: breadth ≥0.08 / SUE ≥0.5 = supportive. No peer group mapped."
      : "Abs only: StarMine ranks 70+/30−. No peer group mapped.";
  }
  return lane === "wrds"
    ? "Read percentile vs sector peers (p70+ = strong in group). FY1 $ is share-basis — use Δ% / breadth / SUE, not the dollar level."
    : "Percentile vs taxonomy peers. Ranks already 1–100 universe-scaled; peer % tells you if you’re strong inside the sector cohort.";
}
