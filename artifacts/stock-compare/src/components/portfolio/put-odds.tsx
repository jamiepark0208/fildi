/**
 * Portfolio › Open puts · odds (Claude, user 2026-10-15). Per open short put: chance of assignment and, if assigned, chance the
 * stock gets back to the strike. Data: GET /api/pm/odds (book refreshed every 15 min by pm_alerts; closed-form odds; no new fetches).
 */
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";

type Row = {
  ticker: string; account: string; strike: number; expiry: string; qty: number; spot: number | null; days_left: number;
  pAssign: number | null; backToStrike20d: number | null; atStrike20d: number | null; drop5?: number;
  hist: { n: number; med: number; up: number } | null;
};

/** A117 — American early-assignment risk: deep ITM short put with ≤21d left (display heuristic). */
function earlyAssignRisk(r: Row): "high" | "watch" | null {
  if (r.spot == null || r.spot <= 0 || r.strike <= 0) return null;
  const itmPct = (r.strike - r.spot) / r.spot;
  if (itmPct < 0.03) return null;
  if (itmPct >= 0.08 && r.days_left <= 14) return "high";
  if (itmPct >= 0.05 && r.days_left <= 21) return "watch";
  if (itmPct >= 0.10) return "watch";
  return null;
}
const pct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)}%`);
const tone = (x: number | null, hi: boolean) => (x == null ? "text-amber-100/70" : (hi ? x >= 0.6 : x < 0.4) ? "text-emerald-300" : (hi ? x < 0.4 : x >= 0.6) ? "text-red-300" : "text-white");

export function PutOdds() {
  const { data } = useQuery({
    queryKey: ["pm-odds"],
    queryFn: async (): Promise<{ pricedAt: string | null; positions: Row[]; regime?: { spyBelow200: boolean; recovered: number; base: number } | null }> => {
      const r = await fetch("/api/pm/odds", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 5 * 60_000,
  });
  const rows = [...(data?.positions ?? [])].sort((a, b) => a.expiry.localeCompare(b.expiry) || (b.pAssign ?? 0) - (a.pAssign ?? 0));
  if (!rows.length) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-widest text-[#d4af37]">Open puts · odds</span>
        <span className="text-[11px] text-amber-100/80">priced {data?.pricedAt ? new Date(data.pricedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—"}</span>
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild><button type="button" className="ml-auto text-amber-100/70 hover:text-white"><Info className="w-3.5 h-3.5" /></button></TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[340px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
            Assigned = chance the put finishes in the money (today's implied vol). If assigned, over the next 20 trading days:
            "touches strike" = chance the stock trades back up to your strike at least once (a chance to sell a call there);
            "at strike d20" = chance it's at or above the strike on day 20. Both assume no drift. "After drops like this" = this
            stock's own history after a 5-day fall at least as deep as now: share of times it was higher 20 days later, and the median move.
            History says reversals after assignment are roughly a coin flip (study S015), so treat these as odds, not signals.
          </TooltipContent>
        </Tooltip>
      </div>
      {data?.regime?.spyBelow200 && (
        <div className="text-[12px] text-amber-200">
          Market in a downtrend: drops like these got back to the pre-drop price {Math.round(data.regime.recovered * 100)}% of the time within 20 days (vs {Math.round(data.regime.base * 100)}% normally) — S025
        </div>
      )}
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left")}>Put</th><th className={cn(GRID_TH, "text-left")}>Acct</th>
            <th className={cn(GRID_TH, "text-right")}>Spot</th><th className={cn(GRID_TH, "text-right")}>Assigned</th>
            <th className={cn(GRID_TH, "text-right")}>Early assign</th>
            <th className={cn(GRID_TH, "text-right")}>Touches strike ≤20d</th><th className={cn(GRID_TH, "text-right")}>At strike d20</th>
            <th className={cn(GRID_TH, "text-right")}>After drops like this</th>
          </tr></thead>
          <tbody>{rows.map((r, i) => {
            const early = earlyAssignRisk(r);
            return (
            <tr key={`${r.account}-${r.ticker}-${r.strike}-${r.expiry}`} className={gridRow(i)}>
              <td className={cn(GRID_TD, "text-white font-semibold whitespace-nowrap")}>{r.ticker} {r.strike}P <span className="font-normal text-amber-100/80">{r.expiry.slice(5)}{r.qty > 1 ? ` ×${r.qty}` : ""}</span></td>
              <td className={cn(GRID_TD, "text-amber-100")}>{r.account}</td>
              <td className={cn(GRID_TD, "text-right text-white/80")}>{r.spot?.toFixed(2) ?? "—"}</td>
              <td className={cn(GRID_TD, "text-right font-semibold", tone(r.pAssign, false))}>{pct(r.pAssign)}</td>
              <td
                className={cn(
                  GRID_TD, "text-right text-[11px]",
                  early === "high" && "text-red-300 font-semibold",
                  early === "watch" && "text-amber-300",
                  !early && "text-white/30",
                )}
                title="Deep ITM short put near expiry — American early-assignment risk (heuristic, not advice)"
              >
                {early === "high" ? "high" : early === "watch" ? "watch" : "—"}
              </td>
              <td className={cn(GRID_TD, "text-right", tone(r.backToStrike20d, true))}>{pct(r.backToStrike20d)}</td>
              <td className={cn(GRID_TD, "text-right", tone(r.atStrike20d, true))}>{pct(r.atStrike20d)}</td>
              <td className={cn(GRID_TD, "text-right text-white/80 whitespace-nowrap")}>
                {r.hist ? <>up {pct(r.hist.up)} · {r.hist.med >= 0 ? "+" : ""}{Math.round(r.hist.med * 100)}% <span className="text-amber-100/70">n {r.hist.n}</span></> : "—"}
              </td>
            </tr>
            );
          })}</tbody>
        </table>
      </div>
    </div>
  );
}
