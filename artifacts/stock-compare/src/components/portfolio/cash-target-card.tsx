/**
 * A372 § 4 — one market-wide cash/put-collateral target (same for every account) + per-account moves to reach it.
 * Data: GET /api/pm/book → book.cash_target + accounts.*.accounting / .rebalance (pm_book.py, cash_target.py, rebalance.py).
 * Summary grid reuses the Breakdown › Main metrics table; moves use CashTargetMovesTable (A399 ≤150-line cap).
 */
import { useQuery } from "@tanstack/react-query";
import { BreakdownMetricsTable, type MetricGroup } from "@/components/breakdown-metrics-table";
import { cn } from "@/lib/utils";
import { CashTargetHistory, type CashHistory } from "./cash-target-history";
import { CashTargetMovesTable, type CashTargetStep } from "./cash-target-moves-table";

type CashTarget = {
  as_of: string; policy_version: string; target: number; lo: number; hi: number;
  regime: string; direction: string; reasons: string[];
};
type Accounting = {
  E: number | null; C: number | null; D: number | null; P: number; F: number | null;
  F_status: "reconciled" | "unknown" | "none"; F_bounds: [number | null, number | null] | null;
  cash_of_nlv: number | null; notes: string[];
};
type Rebalance = {
  target: number; basis: string; free_now: number; mix_now: number | null; gap: number; direction: string;
  steps: CashTargetStep[]; mix_after: number | null; gap_after: number; note: string | null; small_allocation: boolean;
};
type Book = {
  snapshot_at?: string;
  cash_target?: CashTarget | null;
  cash_history?: CashHistory | null;
  accounts: Record<string, { accounting?: Accounting; rebalance?: Rebalance }>;
};

const money = (v: number | null | undefined) =>
  v == null ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);
const mdy = (iso?: string) => {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
};
const REGIME: Record<string, string> = {
  extended: "Extended rally", normal: "Normal", downtrend: "Below 200-day", pullback: "Pullback", selloff: "Large selloff", stress: "Disorderly stress",
};

function freeCash(a?: Accounting): string {
  if (!a) return "—";
  if (a.F_status === "reconciled") return money(a.F);
  if (a.F_status === "none") return "none (debt)";
  const b = a.F_bounds;
  return b ? `${money(b[0])}–${money(b[1])}` : "unknown";
}

export function CashTargetCard({ className }: { className?: string }) {
  const { data, isError } = useQuery<{ book: Book | null }>({
    queryKey: ["pm-book"],
    queryFn: async () => {
      const r = await fetch("/api/pm/book", { credentials: "include" });
      if (r.status === 404) return { book: null };
      if (!r.ok) throw new Error("pm book");
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const book = data?.book ?? null;
  const t = book?.cash_target ?? null;
  if (isError || !book) return null;
  if (!t) {
    return <div className={cn("text-[11px] text-white px-1", className)}>Cash target not computed yet (daily › cash target).</div>;
  }
  const names = Object.keys(book.accounts).filter((n) => book.accounts[n].rebalance);

  const groups: MetricGroup[] = [
    {
      title: "Market target",
      score: null,
      rows: [
        { label: "Cash share", value: `${pct(t.target)} (${pct(t.lo)}–${pct(t.hi)})`,
          tip: "Cash ÷ (cash + short-put collateral). One market-wide number for every account — holdings, balances and debt never change it." },
        { label: "Regime", value: REGIME[t.regime] ?? t.regime, tip: t.reasons.join(" · ") },
        { label: "Direction", value: t.direction, tip: "Moves at most 5 points a day toward the regime level (no whipsaw)." },
        { label: "As of", value: mdy(t.as_of), tip: "Market data date (S&P 500, VIX, BAA credit spread)." },
        { label: "Policy", value: t.policy_version,
          tip: "Preference policy (Jamie: rebuild cash in rallies, deploy part after a large selloff, keep a reserve in disorderly stress). Not a calibrated optimum — A372 § 6 not run (≈ 9 regime episodes < 30)." },
      ],
    },
    ...names.slice(0, 3).map((n): MetricGroup => {
      const a = book.accounts[n].accounting;
      const r = book.accounts[n].rebalance!;
      return {
        title: n,
        score: null,
        rows: [
          { label: "Cash", value: money(a?.C), good: a?.C != null ? a.C >= 0 : undefined,
            tip: `Broker cash ledger (negative = margin debt). ${pct(a?.cash_of_nlv)} of the account (${money(a?.E)}).` },
          { label: "Put coll.", value: money(a?.P), tip: "Σ strike × 100 × contracts of open short puts (cost if all assigned)." },
          { label: "Free cash", value: freeCash(a), tip: (a?.notes ?? []).join(" · ") || "Cash after put collateral and holds; reconciles with the broker." },
          { label: "Mix now", value: pct(r.mix_now), good: r.mix_now != null ? Math.abs(r.mix_now - r.target) <= 0.05 : undefined,
            tip: `Actual cash share on ${r.basis}. — when cash is negative (no reserve to share).` },
          { label: "Gap", value: r.direction === "on target" ? "on target" : `${r.direction} ${money(Math.abs(r.gap))}`,
            good: r.direction === "on target" ? true : undefined,
            tip: "Cash to add (or deploy) so cash ÷ (cash + put collateral) = target at today's puts." },
        ],
      };
    }),
  ];
  if (groups.length < 4) {
    groups.push({
      title: "After moves",
      score: null,
      rows: names.slice(0, 2).flatMap((n) => {
        const r = book.accounts[n].rebalance!;
        return [
          { label: `${n} mix`, value: pct(r.mix_after), tip: "Cash share once every listed move is done." },
          { label: `${n} left`, value: r.gap_after > 25 ? `short ${money(r.gap_after)}` : r.gap_after < -25 ? `${money(-r.gap_after)} idle` : "on target",
            good: Math.abs(r.gap_after) <= 25 ? true : undefined, tip: `${r.steps.length} move(s).` },
        ];
      }),
    });
  }

  const steps = names.flatMap((n) => (book.accounts[n].rebalance?.steps ?? []).map((s) => ({ ...s, account: n })));
  const notes = names.flatMap((n) => {
    const r = book.accounts[n].rebalance!;
    return [
      r.note ? `${n}: ${r.note}` : null,
      r.small_allocation ? `${n}: cash + put collateral is under 5 % of the account — the mix says little about the account's reserve.` : null,
    ].filter(Boolean) as string[];
  });

  return (
    <div className={cn("space-y-1.5", className)} id="pf-cash-target">
      <div className="text-[10px] font-bold uppercase tracking-wider text-white px-0.5">
        Cash vs put collateral · market target → how to get there
      </div>
      <BreakdownMetricsTable groups={groups} hideEmptyScore />
      <CashTargetHistory h={book.cash_history} />
      <CashTargetMovesTable steps={steps} />
      {notes.length > 0 && (
        <ul className="text-[10px] text-white px-1 space-y-0.5">
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      <div className="text-[9px] text-white/90 px-1">
        Advisory · stock at snapshot price {mdy(book.snapshot_at)} · shares behind short calls are not sold · margin-loan account gets no new puts.
      </div>
    </div>
  );
}
