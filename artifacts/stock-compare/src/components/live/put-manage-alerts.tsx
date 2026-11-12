/**
 * Live › put management alerts from watchlist_sync.put_manage_daily (A280 / S103).
 * Display only — no order buttons.
 */
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import {
  PUT_MANAGE_METHOD,
  formatTakeAlert,
  optionsLines,
  partitionPutManage,
  fmtExpiryMd,
  type PutManageRow,
} from "./put-manage-format";

const OPT_TIPS = {
  net: "Net $ for the whole lot. Roll = new put sold at bid + 10 % of spread minus buy-back at ask − 23 % of spread. Hold = unrealized on the open put. Close = realized now. Assign = unrealized vs spot at strike − credit.",
  be: "Break-even = new strike − (credit already collected + roll net). Assign: strike − credit.",
  itm: "Black-Scholes P(spot < strike at expiry) from the chain IV, r = 0, no dividends.",
  touch: "≈ 2 × P(ITM), capped at 100 %.",
  ann: "Roll net ÷ strike, annualized over the extra days of risk. Assign row: spot vs cost basis.",
};

type PutManageResponse = { as_of: string | null; rows: PutManageRow[]; stale?: boolean; snapshot_id?: number | null };

export function PutManageAlerts() {
  const [holdsOpen, setHoldsOpen] = useState(false);
  const [optOpen, setOptOpen] = useState<Record<string, boolean>>({});
  const { data, isLoading, error } = useQuery({
    queryKey: ["put-manage"],
    queryFn: async (): Promise<PutManageResponse> => {
      const r = await fetch("/api/put-manage", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) {
    return <div className="text-[11px] text-amber-100 px-3 py-2">Loading put manage…</div>;
  }
  if (error) {
    return (
      <div className="text-[11px] text-red-300/80 px-3 py-2">
        Put manage unavailable ({String((error as Error).message)}).
      </div>
    );
  }
  const rows = data?.rows ?? [];
  if (!rows.length) return null;

  const { takes } = partitionPutManage(rows);
  const asOf = data?.as_of;

  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-3 space-y-2 mx-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-white bg-zinc-800 px-1.5 py-0.5 rounded">
          Put manage
        </span>
        {asOf && (
          <span className="text-[10px] text-amber-100 font-mono tabular-nums">
            {asOf.slice(5).replace("-", "/")}
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-amber-200/50 hover:text-amber-100" aria-label="Method">
              <Info className="w-3 h-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="left"
            className="max-w-[340px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug"
          >
            {PUT_MANAGE_METHOD}
          </TooltipContent>
        </Tooltip>
      </div>

      {data?.stale && (
        <div className="text-[10px] text-amber-300">
          Newer portfolio import than this advice (snapshot {data.snapshot_id}) — refreshing; closed or new puts may be missing.
        </div>
      )}

      {takes.length > 0 && (
        <ul className="space-y-1.5">
          {takes.map((r) => {
            const line = formatTakeAlert(r);
            if (!line) return null;
            return (
              <li
                key={`take-${r.ticker}-${r.strike}-${r.expiry}`}
                className="flex gap-2 text-[12px] leading-snug text-amber-100"
              >
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                <span>{line}</span>
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <button
          type="button"
          onClick={() => setHoldsOpen((o) => !o)}
          className="flex items-center gap-1 text-[11px] text-amber-100 hover:text-white"
          data-testid="put-manage-toggle"
        >
          {holdsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Open puts ({rows.length})
        </button>
        {holdsOpen && (
          <div className={cn(GRID_WRAP, "mt-1.5")}>
            <table className="w-full border-collapse">
              <thead>
                <tr className={GRID_HEADER}>
                  <th className={cn(GRID_TH, "text-left")}>Put</th>
                  <th className={cn(GRID_TH, "text-right")}>Cap %</th>
                  <th className={cn(GRID_TH, "text-right")}>Pace</th>
                  <th className={cn(GRID_TH, "text-left")}>Why</th>
                  <th className={cn(GRID_TH, "text-left")}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const key = `${r.ticker}-${r.strike}-${r.expiry}`;
                  const lines = optionsLines(r);
                  const open = !!optOpen[key];
                  return (
                    <Fragment key={key}>
                      <tr className={gridRow(i)} data-testid="put-row">
                        <td className={cn(GRID_TD, "text-white")}>
                          <button
                            type="button"
                            className="inline-flex items-center gap-0.5 hover:text-[#d4af37]"
                            onClick={() => setOptOpen((o) => ({ ...o, [key]: !o[key] }))}
                            aria-expanded={open}
                            data-testid="put-options-toggle"
                          >
                            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            {r.ticker} {Number(r.strike)}p {fmtExpiryMd(r.expiry)}
                          </button>
                        </td>
                        <td className={cn(GRID_TD, "text-right text-amber-50")}>
                          {Number.isFinite(r.captured_pct) ? r.captured_pct.toFixed(1) : "—"}
                        </td>
                        <td className={cn(GRID_TD, "text-right text-amber-50")}>
                          {Number.isFinite(r.pace) ? `${r.pace.toFixed(2)}×` : "—"}
                        </td>
                        <td className={cn(GRID_TD, "text-left text-amber-100 max-w-[220px]")}>{r.why ?? "—"}</td>
                        <td className={cn(GRID_TD, "text-left text-amber-100 max-w-[180px]")}>
                          {r.notes?.length ? r.notes.join(" · ") : "—"}
                        </td>
                      </tr>
                      {open && (
                        <tr data-testid="put-options-row">
                          <td colSpan={5} className="pb-2 pl-4">
                            {lines.length === 0 ? (
                              <span className="text-[11px] text-amber-100">Options: {r.rolls_note ?? "no chain"}</span>
                            ) : (
                              <table className="border-collapse">
                                <thead>
                                  <tr className={GRID_HEADER}>
                                    <th className={cn(GRID_TH, "text-left")}>Option</th>
                                    <th className={cn(GRID_TH, "text-right")}><DataTip tip={OPT_TIPS.net}>Net $</DataTip></th>
                                    <th className={cn(GRID_TH, "text-left")}>Put</th>
                                    <th className={cn(GRID_TH, "text-right")}><DataTip tip={OPT_TIPS.be}>B/E</DataTip></th>
                                    <th className={cn(GRID_TH, "text-right")}><DataTip tip={OPT_TIPS.itm}>P(ITM)</DataTip></th>
                                    <th className={cn(GRID_TH, "text-right")}><DataTip tip={OPT_TIPS.touch}>P(touch)</DataTip></th>
                                    <th className={cn(GRID_TH, "text-right")}><DataTip tip={OPT_TIPS.ann}>Ann.</DataTip></th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {lines.map((l, j) => (
                                    <tr key={l.label + j} className={gridRow(j)}>
                                      <td className={cn(GRID_TD, "text-left")}>{l.label}</td>
                                      <td className={cn(GRID_TD, "text-right")}>{l.net}</td>
                                      <td className={cn(GRID_TD, "text-left")}>{l.newPut}</td>
                                      <td className={cn(GRID_TD, "text-right")}>{l.breakeven}</td>
                                      <td className={cn(GRID_TD, "text-right")}>{l.pItm}</td>
                                      <td className={cn(GRID_TD, "text-right")}>{l.pTouch}</td>
                                      <td className={cn(GRID_TD, "text-right")}>{l.ann}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
