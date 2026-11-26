/** A419 / A192 V5 — payload types + helpers for the per-idea structure comparison (server lenses only, no client math). */
import { useQuery } from "@tanstack/react-query";
import { simpleOf } from "./structure-themes";

export type LensCash = { ret?: number | null; per_share?: number; why?: string };
export type LensFinite = { ret?: number | null; max_loss?: number; why?: string };
export type LensMatched = { ret?: number | null; ev_usd?: number; cash_usd?: number; units?: number; why?: string };
export type IdeaCandidate = {
  id: string;
  kind: "baseline" | "structure";
  expiry?: string | null;
  tier?: string | null;
  status?: string;
  fit?: boolean;
  eligible?: boolean;
  eligibility_why?: string;
  spec_hash?: string;
  lenses?: {
    p_win?: number | null;
    cash?: LensCash;
    finite_loss?: LensFinite;
    matched_downside?: LensMatched;
  };
};

export type IdeaContext = {
  status?: string;
  reason?: string;
  read?: string;
  lenses_agree?: boolean;
  best?: { cash?: string; finite_loss?: string; matched_downside?: string };
  candidates?: IdeaCandidate[];
  hypothetical_leaders?: Record<string, string>;
  lens_notes?: { cash?: string; finite_loss?: string; matched_downside?: string };
  decision_at?: string;
  holding_horizon_at?: string;
  capability_limits?: string[];
  dist?: { p05?: number; p50?: number; p95?: number };
  n_eff?: number;
  n_paths?: number;
};

export type IdeaResponse = { asOf: string; context: IdeaContext };

export const pct = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`;
export const usd0 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${v < 0 ? "-" : ""}$${Math.abs(Math.round(v)).toLocaleString()}`;

export const BASELINE_ORDER = ["no_trade", "cash", "stock"] as const;

export const HEADS: { key: string; label: string; tip: string; right?: boolean }[] = [
  { key: "structure", label: "Structure", tip: "Baseline or structure id — same 2y paths for every row." },
  { key: "expiry", label: "Expiry", tip: "Nearest leg expiry used for horizon marks." },
  { key: "cash", label: "Cash ret", right: true, tip: "Expected return ÷ cash tied up (per share basis on baselines)." },
  { key: "finite", label: "Max-loss ret", right: true, tip: "EV ÷ max loss when finite; otherwise why." },
  { key: "matched", label: "Matched $ EV", right: true, tip: "Units sized so worst 5% mean loss = $1,000 — expected P&L in dollars." },
  { key: "matched_cash", label: "Cash need", right: true, tip: "Capital required for the matched-downside size." },
  { key: "win", label: "Win %", right: true, tip: "Share of paths with positive total P&L at horizon." },
  { key: "tier", label: "Tier", tip: "Board tier when this structure was priced today." },
];

export function useIdeaStructures(ticker: string | null) {
  return useQuery({
    queryKey: ["options-structures-idea", ticker],
    queryFn: async (): Promise<IdeaResponse | { missing: true }> => {
      const r = await fetch(`/api/options/structures/idea/${ticker}`, { credentials: "include" });
      if (r.status === 404) return { missing: true };
      if (!r.ok) throw new Error("idea structures fetch failed");
      return r.json();
    },
    enabled: !!ticker,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function sortCandidates(rows: IdeaCandidate[]): IdeaCandidate[] {
  const baselines = BASELINE_ORDER.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as IdeaCandidate[];
  const rest = rows.filter((r) => r.kind !== "baseline").sort((a, b) => a.id.localeCompare(b.id));
  return [...baselines, ...rest];
}

export function lensBest(id: string, best: IdeaContext["best"], lens: "cash" | "finite_loss" | "matched_downside") {
  return best?.[lens] === id;
}

export function rowTip(c: IdeaCandidate): string | undefined {
  if (c.status === "model_limitation") return "Payoff only — not ranked against other structures.";
  if (c.eligible === false) return `Can't be picked: ${c.eligibility_why ?? "fails its check"}`;
  return simpleOf(c.id);
}

export const LENS_LABEL: Record<string, string> = { cash: "cash", finite_loss: "max loss", matched_downside: "same downside" };
export const TIER_LABEL: Record<string, string> = { not_on_board: "not picked" };
