import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";

export type ModelListWinRate = {
  rate: number; lo: number; hi: number; n: number; delta: number; dte: number;
  /** contract is off the tested grid (Δ 0.15–0.30, 7–30 days): the nearest cell is shown */
  outside: boolean; version: string;
  /** delta past the tested 0.15–0.30 range: rates extrapolated on the end segment (to 0.10 / 0.45) */
  extrapolated?: boolean;
  /** $ per contract = (fill − historical payout × ATM σ√T × strike) × 100, for the best / average / worst calendar year (2020→) */
  ev?: number; ev_good?: number; ev_bad?: number;
  /** what-if: same expiry at the other tested deltas (strike + premium are Black-Scholes estimates scaled from the real fill) */
  alts?: { delta: number; strike: number; premium: number; rate: number; ev: number; ev_bad: number; ev_good: number }[];
};

/** One ticker in a Model List folder (watchlist_sync.model_items, latest run). */
export type ModelListItem = {
  ticker: string;
  rank: number;
  /** Judgment, independent of holding: green | yellow | red | purple | "" */
  verdict: string;
  /** held | etf | null */
  role: string | null;
  /** ok | provisional (re-verify in session) | review (held back) | warn (kept, but breaches a soft portfolio limit) */
  status: string;
  score: number | null;
  pillars: {
    own: number | null; street: number | null; premium: number | null; fit: number | null; edge: number | null;
    /** close vs 200-day average (0.08 = 8% above): the trend part of the stock score that passed gate 1 */
    ma200?: number | null;
    /** set when `premium` was re-scored on the contract's own IV (expires before earnings inside the 30-day window; fit-1.4.2 P2) */
    premium_30d?: number | null;
  } | null;
  flags: string[];
  why: string[];
  contract: {
    type: string; strike: number; expiry: string; premium: number | null; account: string | null; verify_status: string;
    /** set by the portfolio layer (Step 7) for sized ideas */
    contracts?: number; collateral?: number;
    /** "Wins historically": share of 2020→ reconstructed trades at this delta / expiry that made money (watchlist_sync.win_rates) */
    win?: ModelListWinRate;
    /** Fildi's modelled premium when `premium` holds the realistic Robinhood fill */
    model_premium?: number | null;
    /** this contract's IV and the 30-day ATM IV vs 20-day realized vol (> 1 = options priced above recent moves) */
    vol?: { contract_iv: number; atm30_iv: number | null; rv20: number; contract_iv_rv: number; atm30_iv_rv: number | null };
    earnings?: { date: string; inside: boolean; days_after_expiry: number };
    /** the user's Robinhood realized closes on this ticker + side since 2025 (descriptive, small n) */
    record?: { n: number; wins: number; pnl: number; since: string };
    /** blended fair value vs this strike (display only; from fair_value_snapshots) */
    fair_value?: {
      value: number;
      /** strike/fair − 1 (put below fair → negative = cushion vs reference) */
      strike_vs_fair: number;
      confidence?: string | null;
      value_trap?: boolean;
      cyclical?: boolean;
    };
  } | null;
  /** every adjustment applied to this item: what changed, from → to, and why (watchlist_sync.model_items.adjustments) */
  adjustments?: { what: string; from: number | string; to: number | string; why: string }[];
  isNew: boolean;
  close: number | null;
  prevClose: number | null;
  closeDate: string | null;
};

export type ModelListFolder = {
  key: string;
  name: string;
  description: string;
  kind: "action" | "verdict" | "review";
  items: ModelListItem[];
  removed: string[];
};

/** Freshness of everything behind the Model List (GET /api/watchlist/model → health). */
export type ModelListHealth = {
  champion?: string | null; challengers?: number; plan_status?: string | null; quotes_at?: string | null; snapshot_at?: string | null;
  lseg_history_date?: string | null; lseg_signals_date?: string | null;
  /** SPY max date in prices_historical (benchmark). */
  prices_date?: string | null;
  /** Max date across all tickers — catches SPY lagging while names were LSEG-filled. */
  prices_universe_date?: string | null;
  grades?: number;
  last_graded_at?: string | null; split_repairs?: number;
};

export type ModelList = {
  run: { id: number; createdAt: string; modelVersion: string; planId: number | null; fitRunAt: string | null; prevRunId: number | null } | null;
  health?: ModelListHealth;
  folders: ModelListFolder[];
};

/** Verdict → tag color; matches PRESET_COLORS in use-watchlist.ts. */
export const VERDICT_COLORS: Record<string, string> = {
  green: "#22c55e",
  yellow: "#eab308",
  red: "#ef4444",
  purple: "#a855f7",
};

export const VERDICT_LABELS: Record<string, string> = {
  green: "Own: would happily hold",
  yellow: "Income: wheel target",
  red: "Avoid: risk flags",
  purple: "Market context (ETF)",
  "": "Watch-only: nothing stands out",
};

export function useModelList() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["watchlist-model", user?.id],
    queryFn: async (): Promise<ModelList> => {
      const res = await fetch("/api/watchlist/model", { credentials: "include" });
      if (!res.ok) throw new Error("model list fetch failed");
      return res.json();
    },
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
  });
}
