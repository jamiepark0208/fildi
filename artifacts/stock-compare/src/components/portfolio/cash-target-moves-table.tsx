/**
 * A399 split from cash-target-card.tsx — per-account rebalance steps table (GRID_*).
 */
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";
import { cn } from "@/lib/utils";

export type CashTargetStep = {
  action: string;
  what: string;
  qty: number;
  cash: number;
  collateral: number;
  mix_after: number | null;
  gap_after: number;
  why: string;
};

const signed = (v: number) =>
  Math.abs(v) < 0.5 ? "$0" : `${v > 0 ? "+" : "−"}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`);

export function CashTargetMovesTable({ steps }: { steps: Array<CashTargetStep & { account: string }> }) {
  if (steps.length === 0) return null;
  return (
    <div className={GRID_WRAP}>
      <table className="w-full border-collapse">
        <thead>
          <tr className={GRID_HEADER}>
            {["Acct", "Move", "What", "Qty", "Cash", "Collateral", "Mix after", "Why"].map((h, i) => (
              <th key={h} className={cn(GRID_TH, i >= 3 && i <= 6 ? "text-right" : "text-left")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={`${s.account}-${s.what}-${i}`} className={gridRow(i)}>
              <td className={GRID_TD}>{s.account}</td>
              <td className={cn(GRID_TD, "font-semibold", s.action === "sell put" ? "text-emerald-300" : "text-amber-100")}>{s.action}</td>
              <td className={GRID_TD}>{s.what.replace(/(\d{4})-(\d{2})-(\d{2})/, (_m, y, mo, d) => `${Number(mo)}/${Number(d)}/${y.slice(2)}`)}</td>
              <td className={cn(GRID_TD, "text-right")}>{s.qty.toLocaleString()}</td>
              <td className={cn(GRID_TD, "text-right")}>{signed(s.cash)}</td>
              <td className={cn(GRID_TD, "text-right")}>{s.collateral ? signed(s.collateral) : "—"}</td>
              <td className={cn(GRID_TD, "text-right")}>{pct(s.mix_after)}</td>
              <td className={cn(GRID_TD, "text-amber-50")}>{s.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
