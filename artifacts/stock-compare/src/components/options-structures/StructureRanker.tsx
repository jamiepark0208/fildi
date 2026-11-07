/**
 * A192 Part L — view × horizon × max loss ranker (model estimate).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";

const VIEWS = [
  { id: "bull", label: "Bull" },
  { id: "bear", label: "Bear" },
  { id: "neutral", label: "Neutral" },
  { id: "vol_up", label: "Vol ↑" },
  { id: "vol_down", label: "Vol ↓" },
] as const;

type RankRow = {
  id: string;
  name: string;
  netFill: number;
  expectedPnl: number;
  pnlPerBp: number;
  pop: number;
  maxLoss: number;
  buyingPower: number;
  evidence: { label: string; tone: string } | null;
  label: string;
};

export function StructureRanker() {
  const [ticker, setTicker] = useState("AAPL");
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("neutral");
  const [horizon, setHorizon] = useState(30);
  const [maxLoss, setMaxLoss] = useState(1000);

  const q = useQuery({
    queryKey: ["structures-rank", ticker, view, horizon, maxLoss],
    queryFn: async () => {
      const p = new URLSearchParams({ view, horizon: String(horizon), maxLoss: String(maxLoss) });
      const r = await fetch(
        `/api/options/${encodeURIComponent(ticker)}/structures/rank?${p}`,
        { credentials: "include" },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "rank failed");
      return r.json() as Promise<{ rows: RankRow[]; label: string; spot: number }>;
    },
    staleTime: 60_000,
  });

  return (
    <div className="space-y-2 text-xs">
      <p className="text-yellow-300/90">{q.data?.label ?? "model estimate — not backtested"}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-amber-100">Ticker</span>
          <input
            className="w-20 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-white font-mono"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-amber-100">View</span>
          <select
            className="bg-zinc-900 text-white border border-zinc-700 rounded"
            value={view}
            onChange={(e) => setView(e.target.value as typeof view)}
          >
            {VIEWS.map((v) => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-amber-100">Horizon (d)</span>
          <input
            type="number"
            className="w-16 bg-zinc-900 text-white font-mono border border-zinc-700 rounded px-1"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value) || 30)}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-amber-100">Max loss $</span>
          <input
            type="number"
            className="w-20 bg-zinc-900 text-white font-mono border border-zinc-700 rounded px-1"
            value={maxLoss}
            onChange={(e) => setMaxLoss(Number(e.target.value) || 1000)}
          />
        </label>
      </div>

      {q.isLoading ? <p className="text-amber-100">Loading…</p> : null}
      {q.isError ? <p className="text-red-300">{(q.error as Error).message}</p> : null}

      {q.data?.rows?.length ? (
        <div className={cn(GRID_WRAP, "overflow-x-auto")}>
          <table className="w-full border-collapse min-w-[640px]">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left")}>Structure</th>
                <th className={cn(GRID_TH, "text-right")}>
                  <DataTip tip="Monte Carlo expected P&L at horizon ÷ buying power. Not a backtest.">E[$/BP]</DataTip>
                </th>
                <th className={cn(GRID_TH, "text-right")}>Fill</th>
                <th className={cn(GRID_TH, "text-right")}>POP</th>
                <th className={cn(GRID_TH, "text-right")}>Max loss</th>
                <th className={cn(GRID_TH, "text-left")}>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((row, i) => (
                <tr key={row.id} className={gridRow(i)}>
                  <td className={cn(GRID_TD, "text-white font-semibold")}>{row.name}</td>
                  <td className={cn(GRID_TD, "text-right font-mono tabular-nums", row.pnlPerBp >= 0 ? "text-emerald-300" : "text-red-300")}>
                    {row.pnlPerBp.toFixed(4)}
                  </td>
                  <td className={cn(GRID_TD, "text-right font-mono")}>{row.netFill.toFixed(2)}</td>
                  <td className={cn(GRID_TD, "text-right font-mono")}>{(row.pop * 100).toFixed(0)}%</td>
                  <td className={cn(GRID_TD, "text-right font-mono")}>{row.maxLoss.toFixed(0)}</td>
                  <td className={cn(GRID_TD, "text-amber-100")}>
                    {row.evidence ? (
                      <DataTip tip={row.evidence.label}>
                        <span className="uppercase text-[9px]">{row.evidence.tone}</span>
                      </DataTip>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : q.data ? (
        <p className="text-amber-100">No structures under max loss with current chain.</p>
      ) : null}
    </div>
  );
}
